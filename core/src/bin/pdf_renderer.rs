#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use image::{ImageBuffer, Rgba};
use pdfium_render::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::raw::c_int;
use std::path::Path;
use std::time::Instant;

// Pdfium ABI constants. The crate's bindgen module is private, but these values are
// stable public ABI (see pdfium's fpdfview.h).
const FLAG_ANNOT: c_int = 0x01;
const FLAG_REVERSE_BYTE_ORDER: c_int = 0x10;
const BITMAP_FORMAT_BGRA: c_int = 4;

#[derive(Serialize)]
struct PreviewOutput {
    page: u32,
    width: u32,
    height: u32,
    image_path: String,
}

#[derive(Serialize)]
struct DocumentMetaOutput {
    path: String,
    page_count: u32,
    pages: Vec<PageMetaOutput>,
}

#[derive(Serialize)]
struct PageMetaOutput {
    index: u32,
    width_pts: f64,
    height_pts: f64,
}

#[derive(Serialize)]
struct TileKeyOutput {
    page: u32,
    zoom_level: u8,
    tile_x: u32,
    tile_y: u32,
}

#[derive(Serialize)]
struct TileOutput {
    key: TileKeyOutput,
    x: u32,
    y: u32,
    generation: u64,
    page_load_ms: f64,
    render_ms: f64,
    encode_ms: f64,
}

#[derive(Clone, Copy)]
struct PathPoint {
    x: f64,
    y: f64,
    segment_type: PdfPathSegmentType,
    closes_path: bool,
}

fn init_pdfium(lib_path: &str) -> Pdfium {
    Pdfium::new(Pdfium::bind_to_library(lib_path).expect("Failed to load pdfium library"))
}

// Pdfium re-parses a page's content stream every time the page is re-opened, and
// re-reads the document structure every time the document is re-opened. Tile requests
// arrive in bursts against one page, so the tile hot path keeps documents and pages
// open across requests via raw Pdfium handles (the high-level PdfDocument/PdfPage
// wrappers borrow the Pdfium instance and cannot be stored alongside each other).
const MAX_CACHED_DOCS: usize = 2;
const MAX_CACHED_PAGES_PER_DOC: usize = 3;

struct DocEntry {
    /// Backing buffer for FPDF_LoadMemDocument64 — Pdfium reads from it lazily for the
    /// life of the document, so it must be kept alive until the document is closed.
    _bytes: Vec<u8>,
    doc: FPDF_DOCUMENT,
    /// Open page handles, most recently used last.
    pages: Vec<(u32, FPDF_PAGE)>,
    /// (file length, mtime) at load time; `refresh` invalidates on mismatch.
    fingerprint: (u64, Option<std::time::SystemTime>),
    last_used: u64,
}

struct DocCache<'a> {
    bindings: &'a dyn PdfiumLibraryBindings,
    docs: HashMap<String, DocEntry>,
    tick: u64,
}

impl<'a> DocCache<'a> {
    fn new(bindings: &'a dyn PdfiumLibraryBindings) -> Self {
        Self {
            bindings,
            docs: HashMap::new(),
            tick: 0,
        }
    }

    fn fingerprint_of(path: &str) -> (u64, Option<std::time::SystemTime>) {
        std::fs::metadata(path)
            .map(|meta| (meta.len(), meta.modified().ok()))
            .unwrap_or((0, None))
    }

    fn open(&mut self, path: &str) -> Result<FPDF_DOCUMENT, String> {
        self.tick += 1;
        let tick = self.tick;
        if let Some(entry) = self.docs.get_mut(path) {
            entry.last_used = tick;
            return Ok(entry.doc);
        }

        let bytes =
            std::fs::read(path).map_err(|e| format!("Failed to read PDF {path}: {e}"))?;
        let doc = self.bindings.FPDF_LoadMemDocument64(&bytes, None);
        if doc.is_null() {
            return Err(format!(
                "Failed to open PDF {path} (pdfium error {})",
                self.bindings.FPDF_GetLastError()
            ));
        }

        while self.docs.len() >= MAX_CACHED_DOCS {
            let oldest = self
                .docs
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone());
            let Some(key) = oldest else { break };
            self.remove(&key);
        }

