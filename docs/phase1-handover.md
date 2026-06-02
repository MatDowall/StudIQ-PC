# Phase 1 Handover: PDF Core Engine
## Desktop CAD/Takeoff Application — Rust + Tauri

---

## Decisions Already Made — Do Not Revisit

The following decisions are final. Do not suggest alternatives or raise them as questions:

- **PDF rendering library:** `pdfium-render` only. No other PDF library.
- **Tile transfer over IPC:** Raw `Vec<u8>` RGBA bytes. No base64, no PNG encoding for tile transfer.
- **Skia:** Not used in Phase 1. Do not add `skia-safe` as a dependency. It is deferred to Phase 2.
- **Compositor role:** `compositor.rs` handles tile layout and position calculation only. No GPU compositing.
- **pdfium binary management:** Manually placed in `./libs/pdfium/` by the developer. No `build.rs` download automation.
- **Frontend tooling:** Generate standard `vite.config.ts` and `tsconfig.json` for a Tauri v2 React TypeScript project. These are expected and not subject to the no-unlisted-dependencies rule.
- **pdfium thread strategy:** `PdfDocument` is not `Send`. Solve this by giving each worker thread its own pdfium instance that loads the document independently. Do not attempt to share a single `PdfDocument` across threads.
- **pdfium path:** `init_pdfium()` must accept a dynamic path string. The path is resolved at runtime in `desktop/src/main.rs` using Tauri's `app.path().resource_dir()`. Never hardcode `./libs/pdfium/`.
- **App icons:** Generate using `npx @tauri-apps/cli icon` or place manually in `desktop/icons/`. This is a developer environment task, not a code task.

---

## Context & Goal

You are building **Phase 1** of a desktop PDF CAD application similar to Bluebeam Revu and iTWO CostX. The application will eventually support vector snapping, measurement takeoff, and cost estimation. Phase 1 is exclusively focused on the **core PDF rendering engine** — smooth, lag-free pan/zoom/navigation at 60fps on large engineering drawings (A0/A1 sheets at 300 DPI).

**The primary constraint:** Previous attempts using JavaScript and Tauri with JS-side PDF rendering hit hard performance ceilings. All PDF parsing and rendering **must** happen in native Rust. The Tauri frontend (React) is a thin shell only — it renders composited tile images and sends user input events. No PDF logic lives in JS.

**Phase 1 success benchmark:** A single A0 PDF page must render within 200ms of load, pan/zoom must sustain 60fps, and page navigation between pages must feel instantaneous.

---

## Execution Instructions

Implement all files in the order defined in the Implementation Order section below. Do not ask for approval between files — implement the entire phase end to end, then provide a single completion summary. Only stop and ask a question if you encounter a genuine blocker that cannot be resolved from the information in this document.

When the full implementation is complete, provide:
1. A list of every file created
2. Exact commands to run to build and launch the application
3. Any manual environment setup steps required before those commands will work
4. Confirmation against every item in the Definition of Done checklist

---

## Repository Structure

```
/
├── Cargo.toml                  (workspace root)
├── core/                       (Rust library crate — the engine)
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── pdf/
│       │   ├── mod.rs
│       │   ├── document.rs     (pdfium document wrapper)
│       │   ├── page.rs         (page metadata, dimensions)
│       │   └── tile_manager.rs (tile grid, cache, priority queue)
│       ├── render/
│       │   ├── mod.rs
│       │   ├── worker.rs       (render worker thread pool)
│       │   └── compositor.rs   (tile layout and position calculation only)
│       └── viewport/
│           ├── mod.rs
│           └── state.rs        (pan offset, zoom level, viewport rect)
├── desktop/                    (Tauri application)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   └── main.rs             (Tauri app entry, command registration)
│   └── src-frontend/           (React UI)
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           └── components/
│               ├── Viewer.tsx  (canvas + event handling)
│               ├── Toolbar.tsx (zoom controls, page nav)
│               └── PageList.tsx (sidebar thumbnail list)
└── bench/                      (criterion benchmarks)
    ├── Cargo.toml
    └── benches/
        └── render_bench.rs
```

---

## Dependencies

### `core/Cargo.toml`

