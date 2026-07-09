use crate::pdf::tile_manager::TileKey;
use serde::{Deserialize, Serialize};

pub const TILE_SIZE_PX: u32 = 512;
const TILE_PREFETCH_RADIUS: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewportState {
    pub page_index: u32,
    pub zoom: f64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub width: u32,
    pub height: u32,
}

impl ViewportState {
    pub fn visible_tiles(&self, page_width_px: u32, page_height_px: u32) -> Vec<TileKey> {
        let cols = (page_width_px + TILE_SIZE_PX - 1) / TILE_SIZE_PX;
        let rows = (page_height_px + TILE_SIZE_PX - 1) / TILE_SIZE_PX;

        let vp_left = self.pan_x.max(0.0) as u32;
        let vp_top = self.pan_y.max(0.0) as u32;
        let vp_right = vp_left.saturating_add(self.width);
        let vp_bottom = vp_top.saturating_add(self.height);

        let visible_start_col = (vp_left / TILE_SIZE_PX).min(cols);
        let visible_end_col = ((vp_right + TILE_SIZE_PX - 1) / TILE_SIZE_PX).min(cols);
        let visible_start_row = (vp_top / TILE_SIZE_PX).min(rows);
        let visible_end_row = ((vp_bottom + TILE_SIZE_PX - 1) / TILE_SIZE_PX).min(rows);

        let start_col = visible_start_col.saturating_sub(TILE_PREFETCH_RADIUS);
        let end_col = visible_end_col
            .saturating_add(TILE_PREFETCH_RADIUS)
            .min(cols);
        let start_row = visible_start_row.saturating_sub(TILE_PREFETCH_RADIUS);
        let end_row = visible_end_row
            .saturating_add(TILE_PREFETCH_RADIUS)
            .min(rows);

        let center_col = ((start_col + end_col) / 2) as i64;
        let center_row = ((start_row + end_row) / 2) as i64;
        let mut keys = Vec::new();

        for row in start_row..end_row {
            for col in start_col..end_col {
                keys.push(TileKey {
                    page: self.page_index,
                    zoom_level: Self::zoom_bucket(self.zoom),
                    tile_x: col,
                    tile_y: row,
                });
            }
        }

        keys.sort_by_key(|key| {
            let dx = key.tile_x as i64 - center_col;
            let dy = key.tile_y as i64 - center_row;
            dx * dx + dy * dy
        });
        keys
    }

    pub fn zoom_bucket(zoom: f64) -> u8 {
        match zoom {
            z if z <= 0.3 => 0,
            z if z <= 0.6 => 1,
            z if z <= 1.25 => 2,
            z if z <= 2.5 => 3,
            z if z <= 5.0 => 4,
            _ => 5,
        }
    }

    pub fn bucket_zoom(zoom_level: u8) -> f64 {
        2f64.powi(zoom_level as i32 - 2)
    }

    pub fn page_width_px(&self, width_pts: f64) -> u32 {
        (width_pts * self.zoom * 96.0 / 72.0).ceil() as u32
    }

    pub fn page_height_px(&self, height_pts: f64) -> u32 {
        (height_pts * self.zoom * 96.0 / 72.0).ceil() as u32
    }
}