        self.docs.insert(
            path.to_string(),
            DocEntry {
                _bytes: bytes,
                doc,
                pages: Vec::new(),
                fingerprint: Self::fingerprint_of(path),
                last_used: tick,
            },
        );
        Ok(doc)
    }

    fn page(&mut self, path: &str, page_index: u32) -> Result<FPDF_PAGE, String> {
        let doc = self.open(path)?;
        let bindings = self.bindings;
        let entry = self
            .docs
            .get_mut(path)
            .ok_or("Document missing from cache after open")?;

        if let Some(pos) = entry
            .pages
            .iter()
            .position(|(index, _)| *index == page_index)
        {
            let handle = entry.pages.remove(pos);
            entry.pages.push(handle);
            return Ok(entry.pages.last().unwrap().1);
        }

        let page = bindings.FPDF_LoadPage(doc, page_index as c_int);
        if page.is_null() {
            return Err(format!("Page {page_index} not found"));
        }
        while entry.pages.len() >= MAX_CACHED_PAGES_PER_DOC {
            let (_, old) = entry.pages.remove(0);
            bindings.FPDF_ClosePage(old);
        }
        entry.pages.push((page_index, page));
        Ok(page)
    }

    /// Drops the cache entry if the file on disk changed since it was loaded.
    /// Called from `meta` (the app's document-open signal) so a replaced drawing
    /// file is picked up without restarting the renderer.
    fn refresh(&mut self, path: &str) {
        let stale = self
            .docs
            .get(path)
            .is_some_and(|entry| entry.fingerprint != Self::fingerprint_of(path));
        if stale {
            self.remove(path);
        }
    }

    fn remove(&mut self, path: &str) {
        if let Some(entry) = self.docs.remove(path) {
            for (_, page) in &entry.pages {
                self.bindings.FPDF_ClosePage(*page);
            }
            self.bindings.FPDF_CloseDocument(entry.doc);
        }
    }

    fn close_all(&mut self) {
        let keys: Vec<String> = self.docs.keys().cloned().collect();
        for key in keys {
            self.remove(&key);
        }
    }
}

fn required_str(req: &serde_json::Value, field: &str) -> Result<String, String> {
    req[field]
        .as_str()
        .map(ToString::to_string)
        .ok_or_else(|| format!("missing or invalid field: {field}"))
}

fn required_u32(req: &serde_json::Value, field: &str) -> Result<u32, String> {
    let value = req[field]
        .as_u64()
        .ok_or_else(|| format!("missing or invalid field: {field}"))?;
    u32::try_from(value).map_err(|_| format!("field out of range: {field}"))
}

fn required_u64(req: &serde_json::Value, field: &str) -> Result<u64, String> {
    req[field]
        .as_u64()
        .ok_or_else(|| format!("missing or invalid field: {field}"))
}

fn required_f32(req: &serde_json::Value, field: &str) -> Result<f32, String> {
    req[field]
        .as_f64()
        .map(|value| value as f32)
        .ok_or_else(|| format!("missing or invalid field: {field}"))
}

fn load_meta(cache: &mut DocCache, pdf_path: &str) -> Result<DocumentMetaOutput, String> {
    // The app calls `meta` whenever a document is (re)opened, so this is the natural
    // point to detect a changed file on disk and drop the stale cache entry.
    cache.refresh(pdf_path);
    let doc = cache.open(pdf_path)?;
    let bindings = cache.bindings;

    let page_count = bindings.FPDF_GetPageCount(doc).max(0) as u32;
    let mut pages = Vec::with_capacity(page_count as usize);
    for index in 0..page_count {
        let mut size = FS_SIZEF {
            width: 0.0,
            height: 0.0,
        };
        if bindings.FPDF_GetPageSizeByIndexF(doc, index as c_int, &mut size) == 0 {
            return Err(format!("Page {index} size unavailable"));
        }
        pages.push(PageMetaOutput {
            index,
            width_pts: size.width as f64,
            height_pts: size.height as f64,
        });
    }

    Ok(DocumentMetaOutput {
        path: pdf_path.to_string(),
        page_count,
        pages,
    })
}

fn render_preview(
    pdfium: &Pdfium,
    pdf_path: &str,
    page_index: u32,
    max_dimension: u32,
    output_path: &str,
) -> Result<PreviewOutput, String> {
    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;
    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Page {page_index} not found: {e}"))?;

    let width_pts = page.width().value.max(1.0);
    let height_pts = page.height().value.max(1.0);
    let scale = max_dimension as f32 / width_pts.max(height_pts);
    let width = (width_pts * scale).round().max(1.0) as u32;
    let height = (height_pts * scale).round().max(1.0) as u32;

    let config = PdfRenderConfig::new().set_target_size(width as i32, height as i32);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("Preview render failed: {e}"))?;
    let rgba = bitmap.as_rgba_bytes().to_vec();
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(bitmap.width() as u32, bitmap.height() as u32, rgba)
            .ok_or("Preview buffer size mismatch")?;

    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create output dir: {e}"))?;
    }
    img.save(output_path)
        .map_err(|e| format!("Preview PNG save failed: {e}"))?;

    Ok(PreviewOutput {
        page: page_index,
        width: bitmap.width() as u32,
        height: bitmap.height() as u32,
        image_path: output_path.to_string(),
    })
}

