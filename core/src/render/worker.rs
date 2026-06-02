use base64::{engine::general_purpose, Engine as _};
use crossbeam_channel::bounded;
use image::{ImageBuffer, Rgba};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::Path;

use crate::pdf::document::init_pdfium;
use crate::pdf::tile_manager::TileManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewData {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub image_path: String,
}

pub fn render_page_tile_base64(
    lib_path: &str,
    pdf_path: &str,
    page_index: u32,
    target_width: u32,
    target_height: u32,
) -> Result<String, String> {
    let pdfium = crate::pdf::document::init_pdfium(lib_path);
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;

    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Page not found: {e}"))?;

    let config = PdfRenderConfig::new()
        .set_target_width(target_width as i32)
        .set_target_height(target_height as i32);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("Render failed: {e}"))?;

    let rgba = bitmap.as_rgba_bytes().to_vec();
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_raw(bitmap.width() as u32, bitmap.height() as u32, rgba)
            .ok_or("Failed to build image buffer")?;

    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(&png_bytes)
    ))
}

pub fn render_page_preview_file(
    lib_path: &str,
    pdf_path: &str,
    page_index: u32,
    max_dimension: u32,
    cache_dir: &str,
) -> Result<PreviewData, String> {
    fs::create_dir_all(cache_dir).map_err(|e| format!("Could not create cache dir: {e}"))?;

    let pdfium = init_pdfium(lib_path);
    let doc = pdfium
        .load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;
    let page = doc
        .pages()
        .get(page_index as u16)
        .map_err(|e| format!("Page not found: {e}"))?;

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

    let output_path = Path::new(cache_dir).join(format!("preview_page_{page_index}.png"));
    img.save(&output_path)
        .map_err(|e| format!("Preview PNG save failed: {e}"))?;

    Ok(PreviewData {
        page: page_index,
        width: bitmap.width() as u32,
        height: bitmap.height() as u32,
        image_path: output_path.to_string_lossy().to_string(),
    })
}

pub fn create_tile_manager_with_workers(_num_threads: usize) -> TileManager {
    let (render_tx, _render_rx) = bounded(64);
    let (completion_tx, completion_rx) = bounded(512);
    TileManager::new(render_tx, completion_tx, completion_rx)
}
