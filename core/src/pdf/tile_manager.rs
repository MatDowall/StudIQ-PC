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
// Metadata-only entries (a key + a few ints + a short string), so the cap is sized for
// coverage rather than memory: an A1 sheet at the top zoom bucket is ~450 tiles, and
// panning can have several zoom buckets' worth of tiles alive across a session.
const MAX_CACHED_TILES: usize = 4096;

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
    /// Key into the desktop app's in-memory tile store; the frontend fetches the
    /// PNG bytes through the `tile` URI scheme using this value.
    pub image_path: String,
    pub x: u32,
    pub y: u32,
    pub generation: u64,
}

pub struct TileManager {
    cache: Arc<Mutex<LruCache<TileKey, TileData>>>,
    queued: Arc<Mutex<HashMap<TileKey, u64>>>,
    generation: Arc<AtomicU64>,
}

pub enum TileQueueState {
    Cached(TileData),
    Queued { generation: u64, dpi: f32 },
    AlreadyQueued { generation: u64, dpi: f32 },
}

impl TileManager {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(LruCache::new(
                NonZeroUsize::new(MAX_CACHED_TILES).unwrap(),
            ))),
            queued: Arc::new(Mutex::new(HashMap::new())),
            generation: Arc::new(AtomicU64::new(1)),
        }
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

    /// Removes a cache entry whose backing tile bytes are gone from the store,
    /// so the tile gets re-queued instead of being served as a dead reference.
    pub fn evict(&self, key: &TileKey) {
        self.cache.lock().pop(key);
    }

    pub fn complete_render(&self, tile: TileData) {
        let current_generation = self.current_generation();
        self.queued.lock().remove(&tile.key);
        if tile.generation != current_generation {
            return;
        }
        self.cache.lock().put(tile.key, tile);
    }

    pub fn fail_render(&self, key: &TileKey) {
        self.queued.lock().remove(key);
    }

    pub fn get_cached(&self, key: &TileKey) -> Option<TileData> {
        self.cache.lock().get(key).cloned()
    }
}

impl Default for TileManager {
    fn default() -> Self {
        Self::new()
    }
}