```toml
[package]
name = "core"
version = "0.1.0"
edition = "2021"

[dependencies]
pdfium-render = { version = "0.8", features = ["thread_safe"] }

rayon = "1.9"
crossbeam-channel = "0.5"
parking_lot = "0.12"

lru = "0.12"
priority-queue = "1.3"

serde = { version = "1", features = ["derive"] }
serde_json = "1"

tracing = "0.1"
tracing-subscriber = "0.3"

[dev-dependencies]
criterion = { version = "0.5", features = ["html_reports"] }
```

### `desktop/Cargo.toml`

```toml
[package]
name = "desktop"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
tauri-plugin-dialog = "2"
core = { path = "../core" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
```

### Frontend `package.json`

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

---

## pdfium Setup

pdfium-render requires the native pdfium shared library at runtime. It is not bundled automatically.

**Developer setup (manual, before running the app):**
1. Download the prebuilt binary from: `https://github.com/bblanchon/pdfium-binaries/releases`
2. Place the library file in `./libs/pdfium/` using the exact filename for each platform:
   - Windows: `pdfium.dll`
   - macOS: `libpdfium.dylib`
   - Linux: `libpdfium.so`

**Runtime path resolution (must be implemented this way):**

`init_pdfium()` must accept a `&str` path argument. Never hardcode the path. In `desktop/src/main.rs`, resolve the path at runtime using Tauri's resource directory:

```rust
// core/src/pdf/document.rs
use pdfium_render::prelude::*;

pub fn init_pdfium(lib_path: &str) -> Pdfium {
    Pdfium::new(
        Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(lib_path)
        ).expect("Failed to load pdfium library")
    )
}
```

```rust
// desktop/src/main.rs — resolve path before passing to core
let resource_dir = app.path().resource_dir()
    .expect("Could not resolve resource directory");
let pdfium_path = resource_dir.join("libs/pdfium");
let pdfium = init_pdfium(pdfium_path.to_str().unwrap());
```

**Tauri bundling config (`tauri.conf.json`):**
```json
{
  "bundle": {
    "resources": ["../libs/pdfium/*"]
  }
}
```

Document the required filenames in `README.md`.

---

## Core Data Structures

### Tile

```rust
// core/src/pdf/tile_manager.rs

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub page: u32,
    pub zoom_level: u8,   // discrete zoom bucket (0=25%, 1=50%, 2=100%, 3=200%)
    pub tile_x: u32,
    pub tile_y: u32,
}

pub const TILE_SIZE_PX: u32 = 512;

#[derive(Debug, Clone)]
pub struct TileData {
    pub key: TileKey,
    pub rgba_bytes: Vec<u8>,   // raw RGBA, TILE_SIZE_PX * TILE_SIZE_PX * 4 bytes
    pub width: u32,
    pub height: u32,
}
```

### Viewport State

```rust
// core/src/viewport/state.rs

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ViewportState {
    pub page_index: u32,
    pub zoom: f64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub viewport_width: u32,
    pub viewport_height: u32,
}

impl ViewportState {
    pub fn visible_tiles(&self, page_width_px: u32, page_height_px: u32) -> Vec<TileKey> {
        // Calculate which 512px tiles overlap the current viewport rect
        // accounting for zoom and pan. Return in viewport-centre-first order.
        todo!()
    }

    pub fn screen_to_page(&self, screen_x: f64, screen_y: f64) -> (f64, f64) {
        todo!()
    }
}
```

### Document Metadata

```rust
// core/src/pdf/document.rs

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocumentMeta {
    pub path: String,
    pub page_count: u32,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PageMeta {
    pub index: u32,
    pub width_pts: f64,
    pub height_pts: f64,
    pub rotation: u16,
}
```

---

## Tile Manager Implementation

