use crossbeam_channel::{Receiver, Sender};
use lru::LruCache;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

pub const TILE_SIZE_PX: u32 = 512;
const MAX_CACHED_TILES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileKey {
    pub page: u32,
    pub zoom_level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TileData {
    pub key: TileKey,
    pub image_path: String,
    pub x: u32,
    pub y: u32,
    pub generation: u64,
}

pub struct RenderRequest {
    pub key: TileKey,
    pub pdf_path: String,
    pub lib_path: String,
    pub cache_dir: String,
    pub renderer_path: String,
    pub dpi: f32,
    pub generation: u64,
}

pub struct TileManager {
    cache: Arc<Mutex<LruCache<TileKey, TileData>>>,
    queued: Arc<Mutex<HashMap<TileKey, u64>>>,
    generation: Arc<AtomicU64>,
    render_tx: Sender<RenderRequest>,
    completion_tx: Sender<TileData>,
    pub completion_rx: Receiver<TileData>,
}

pub enum TileQueueState {
    Cached(TileData),
    Queued { generation: u64, dpi: f32 },
    AlreadyQueued { generation: u64, dpi: f32 },
}

impl TileManager {
    pub fn new(
        render_tx: Sender<RenderRequest>,
        completion_tx: Sender<TileData>,
        completion_rx: Receiver<TileData>,
    ) -> Self {
        Self {
            cache: Arc::new(Mutex::new(LruCache::new(
                NonZeroUsize::new(MAX_CACHED_TILES).unwrap(),
            ))),
            queued: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(1)),
            render_tx,
            completion_tx,
            completion_rx,
        }
    }

    pub fn insert(&self, tile: TileData) {
        let current_generation = self.current_generation();
        self.queued.lock().remove(&tile.key);
        if tile.generation != current_generation {
            return;
        }
        self.cache.lock().put(tile.key, tile);
    }

    pub fn clear(&self) {
        self.cache.lock().clear();
        self.queued.lock().clear();
        self.advance_generation();
    }

    pub fn generation_handle(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.generation)
    }

    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    pub fn advance_generation(&self) -> u64 {
        self.queued.lock().clear();
        self.generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn get_cached_or_mark_queued(&self, key: TileKey) -> TileQueueState {
        let mut cache = self.cache.lock();
        if let Some(tile) = cache.get(&key) {
            return TileQueueState::Cached(tile.clone());
        }
        drop(cache);

        let generation = self.current_generation();
        let mut queued = self.queued.lock();
        if queued
            .get(&key)
            .is_some_and(|queued_generation| *queued_generation == generation)
        {
            let dpi = 96.0 * 2f32.powi(key.zoom_level as i32 - 2);
            return TileQueueState::AlreadyQueued { generation, dpi };
        }

        queued.insert(key, generation);
        let dpi = 96.0 * 2f32.powi(key.zoom_level as i32 - 2);
        TileQueueState::Queued { generation, dpi }
    }

    pub fn complete_render(&self, tile: TileData) {
        let current_generation = self.current_generation();
        self.queued.lock().remove(&tile.key);
        if tile.generation != current_generation {
            return;
        }
        self.cache.lock().put(tile.key, tile.clone());
        let _ = self.completion_tx.try_send(tile);
    }

    pub fn fail_render(&self, key: &TileKey) {
        self.queued.lock().remove(key);
    }

    pub fn get_or_queue(
        &self,
        key: TileKey,
        pdf_path: &str,
        lib_path: &str,
        cache_dir: &str,
        renderer_path: &str,
    ) -> Option<TileData> {
        let mut cache = self.cache.lock();
        if let Some(tile) = cache.get(&key) {
            return Some(tile.clone());
        }
        drop(cache);

        let generation = self.current_generation();
        let mut queued = self.queued.lock();
        if queued
            .get(&key)
            .is_some_and(|queued_generation| *queued_generation == generation)
        {
            return None;
        }

        let dpi = 96.0 * 2f32.powi(key.zoom_level as i32 - 2);
        if self
            .render_tx
            .try_send(RenderRequest {
                key,
                pdf_path: pdf_path.to_string(),
                lib_path: lib_path.to_string(),
                cache_dir: cache_dir.to_string(),
                renderer_path: renderer_path.to_string(),
                dpi,
                generation,
            })
            .is_ok()
        {
            queued.insert(key, generation);
        }
        None
    }

    pub fn get_cached(&self, key: &TileKey) -> Option<TileData> {
        self.cache.lock().get(key).cloned()
    }

    pub fn invalidate_zoom(&self, zoom_level: u8) {
        let mut cache = self.cache.lock();
        let keys: Vec<TileKey> = cache
            .iter()
            .filter_map(|(key, _)| (key.zoom_level == zoom_level).then_some(*key))
            .collect();
        for key in keys {
            cache.pop(&key);
        }
        drop(cache);
        self.queued.lock().retain(|k, _| k.zoom_level != zoom_level);
    }

    pub fn drain_completed(&self) -> Vec<TileData> {
        let mut results = Vec::new();
        while let Ok(tile) = self.completion_rx.try_recv() {
            let current_generation = self.current_generation();
            self.queued.lock().remove(&tile.key);
            if tile.generation == current_generation {
                self.cache.lock().put(tile.key, tile.clone());
                results.push(tile);
            }
        }
        results
    }
}
