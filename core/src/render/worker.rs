use crossbeam_channel::bounded;
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
/// out-of-process in `pdf_renderer`; this only owns the cache and the
/// completion channel that the desktop tile worker drains.
pub fn create_tile_manager_with_workers(_num_threads: usize) -> TileManager {
    let (completion_tx, completion_rx) = bounded(512);
    TileManager::new(completion_tx, completion_rx)
}