fn render_tile(
    cache: &mut DocCache,
    pdf_path: &str,
    page_index: u32,
    dpi: f32,
    tile_x: u32,
    tile_y: u32,
    generation: u64,
) -> Result<(TileOutput, Vec<u8>), String> {
    const TILE_SIZE_PX: u32 = 512;

    let load_start = Instant::now();
    let page = cache.page(pdf_path, page_index)?;
    let bindings = cache.bindings;
    let page_load_ms = load_start.elapsed().as_secs_f64() * 1000.0;

    let scale = dpi / 72.0;
    let width_pts = bindings.FPDF_GetPageWidthF(page).max(1.0);
    let height_pts = bindings.FPDF_GetPageHeightF(page).max(1.0);
    let page_width_px = (width_pts * scale).ceil().max(1.0) as u32;
    let page_height_px = (height_pts * scale).ceil().max(1.0) as u32;
    let tile_px_x = tile_x * TILE_SIZE_PX;
    let tile_px_y = tile_y * TILE_SIZE_PX;

    let render_start = Instant::now();
    let tile = if tile_px_x < page_width_px && tile_px_y < page_height_px {
        // Render straight into a tile-sized bitmap: the matrix maps the page (already
        // in top-left-origin display space at this point in pdfium's pipeline) so that
        // the tile's top-left corner lands on the bitmap origin. Same flags as the old
        // full-page path: annotations on, byte order reversed so the buffer is RGBA.
        let bitmap = bindings.FPDFBitmap_CreateEx(
            TILE_SIZE_PX as c_int,
            TILE_SIZE_PX as c_int,
            BITMAP_FORMAT_BGRA,
            std::ptr::null_mut(),
            0,
        );
        if bitmap.is_null() {
            return Err("Tile bitmap allocation failed".to_string());
        }
        bindings.FPDFBitmap_FillRect(
            bitmap,
            0,
            0,
            TILE_SIZE_PX as c_int,
            TILE_SIZE_PX as c_int,
            0xFFFF_FFFF,
        );
        let matrix = FS_MATRIX {
            a: scale,
            b: 0.0,
            c: 0.0,
            d: scale,
            e: -(tile_px_x as f32),
            f: -(tile_px_y as f32),
        };
        let clip = FS_RECTF {
            left: 0.0,
            top: 0.0,
            right: TILE_SIZE_PX as f32,
            bottom: TILE_SIZE_PX as f32,
        };
        bindings.FPDF_RenderPageBitmapWithMatrix(
            bitmap,
            page,
            &matrix,
            &clip,
            FLAG_ANNOT | FLAG_REVERSE_BYTE_ORDER,
        );
        let bytes = bindings.FPDFBitmap_GetBuffer_as_vec(bitmap);
        bindings.FPDFBitmap_Destroy(bitmap);
        bytes
    } else {
        vec![255u8; (TILE_SIZE_PX * TILE_SIZE_PX * 4) as usize]
    };
    let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let encode_start = Instant::now();
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(TILE_SIZE_PX, TILE_SIZE_PX, tile).ok_or("Tile buffer mismatch")?;
    let mut png_bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("Tile PNG encode failed: {e}"))?;
    let encode_ms = encode_start.elapsed().as_secs_f64() * 1000.0;

    if std::env::var_os("TILE_TIMING").is_some() {
        eprintln!(
            "tile p{page_index} z{dpi} x{tile_x} y{tile_y}: load {page_load_ms:.1}ms render {render_ms:.1}ms encode {encode_ms:.1}ms"
        );
    }

    Ok((
        TileOutput {
            key: TileKeyOutput {
                page: page_index,
                zoom_level: 0,
                tile_x,
                tile_y,
            },
            x: tile_px_x,
            y: tile_px_y,
            generation,
            page_load_ms,
            render_ms,
            encode_ms,
        },
        png_bytes,
    ))
}