```rust
// core/src/pdf/tile_manager.rs

use lru::LruCache;
use parking_lot::Mutex;
use std::sync::Arc;
use crossbeam_channel::Sender;

pub struct TileManager {
    cache: Arc<Mutex<LruCache<TileKey, TileData>>>,
    render_tx: Sender<RenderRequest>,
}

pub struct RenderRequest {
    pub key: TileKey,
    pub page_width_pts: f64,
    pub page_height_pts: f64,
    pub dpi: f32,
}

impl TileManager {
    /// Returns cached tiles immediately. Queues missing tiles for background render.
    /// Never blocks the caller.
    pub fn get_tiles_for_viewport(
        &self,
        viewport: &ViewportState,
        page_meta: &PageMeta,
    ) -> Vec<Option<TileData>> {
        let keys = viewport.visible_tiles(
            (page_meta.width_pts * viewport.zoom) as u32,
            (page_meta.height_pts * viewport.zoom) as u32,
        );
        let mut cache = self.cache.lock();
        keys.into_iter().map(|key| {
            if let Some(tile) = cache.get(&key) {
                Some(tile.clone())
            } else {
                let _ = self.render_tx.send(RenderRequest {
                    key,
                    page_width_pts: page_meta.width_pts,
                    page_height_pts: page_meta.height_pts,
                    dpi: (96.0 * viewport.zoom) as f32,
                });
                None
            }
        }).collect()
    }

    pub fn invalidate_zoom_level(&self, old_zoom_level: u8) {
        let mut cache = self.cache.lock();
        cache.retain(|k, _| k.zoom_level != old_zoom_level);
    }

    pub fn prefetch_page(&self, page_index: u32, page_meta: &PageMeta, zoom: f64) {
        todo!()
    }
}

pub const MAX_CACHED_TILES: usize = 512;
```

---

## Render Worker Pool

Each worker thread loads the PDF independently. `PdfDocument` is not `Send` — do not attempt to share it across threads.

```rust
// core/src/render/worker.rs

use pdfium_render::prelude::*;
use crossbeam_channel::{Receiver, Sender};
use crate::pdf::tile_manager::{RenderRequest, TileData, TILE_SIZE_PX};
use crate::pdf::document::init_pdfium;

pub fn start_worker_pool(
    num_threads: usize,
    pdf_path: String,
    pdfium_lib_path: String,
    render_rx: Receiver<RenderRequest>,
    completion_tx: Sender<TileData>,
) {
    // Fan out the single render_rx across N worker threads using a shared receiver
    let render_rx = Arc::new(Mutex::new(render_rx));

    for _ in 0..num_threads {
        let rx = Arc::clone(&render_rx);
        let tx = completion_tx.clone();
        let path = pdf_path.clone();
        let lib_path = pdfium_lib_path.clone();

        std::thread::spawn(move || {
            // Each thread owns its own pdfium instance and document handle
            let pdfium = init_pdfium(&lib_path);
            let document = pdfium.load_pdf_from_file(&path, None)
                .expect("Worker failed to open PDF");

            loop {
                let request = {
                    let rx = rx.lock().unwrap();
                    rx.recv()
                };
                match request {
                    Ok(req) => {
                        let tile = render_tile(&document, &req);
                        let _ = tx.send(tile);
                    }
                    Err(_) => break, // channel closed, shut down
                }
            }
        });
    }
}

fn render_tile(document: &PdfDocument, request: &RenderRequest) -> TileData {
    let page = document.pages().get(request.key.page as u16)
        .expect("Invalid page index");

    let tile_origin_x = request.key.tile_x * TILE_SIZE_PX;
    let tile_origin_y = request.key.tile_y * TILE_SIZE_PX;

    let config = PdfRenderConfig::new()
        .set_target_width(TILE_SIZE_PX as i32)
        .set_target_height(TILE_SIZE_PX as i32)
        .clip_page_to_bounding_box(
            tile_origin_x as f32,
            tile_origin_y as f32,
            (tile_origin_x + TILE_SIZE_PX) as f32,
            (tile_origin_y + TILE_SIZE_PX) as f32,
        );

    let bitmap = page.render_with_config(&config)
        .expect("Tile render failed");

    TileData {
        key: request.key,
        rgba_bytes: bitmap.as_rgba_bytes().to_vec(),
        width: TILE_SIZE_PX,
        height: TILE_SIZE_PX,
    }
}
```

---

## Tauri Command Interface

Tiles are transferred as raw RGBA bytes — not base64, not PNG. The frontend constructs `ImageData` from the raw bytes directly.

