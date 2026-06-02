use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentMeta {
    pub path: String,
    pub page_count: u32,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageMeta {
    pub index: u32,
    pub width_pts: f64,
    pub height_pts: f64,
}

pub fn init_pdfium(lib_path: &str) -> Pdfium {
    Pdfium::new(
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(lib_path))
            .expect("Failed to load pdfium library"),
    )
}

pub fn load_document_meta(pdfium: &Pdfium, path: &str) -> Result<DocumentMeta, String> {
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let pages: Vec<PageMeta> = (0..doc.pages().len())
        .map(|i| {
            let page = doc.pages().get(i).unwrap();
            PageMeta {
                index: i as u32,
                width_pts: page.width().value as f64,
                height_pts: page.height().value as f64,
            }
        })
        .collect();

    Ok(DocumentMeta {
        path: path.to_string(),
        page_count: doc.pages().len() as u32,
        pages,
    })
}