#[derive(Serialize)]
struct ViewOutput {
    width: u32,
    height: u32,
    render_ms: f64,
}

/// Renders an arbitrary viewport-sized crop of a page at a continuous (non-bucketed)
/// DPI — the settle pass. Same matrix+clip mechanism as `render_tile`, generalised from
/// a fixed 512² tile to an arbitrary size, and not cached: the caller (desktop app)
/// invalidates it on the next pan/zoom, so nothing here needs a generation check.
fn render_view(
    cache: &mut DocCache,
    pdf_path: &str,
    page_index: u32,
    dpi: f32,
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
) -> Result<(ViewOutput, Vec<u8>), String> {
    let page = cache.page(pdf_path, page_index)?;
    let bindings = cache.bindings;
    let scale = dpi / 72.0;

    let render_start = Instant::now();
    let bitmap = bindings.FPDFBitmap_CreateEx(
        crop_w as c_int,
        crop_h as c_int,
        BITMAP_FORMAT_BGRA,
        std::ptr::null_mut(),
        0,
    );
    if bitmap.is_null() {
        return Err("View bitmap allocation failed".to_string());
    }
    bindings.FPDFBitmap_FillRect(bitmap, 0, 0, crop_w as c_int, crop_h as c_int, 0xFFFF_FFFF);
    let matrix = FS_MATRIX {
        a: scale,
        b: 0.0,
        c: 0.0,
        d: scale,
        e: -(crop_x as f32),
        f: -(crop_y as f32),
    };
    let clip = FS_RECTF {
        left: 0.0,
        top: 0.0,
        right: crop_w as f32,
        bottom: crop_h as f32,
    };
    bindings.FPDF_RenderPageBitmapWithMatrix(
        bitmap,
        page,
        &matrix,
        &clip,
        FLAG_ANNOT | FLAG_REVERSE_BYTE_ORDER,
    );
    let bytes = bindings.FPDFBitmap_GetBuffer_as_vec(bitmap);
    bindings.FPDFBitmap_Destroy(bitmap);
    let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;

    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(crop_w, crop_h, bytes).ok_or("View buffer mismatch")?;
    let mut png_bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("View PNG encode failed: {e}"))?;

    if std::env::var_os("TILE_TIMING").is_some() {
        eprintln!(
            "view p{page_index} z{dpi} {crop_w}x{crop_h}: render {render_ms:.1}ms"
        );
    }

    Ok((
        ViewOutput {
            width: crop_w,
            height: crop_h,
            render_ms,
        },
        png_bytes,
    ))
}

fn handle_meta(cache: &mut DocCache, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = required_str(req, "pdf_path")?;
    serde_json::to_value(load_meta(cache, &pdf_path)?)
        .map_err(|e| format!("DocumentMeta serialise error: {e}"))
}

fn handle_preview(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = required_str(req, "pdf_path")?;
    let page = required_u32(req, "page")?;
    let max_dim = required_u32(req, "max_dim")?;
    let output_path = required_str(req, "output_path")?;

    serde_json::to_value(render_preview(
        pdfium,
        &pdf_path,
        page,
        max_dim,
        &output_path,
    )?)
    .map_err(|e| format!("PreviewData serialise error: {e}"))
}

fn handle_tile(
    cache: &mut DocCache,
    req: &serde_json::Value,
) -> Result<(serde_json::Value, Vec<u8>), String> {
    let pdf_path = required_str(req, "pdf_path")?;
    let page = required_u32(req, "page")?;
    let dpi = required_f32(req, "dpi")?;
    let tile_x = required_u32(req, "tile_x")?;
    let tile_y = required_u32(req, "tile_y")?;
    let generation = required_u64(req, "generation")?;

    let (output, png_bytes) =
        render_tile(cache, &pdf_path, page, dpi, tile_x, tile_y, generation)?;
    let data =
        serde_json::to_value(output).map_err(|e| format!("TileData serialise error: {e}"))?;
    Ok((data, png_bytes))
}

fn handle_view(
    cache: &mut DocCache,
    req: &serde_json::Value,
) -> Result<(serde_json::Value, Vec<u8>), String> {
    let pdf_path = required_str(req, "pdf_path")?;
    let page = required_u32(req, "page")?;
    let dpi = required_f32(req, "dpi")?;
    let crop_x = required_u32(req, "crop_x")?;
    let crop_y = required_u32(req, "crop_y")?;
    let crop_w = required_u32(req, "crop_w")?;
    let crop_h = required_u32(req, "crop_h")?;

    let (output, png_bytes) = render_view(cache, &pdf_path, page, dpi, crop_x, crop_y, crop_w, crop_h)?;
    let data =
        serde_json::to_value(output).map_err(|e| format!("ViewData serialise error: {e}"))?;
    Ok((data, png_bytes))
}

