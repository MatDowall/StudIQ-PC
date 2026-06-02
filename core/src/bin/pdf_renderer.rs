#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use image::{ImageBuffer, Rgba};
use pdfium_render::prelude::*;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

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
    image_path: String,
    x: u32,
    y: u32,
    generation: u64,
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

fn load_meta(pdfium: &Pdfium, pdf_path: &str) -> Result<DocumentMetaOutput, String> {
    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;
    let pages: Vec<PageMetaOutput> = (0..document.pages().len())
        .map(|page_index| {
            let page = document.pages().get(page_index).unwrap();
            PageMetaOutput {
                index: page_index as u32,
                width_pts: page.width().value as f64,
                height_pts: page.height().value as f64,
            }
        })
        .collect();

    Ok(DocumentMetaOutput {
        path: pdf_path.to_string(),
        page_count: document.pages().len() as u32,
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
    pdfium: &Pdfium,
    pdf_path: &str,
    page_index: u32,
    dpi: f32,
    tile_x: u32,
    tile_y: u32,
    output_path: &str,
    generation: u64,
) -> Result<TileOutput, String> {
    const TILE_SIZE_PX: u32 = 512;

    let document = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;
    let page = document
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Page {page_index} not found: {e}"))?;

    let scale = dpi / 72.0;
    let page_width_px = (page.width().value * scale).ceil().max(1.0) as u32;
    let page_height_px = (page.height().value * scale).ceil().max(1.0) as u32;
    let tile_px_x = tile_x * TILE_SIZE_PX;
    let tile_px_y = tile_y * TILE_SIZE_PX;
    let mut tile = vec![255u8; (TILE_SIZE_PX * TILE_SIZE_PX * 4) as usize];

    if tile_px_x < page_width_px && tile_px_y < page_height_px {
        let crop_width = TILE_SIZE_PX.min(page_width_px.saturating_sub(tile_px_x));
        let crop_height = TILE_SIZE_PX.min(page_height_px.saturating_sub(tile_px_y));
        let config = PdfRenderConfig::new()
            .set_target_size(page_width_px as i32, page_height_px as i32)
            .clip(
                tile_px_x as i32,
                tile_px_y as i32,
                (tile_px_x + crop_width) as i32,
                (tile_px_y + crop_height) as i32,
            );
        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| format!("Tile page render failed: {e}"))?;
        let rgba = bitmap.as_rgba_bytes();

        let src_stride = page_width_px as usize * 4;
        let dst_stride = TILE_SIZE_PX as usize * 4;

        for row in 0..crop_height as usize {
            let src_start = ((tile_px_y as usize + row) * src_stride) + tile_px_x as usize * 4;
            let src_end = src_start + crop_width as usize * 4;
            let dst_start = row * dst_stride;
            let dst_end = dst_start + crop_width as usize * 4;
            tile[dst_start..dst_end].copy_from_slice(&rgba[src_start..src_end]);
        }
    }

    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(TILE_SIZE_PX, TILE_SIZE_PX, tile).ok_or("Tile buffer mismatch")?;

    if let Some(parent) = Path::new(output_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create output dir: {e}"))?;
    }
    img.save(output_path)
        .map_err(|e| format!("Tile PNG save failed: {e}"))?;

    Ok(TileOutput {
        key: TileKeyOutput {
            page: page_index,
            zoom_level: 0,
            tile_x,
            tile_y,
        },
        image_path: output_path.to_string(),
        x: tile_px_x,
        y: tile_px_y,
        generation,
    })
}

fn handle_meta(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = required_str(req, "pdf_path")?;
    serde_json::to_value(load_meta(pdfium, &pdf_path)?)
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

fn handle_tile(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String> {
    let pdf_path = required_str(req, "pdf_path")?;
    let page = required_u32(req, "page")?;
    let dpi = required_f32(req, "dpi")?;
    let tile_x = required_u32(req, "tile_x")?;
    let tile_y = required_u32(req, "tile_y")?;
    let output_path = required_str(req, "output_path")?;
    let generation = required_u64(req, "generation")?;

    serde_json::to_value(render_tile(
        pdfium,
        &pdf_path,
        page,
        dpi,
        tile_x,
        tile_y,
        &output_path,
        generation,
    )?)
    .map_err(|e| format!("TileData serialise error: {e}"))
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

fn dispatch(
    pdfium: &Pdfium,
    cmd: &str,
    req: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        "meta" => handle_meta(pdfium, req),
        "preview" => handle_preview(pdfium, req),
        "tile" => handle_tile(pdfium, req),
        "vectors" => handle_vectors(pdfium, req),
        other => Err(format!("unknown command: {other}")),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let lib_path = args.get(1).expect("Usage: pdf_renderer <pdfium-lib-path>");
    let pdfium = init_pdfium(lib_path);

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

        let result = dispatch(&pdfium, cmd, &request);
        let response = match result {
            Ok(data) => serde_json::json!({ "id": id, "ok": true, "data": data }),
            Err(e) => serde_json::json!({ "id": id, "ok": false, "error": e }),
        };

        if let Err(e) = writeln!(stdout_lock, "{response}") {
            eprintln!("stdout write error: {e}");
            break;
        }
        let _ = stdout_lock.flush();
    }
}