```rust
// desktop/src/main.rs

#[tauri::command]
async fn open_document(path: String, state: State<'_, AppState>) -> Result<DocumentMeta, String> {
    todo!()
}

#[tauri::command]
async fn update_viewport(
    viewport: ViewportState,
    state: State<'_, AppState>,
) -> Result<ViewportFrame, String> {
    todo!()
}

#[tauri::command]
async fn poll_tiles(state: State<'_, AppState>) -> Result<Vec<RawTile>, String> {
    todo!()
}

#[derive(serde::Serialize)]
pub struct ViewportFrame {
    pub tiles: Vec<Option<RawTile>>,
    pub viewport: ViewportState,
}

/// Tile data transferred as raw RGBA bytes — no base64 overhead
#[derive(serde::Serialize, Clone)]
pub struct RawTile {
    pub key: TileKeyDto,
    pub rgba_bytes: Vec<u8>,  // TILE_SIZE_PX * TILE_SIZE_PX * 4
    pub width: u32,
    pub height: u32,
    pub x: u32,   // pixel offset within viewport
    pub y: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TileKeyDto {
    pub page: u32,
    pub zoom_level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
}
```

---

## React Frontend Architecture

### Viewer Component

The viewer is a `<canvas>` element. Zoom and pan state is maintained in Rust — the frontend sends viewport updates and receives tile data. CSS transforms are not used for zoom/pan.

```tsx
// desktop/src-frontend/src/components/Viewer.tsx

import { useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface RawTile {
  key: { page: number; zoom_level: number; tile_x: number; tile_y: number };
  rgba_bytes: number[];
  width: number;
  height: number;
  x: number;
  y: number;
}

export function Viewer({ documentPath }: { documentPath: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const viewportRef = useRef({
    pageIndex: 0, zoom: 1.0, panX: 0, panY: 0,
    viewportWidth: 0, viewportHeight: 0,
  });

  // RAF loop — polls for completed tiles, draws to offscreen, blits to visible canvas
  useEffect(() => {
    let rafId: number;
    const loop = async () => {
      const tiles = await invoke<RawTile[]>("poll_tiles");
      if (tiles.length > 0) {
        const ctx = offscreenRef.current.getContext("2d")!;
        for (const tile of tiles) {
          const imageData = new ImageData(
            new Uint8ClampedArray(tile.rgba_bytes),
            tile.width,
            tile.height
          );
          ctx.putImageData(imageData, tile.x, tile.y);
        }
        // Blit offscreen to visible canvas
        const visibleCtx = canvasRef.current!.getContext("2d")!;
        visibleCtx.drawImage(offscreenRef.current, 0, 0);
      }
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const handleViewportChange = useCallback(async (newViewport: typeof viewportRef.current) => {
    viewportRef.current = newViewport;
    const frame = await invoke<{ tiles: (RawTile | null)[] }>("update_viewport", { viewport: newViewport });
    // Draw immediately-available tiles; None tiles show existing canvas content as placeholder
    const ctx = offscreenRef.current.getContext("2d")!;
    for (const tile of frame.tiles) {
      if (tile) {
        const imageData = new ImageData(
          new Uint8ClampedArray(tile.rgba_bytes), tile.width, tile.height
        );
        ctx.putImageData(imageData, tile.x, tile.y);
      }
    }
    const visibleCtx = canvasRef.current!.getContext("2d")!;
    visibleCtx.drawImage(offscreenRef.current, 0, 0);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", cursor: "crosshair" }}
      onWheel={/* zoom: update viewport.zoom, call handleViewportChange */}
      onMouseDown={/* pan start: record mouse origin */}
      onMouseMove={/* pan move: update panX/panY, call handleViewportChange */}
      onMouseUp={/* pan end */}
    />
  );
}
```

### Frontend rules
- Never decode PDF in JS. The canvas only receives pre-rendered RGBA bytes from Rust.
- Debounce wheel events — fire at most once per animation frame.
- For tiles that return `null` from `update_viewport`, leave the existing canvas content in place as a placeholder. Never clear to white.
- All zoom/pan state lives in Rust. The frontend is stateless with respect to document position.

---

## Thread Architecture

```
Main Thread (Tauri / OS event loop)
│
├── Tauri Command Thread (async Tokio)
│     Receives invoke() calls from frontend
│     Reads tile cache — use try_lock(), never block
│     Returns raw RGBA bytes directly, no encoding
│
├── Worker Thread × N  (N = logical_cpus - 2, minimum 2)
│     Each thread owns its own pdfium instance + document handle
│     Receives RenderRequest from shared channel
│     Sends completed TileData to completion channel
│
└── Completion Collector Thread
      Receives TileData from worker threads
      Inserts into LRU tile cache
```