fn nearly_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 0.01
}

fn same_point(a: PathPoint, b: PathPoint) -> bool {
    nearly_equal(a.x, b.x) && nearly_equal(a.y, b.y)
}

fn path_points(path: &PdfPagePathObject<'_>, parent_matrix: PdfMatrix) -> Option<Vec<PathPoint>> {
    let matrix = path
        .matrix()
        .map(|path_matrix| path_matrix.multiply(parent_matrix))
        .unwrap_or(parent_matrix);
    let segments = path.segments().transform(matrix);

    let mut points = Vec::new();
    for segment in segments.iter() {
        match segment.segment_type() {
            PdfPathSegmentType::MoveTo | PdfPathSegmentType::LineTo => {
                points.push(PathPoint {
                    x: segment.x().value as f64,
                    y: segment.y().value as f64,
                    segment_type: segment.segment_type(),
                    closes_path: segment.is_close(),
                });
            }
            PdfPathSegmentType::BezierTo => {
                points.push(PathPoint {
                    x: segment.x().value as f64,
                    y: segment.y().value as f64,
                    segment_type: segment.segment_type(),
                    closes_path: segment.is_close(),
                });
            }
            PdfPathSegmentType::Unknown => return None,
        }
    }

    Some(points)
}

fn line_primitive(points: &[PathPoint]) -> Option<serde_json::Value> {
    if points.len() != 2 {
        return None;
    }
    if points[0].segment_type != PdfPathSegmentType::MoveTo
        || points[1].segment_type != PdfPathSegmentType::LineTo
        || same_point(points[0], points[1])
    {
        return None;
    }

    Some(serde_json::json!({
        "type": "line",
        "x1": points[0].x,
        "y1": points[0].y,
        "x2": points[1].x,
        "y2": points[1].y,
    }))
}

fn line_primitive_from_points(start: PathPoint, end: PathPoint) -> Option<serde_json::Value> {
    if same_point(start, end) {
        return None;
    }

    Some(serde_json::json!({
        "type": "line",
        "x1": start.x,
        "y1": start.y,
        "x2": end.x,
        "y2": end.y,
    }))
}

fn rect_primitive(points: &[PathPoint]) -> Option<serde_json::Value> {
    if !(4..=5).contains(&points.len()) {
        return None;
    }

    let has_close_marker = points.iter().any(|point| point.closes_path);
    let mut corners = points.to_vec();
    let has_duplicate_close = corners
        .last()
        .map(|last| same_point(corners[0], *last))
        .unwrap_or(false);
    if has_duplicate_close {
        corners.pop();
    }
    if corners.len() != 4 || (!has_close_marker && !has_duplicate_close) {
        return None;
    }
    if corners[0].segment_type != PdfPathSegmentType::MoveTo
        || corners[1..]
            .iter()
            .any(|point| point.segment_type != PdfPathSegmentType::LineTo)
    {
        return None;
    }

    for index in 0..4 {
        let a = corners[index];
        let b = corners[(index + 1) % 4];
        let horizontal = nearly_equal(a.y, b.y) && !nearly_equal(a.x, b.x);
        let vertical = nearly_equal(a.x, b.x) && !nearly_equal(a.y, b.y);
        if !horizontal && !vertical {
            return None;
        }
    }

    let min_x = corners
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let max_x = corners
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = corners
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let max_y = corners
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    if nearly_equal(min_x, max_x) || nearly_equal(min_y, max_y) {
        return None;
    }

    Some(serde_json::json!({
        "type": "rect",
        "x": min_x,
        "y": min_y,
        "width": max_x - min_x,
        "height": max_y - min_y,
    }))
}

fn line_primitives_from_path(points: &[PathPoint]) -> Vec<serde_json::Value> {
    let mut primitives = Vec::new();
    let mut current: Option<PathPoint> = None;

    for point in points {
        match point.segment_type {
            PdfPathSegmentType::MoveTo => current = Some(*point),
            PdfPathSegmentType::LineTo => {
                if let Some(start) = current {
                    if let Some(primitive) = line_primitive_from_points(start, *point) {
                        primitives.push(primitive);
                    }
                }
                current = Some(*point);
            }
            PdfPathSegmentType::BezierTo | PdfPathSegmentType::Unknown => {
                current = None;
            }
        }

        if point.closes_path {
            current = None;
        }
    }

    primitives
}

