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