**Rule:** Use `try_lock()` instead of `lock()` on any mutex touched by the render or command threads. A contested lock returns `None` for that tile — the frontend will receive it on the next poll.

---

## Performance Requirements & Benchmarks

Benchmarks must produce real measured numbers, not compile-only skeletons.

| Benchmark | Target |
|---|---|
| Single A0 page initial tile queue fill | < 50ms |
| Single 512×512 tile render (pdfium) | < 30ms |
| Tile cache lookup | < 1ms |
| Viewport tile list calculation | < 2ms |
| 100 tile renders (parallel worker pool) | < 500ms |
| Page navigation (first tiles visible) | < 100ms |

```bash
cargo bench --package bench
cargo install flamegraph
cargo flamegraph --package bench --bench render_bench
```

---

## Error Handling Policy

- pdfium errors: log with `tracing::error!`, return `Err(String)` to frontend
- Corrupted PDF: surface error dialog via `tauri-plugin-dialog`
- Tile render failure: substitute a solid red tile so the broken region is visible
- Memory pressure: if cached tile count approaches `MAX_CACHED_TILES`, evict aggressively via LRU

---

## Implementation Order

Implement in this order without stopping between steps:

1. Workspace `Cargo.toml` and all three package `Cargo.toml` files
2. `core/src/viewport/state.rs` — ViewportState, visible_tiles, screen_to_page
3. `core/src/pdf/document.rs` — DocumentMeta, PageMeta, init_pdfium (dynamic path)
4. `core/src/pdf/page.rs` — page dimension helpers
5. `core/src/pdf/tile_manager.rs` — TileKey, TileData, TileManager, RenderRequest
6. `core/src/render/worker.rs` — start_worker_pool, render_tile (one pdfium per thread)
7. `core/src/render/compositor.rs` — tile layout and viewport position calculation
8. `core/src/lib.rs` — public exports
9. `desktop/src/main.rs` — AppState, all three Tauri commands, pdfium path resolution
10. `desktop/tauri.conf.json` — resource bundling, window config
11. `desktop/src-frontend/` — all frontend files including vite.config.ts and tsconfig.json
12. `bench/benches/render_bench.rs` — all benchmarks with real implementations
13. `README.md` — pdfium binary filenames per platform, build instructions

---

## Definition of Done

Report against every item when implementation is complete:

- [ ] `cargo build --release` completes without errors or warnings
- [ ] `cargo tauri dev` launches a window successfully
- [ ] pdfium library loads correctly via dynamic path resolution
- [ ] PDF file open dialog works and returns DocumentMeta to frontend
- [ ] First page of a multi-page PDF renders within 200ms of open
- [ ] Pan (mouse drag) sustains 60fps with no visual tearing
- [ ] Zoom (scroll wheel) re-tiles within 300ms, showing existing tiles as placeholder during re-render
- [ ] Page navigation works for documents up to 500 pages
- [ ] `cargo bench` runs and all benchmarks produce measured numbers within targets
- [ ] No memory leak over 30 minutes of pan/zoom (validate approach and document how to verify)
- [ ] `cargo tauri build` produces a distributable installer with pdfium bundled
- [ ] `README.md` documents all manual setup steps required before building

---

## Out of Scope

Do not implement in Phase 1:

- skia-safe or any GPU compositing
- Vector extraction from PDF content streams
- Snap engine or R*-tree indexing
- Annotation or drawing tools
- Measurement or takeoff tools
- SQLite or cost estimation
- OCR or scale detection
- Print functionality
- Automated pdfium binary download in build.rs

---

## References

- pdfium-render: https://docs.rs/pdfium-render
- pdfium binaries: https://github.com/bblanchon/pdfium-binaries/releases
- Tauri v2 commands: https://tauri.app/develop/calling-rust
- Tauri v2 resource bundling: https://tauri.app/develop/resources
- rayon: https://docs.rs/rayon
- criterion: https://bheisler.github.io/criterion.rs/book/