fn extract_primitives_from_object(
    object: &PdfPageObject<'_>,
    parent_matrix: PdfMatrix,
    primitives: &mut Vec<serde_json::Value>,
    depth: usize,
) {
    const MAX_FORM_DEPTH: usize = 16;

    if let Some(path) = object.as_path_object() {
        let Some(points) = path_points(path, parent_matrix) else {
            return;
        };
        if let Some(primitive) = rect_primitive(&points).or_else(|| line_primitive(&points)) {
            primitives.push(primitive);
        } else {
            primitives.extend(line_primitives_from_path(&points));
        }
        return;
    }

    if depth >= MAX_FORM_DEPTH {
        return;
    }

    let Some(form) = object.as_x_object_form_object() else {
        return;
    };
    let form_matrix = form.matrix().unwrap_or(PdfMatrix::IDENTITY);
    let child_parent_matrix = form_matrix.multiply(parent_matrix);

    for child_index in form.as_range() {
        if let Ok(child) = form.get(child_index) {
            extract_primitives_from_object(
                &child,
                child_parent_matrix,
                primitives,
                depth + 1,
            );
        }
    }
}

fn handle_vectors(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = required_str(req, "pdf_path")?;
    let page = required_u32(req, "page")?;
    let document = pdfium
        .load_pdf_from_file(&pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;
    let page_ref = document
        .pages()
        .get(page as u16)
        .map_err(|e| format!("Page {page} not found: {e}"))?;

    let mut primitives = Vec::new();
    for object in page_ref.objects().iter() {
        extract_primitives_from_object(&object, PdfMatrix::IDENTITY, &mut primitives, 0);
    }

    Ok(serde_json::json!({
        "page": page,
        "primitives": primitives,
    }))
}

/// Dispatches a request. On success returns the JSON `data` payload plus an optional
/// binary payload; when present, the response line carries a `bin` byte count and the
/// raw bytes immediately follow the newline on stdout.
fn dispatch(
    pdfium: &Pdfium,
    cache: &mut DocCache,
    cmd: &str,
    req: &serde_json::Value,
) -> Result<(serde_json::Value, Option<Vec<u8>>), String> {
    match cmd {
        "meta" => handle_meta(cache, req).map(|data| (data, None)),
        "preview" => handle_preview(pdfium, req).map(|data| (data, None)),
        "tile" => handle_tile(cache, req).map(|(data, bytes)| (data, Some(bytes))),
        "view" => handle_view(cache, req).map(|(data, bytes)| (data, Some(bytes))),
        "vectors" => handle_vectors(pdfium, req).map(|data| (data, None)),
        other => Err(format!("unknown command: {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lib_path = args.get(1).expect("Usage: pdf_renderer <pdfium-lib-path>");
    let pdfium = init_pdfium(lib_path);
    let mut cache = DocCache::new(pdfium.bindings());

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout_lock = stdout.lock();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(e) => {
                eprintln!("stdin read error: {e}");
                break;
            }
        };

        let request: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("JSON parse error: {e}");
                continue;
            }
        };

        let id = request["id"].as_u64().unwrap_or(0);
        let cmd = request["cmd"].as_str().unwrap_or("");

        if cmd == "shutdown" {
            let _ = writeln!(stdout_lock, "{{\"id\":{id},\"ok\":true,\"data\":null}}");
            let _ = stdout_lock.flush();
            break;
        }

        let result = dispatch(&pdfium, &mut cache, cmd, &request);
        let (response, binary) = match result {
            Ok((data, binary)) => {
                let mut response = serde_json::json!({ "id": id, "ok": true, "data": data });
                if let Some(bytes) = &binary {
                    response["bin"] = serde_json::json!(bytes.len());
                }
                (response, binary)
            }
            Err(e) => (serde_json::json!({ "id": id, "ok": false, "error": e }), None),
        };

        if let Err(e) = writeln!(stdout_lock, "{response}") {
            eprintln!("stdout write error: {e}");
            break;
        }
        if let Some(bytes) = binary {
            if let Err(e) = stdout_lock.write_all(&bytes) {
                eprintln!("stdout binary write error: {e}");
                break;
            }
        }
        let _ = stdout_lock.flush();
    }

    cache.close_all();
}
