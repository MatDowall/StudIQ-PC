use serde::{Deserialize, Serialize};

use crate::pdf::tile_manager::TileManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewData {
    pub page: u32,
    pub width: u32,
    pub height: u32,
    pub image_path: String,
}

/// Builds the tile manager used by the desktop app. Rendering itself happens
/// out-of-process in `pdf_renderer`; this only owns the tile metadata cache.
/// Completed tiles are pushed to the frontend via Tauri events by the desktop
/// tile worker.
pub fn create_tile_manager() -> TileManager {
    TileManager::new()
}
