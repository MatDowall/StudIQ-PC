# Phase 1 Handover: PDF Core Engine — v2
## Desktop CAD/Takeoff Application — Rust + Tauri + React

---

## How To Use This Document

This spec is structured as **five sequential milestones**. Each milestone ends with a verification step that produces visible, testable proof before any work on the next milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

If a verification step fails, stop, diagnose, and fix before continuing. Do not accumulate failures across milestones — a failure in Milestone 1 will disguise itself as a different failure in Milestone 4.

---

## Decisions Already Made — Do Not Revisit

- **PDF rendering library:** `pdfium-render` only. No other PDF library.
- **Tile transfer over IPC:** base64-encoded PNG strings in Milestone 3. Optimise to raw bytes only after rendering is confirmed working end to end.
- **Skia:** Not used in Phase 1. Do not add `skia-safe`.
- **pdfium thread strategy:** Each worker thread owns its own pdfium instance. `PdfDocument` is not `Send` — do not share it across threads.
- **pdfium path:** Always resolved dynamically at runtime via Tauri's `app.path().resource_dir()`. Never hardcoded.
- **Tile size:** 512×512 pixels.
- **Frontend tooling:** Generate standard `vite.config.ts` and `tsconfig.json` for Tauri v2 + React + TypeScript.
- **Icons:** Generate with `npx @tauri-apps/cli icon` using any square PNG as source.
- **pdfium binary:** Manually placed in `./libs/pdfium/` by the developer before running.

---

## Critical Tauri v2 Rules — Read Before Writing Any Code

These are the most common failure points in Tauri v2 projects. Each one will produce a blank screen or silent failure with no obvious error message.

**Rule 1 — `main.rs` must be a thin wrapper only.**
Tauri v2 requires the application logic to live in `lib.rs`. `main.rs` must contain only this exact content:

```rust
// desktop/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    desktop_lib::run();
}
```

All `AppState`, commands, and `tauri::Builder` code goes in `desktop/src/lib.rs`. Do not put any of this in `main.rs`.

**Rule 2 — Capabilities file is mandatory for any plugin access.**
Tauri v2 uses a capabilities system. Without it, `dialog::open` and filesystem access will fail silently. The file `desktop/capabilities/default.json` must exist and must list every permission used. The exact content is specified later in this document. Do not omit this file.

**Rule 3 — `tauri.conf.json` must use v2 syntax only.**
Tauri v2 does not use `allowlist`. Do not write any `tauri.allowlist` configuration. The `bundle.resources` syntax in v2 is an object mapping source paths to destination paths — not an array. Use exactly the format shown in this document.

**Rule 4 — TypeScript `invoke()` types must exactly match Rust return types.**
Every `invoke<T>()` call in TypeScript must use a type that exactly matches what the corresponding Rust command returns after Serde serialisation. Mismatches fail silently — the frontend receives `undefined` with no error. For every Tauri command, the Rust return type and the TypeScript generic type are both specified in this document. Do not change either without changing both.

**Rule 5 — Plugin imports in TypeScript must use the plugin package, not core.**
File dialog must be imported from `@tauri-apps/plugin-dialog`, not from `@tauri-apps/api`. Using the wrong import produces a runtime error that looks like a permissions error.

```typescript
// CORRECT
import { open } from "@tauri-apps/plugin-dialog";

// WRONG — will fail
import { open } from "@tauri-apps/api/dialog";
```

**Rule 6 — `tauri-plugin-*` crates must be initialised in the builder.**
Every plugin used must be added to the Tauri builder with `.plugin(tauri_plugin_name::init())`. A plugin listed in `Cargo.toml` but not initialised in the builder will silently do nothing.

---

## Repository Structure

```
/
├── Cargo.toml                        (workspace root)
├── libs/
│   └── pdfium/
│       └── .gitkeep                  (developer places pdfium binary here)
├── core/
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── pdf/
│       │   ├── mod.rs
│       │   ├── document.rs
│       │   ├── page.rs
│       │   └── tile_manager.rs
│       ├── render/
│       │   ├── mod.rs
│       │   ├── worker.rs
│       │   └── compositor.rs
│       └── viewport/
│           ├── mod.rs
│           └── state.rs
├── desktop/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   └── src/
│       ├── main.rs
│       └── lib.rs
├── desktop/src-frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       └── components/
│           ├── Viewer.tsx
│           ├── Toolbar.tsx
│           └── PageList.tsx
└── README.md
```

---

## Dependencies

### `Cargo.toml` (workspace root)
```toml
[workspace]
members = ["core", "desktop"]
resolver = "2"
```

### `core/Cargo.toml`
```toml
[package]
name = "core"
version = "0.1.0"
edition = "2021"

[dependencies]
pdfium-render = { version = "0.8", features = ["thread_safe"] }
crossbeam-channel = "0.5"
parking_lot = "0.12"
lru = "0.12"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
base64 = "0.22"
image = { version = "0.25", features = ["png"] }
```

### `desktop/Cargo.toml`
```toml
[package]
name = "desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
core = { path = "../core" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
parking_lot = "0.12"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

### `desktop/src-frontend/package.json`
```json
{
  "name": "pdf-cad-frontend",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "@tauri-apps/cli": "^2.0.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

---

## pdfium Developer Setup

Before running any milestone, the developer must:

1. Download the pdfium binary from `https://github.com/bblanchon/pdfium-binaries/releases`
2. Place it in `./libs/pdfium/` with the exact filename:
   - Windows: `pdfium.dll`
   - macOS: `libpdfium.dylib`
   - Linux: `libpdfium.so`
3. Run `npm install` inside `desktop/src-frontend/`
4. Generate icons: `cd desktop && npx @tauri-apps/cli icon ../assets/icon.png`
   (create a plain 512×512 PNG as `assets/icon.png` if one does not exist)

Document these steps in `README.md`.

---

## MILESTONE 1 — pdfium Loads and Reads a PDF

**Goal:** Prove that pdfium initialises correctly and can open a PDF file. Nothing visual yet — proof is in the terminal output.

### What to implement

A standalone Rust binary in `core` that:
1. Initialises pdfium from a hardcoded path (for this milestone only)
2. Opens a hardcoded test PDF path passed as a command line argument
3. Prints page count and page dimensions to stdout
4. Exits cleanly

```rust
// core/src/bin/milestone1.rs

use pdfium_render::prelude::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pdf_path = args.get(1).expect("Usage: milestone1 <path-to-pdf>");
    let lib_path = args.get(2).expect("Usage: milestone1 <path-to-pdf> <path-to-pdfium-dir>");

    println!("Loading pdfium from: {}", lib_path);

    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(lib_path)
        ).expect("FAILED: Could not load pdfium library. Check the path and filename.")
    );

    println!("SUCCESS: pdfium loaded");

    let document = pdfium.load_pdf_from_file(pdf_path, None)
        .expect("FAILED: Could not open PDF. Check the file path.");

    let page_count = document.pages().len();
    println!("SUCCESS: PDF opened — {} pages", page_count);

    for i in 0..page_count.min(5) {
        let page = document.pages().get(i).unwrap();
        let (w, h) = (page.width().value, page.height().value);
        println!("  Page {}: {:.1} x {:.1} pts  ({:.1} x {:.1} mm)",
            i, w, h, w * 0.352778, h * 0.352778);
    }

    println!("Milestone 1 PASSED");
}
```

Add to `core/Cargo.toml`:
```toml
[[bin]]
name = "milestone1"
path = "src/bin/milestone1.rs"
```

### Verification command
```bash
cargo run --package core --bin milestone1 -- /path/to/test.pdf ./libs/pdfium
```

### Expected terminal output
```
Loading pdfium from: ./libs/pdfium
SUCCESS: pdfium loaded
SUCCESS: PDF opened — 12 pages
  Page 0: 841.9 x 595.3 pts  (297.0 x 210.0 mm)
  ...
Milestone 1 PASSED
```

### Gate
**Do not proceed to Milestone 2 until this output is confirmed in the terminal.**
If it fails at "Could not load pdfium library" — the binary filename or path is wrong.
If it fails at "Could not open PDF" — the PDF path is wrong or the file is corrupted.

---

## MILESTONE 2 — Single Tile Renders to a PNG File on Disk

**Goal:** Prove that pdfium can render a tile of a PDF page and save it as a real PNG file that can be opened and inspected. Nothing visual in the app yet — proof is opening the PNG file.

### What to implement

A second standalone binary that:
1. Opens a PDF using the working Milestone 1 approach
2. Renders a single 512×512 tile from the top-left of page 0
3. Saves it as `milestone2_tile.png` in the current directory
4. Prints success confirmation

```rust
// core/src/bin/milestone2.rs

use pdfium_render::prelude::*;
use image::{ImageBuffer, Rgba};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pdf_path = args.get(1).expect("Usage: milestone2 <pdf-path> <pdfium-dir>");
    let lib_path = args.get(2).expect("Usage: milestone2 <pdf-path> <pdfium-dir>");

    let pdfium = Pdfium::new(
        Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(lib_path)
        ).expect("Could not load pdfium")
    );

    let document = pdfium.load_pdf_from_file(pdf_path, None)
        .expect("Could not open PDF");

    let page = document.pages().get(0).expect("No pages");

    // Render the full first page at 150 DPI into a bitmap
    let render_config = PdfRenderConfig::new()
        .set_target_width(512)
        .set_target_height(512);

    println!("Rendering tile...");
    let bitmap = page.render_with_config(&render_config)
        .expect("Render failed");

    let rgba_bytes = bitmap.as_rgba_bytes();
    println!("Rendered {} bytes of RGBA data", rgba_bytes.len());

    // Save as PNG
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
        bitmap.width() as u32,
        bitmap.height() as u32,
        rgba_bytes.to_vec(),
    ).expect("Failed to create image buffer");

    img.save("milestone2_tile.png").expect("Failed to save PNG");

    println!("SUCCESS: Tile saved to milestone2_tile.png");
    println!("Open this file now and confirm it shows a portion of the PDF.");
    println!("Milestone 2 PASSED");
}
```

Add to `core/Cargo.toml`:
```toml
[[bin]]
name = "milestone2"
path = "src/bin/milestone2.rs"
```

### Verification command
```bash
cargo run --package core --bin milestone2 -- /path/to/test.pdf ./libs/pdfium
```

Then open `milestone2_tile.png` in any image viewer.

### Gate
**Do not proceed to Milestone 3 until the PNG file is opened and shows recognisable PDF content.**
A blank white PNG means the render config is wrong.
A missing file means the save step failed — check write permissions.

---

## MILESTONE 3 — Single Tile Appears in the App Window

**Goal:** The Tauri app launches, a file picker opens, and a single rendered tile appears on the canvas. Pan and zoom are not required yet. Proof is seeing PDF content in the app window.

### Core library — implement these files

**`core/src/pdf/document.rs`**
```rust
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct DocumentMeta {
    pub path: String,
    pub page_count: u32,
    pub pages: Vec<PageMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageMeta {
    pub index: u32,
    pub width_pts: f64,
    pub height_pts: f64,
}

pub fn init_pdfium(lib_path: &str) -> Pdfium {
    Pdfium::new(
        Pdfium::bind_to_library(
            Pdfium::pdfium_platform_library_name_at_path(lib_path)
        ).expect("Failed to load pdfium library")
    )
}

pub fn load_document_meta(pdfium: &Pdfium, path: &str) -> Result<DocumentMeta, String> {
    let doc = pdfium.load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF: {e}"))?;

    let pages: Vec<PageMeta> = (0..doc.pages().len())
        .map(|i| {
            let page = doc.pages().get(i as u16).unwrap();
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
```

**`core/src/render/worker.rs`** — simplified single-tile render for Milestone 3
```rust
use pdfium_render::prelude::*;
use base64::{Engine as _, engine::general_purpose};
use image::{ImageBuffer, Rgba};
use std::io::Cursor;

pub fn render_page_tile_base64(
    lib_path: &str,
    pdf_path: &str,
    page_index: u32,
    target_width: u32,
    target_height: u32,
) -> Result<String, String> {
    let pdfium = crate::pdf::document::init_pdfium(lib_path);
    let doc = pdfium.load_pdf_from_file(pdf_path, None)
        .map_err(|e| format!("Open failed: {e}"))?;

    let page = doc.pages().get(page_index as u16)
        .map_err(|e| format!("Page not found: {e}"))?;

    let config = PdfRenderConfig::new()
        .set_target_width(target_width as i32)
        .set_target_height(target_height as i32);

    let bitmap = page.render_with_config(&config)
        .map_err(|e| format!("Render failed: {e}"))?;

    let rgba = bitmap.as_rgba_bytes().to_vec();
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
        bitmap.width() as u32,
        bitmap.height() as u32,
        rgba,
    ).ok_or("Failed to build image buffer")?;

    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(&png_bytes)
    ))
}
```

### Tauri commands — `desktop/src/lib.rs`

```rust
use tauri::State;
use parking_lot::Mutex;
use std::sync::Arc;
use core::pdf::document::{DocumentMeta, load_document_meta, init_pdfium};
use core::render::worker::render_page_tile_base64;

pub struct AppState {
    pub pdfium_lib_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
}

#[tauri::command]
pub fn open_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentMeta, String> {
    let pdfium = init_pdfium(&state.pdfium_lib_path);
    let meta = load_document_meta(&pdfium, &path)?;
    *state.open_document.lock() = Some(meta.clone());
    Ok(meta)
}

#[tauri::command]
pub fn render_page(
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let doc_path = {
        let guard = state.open_document.lock();
        guard.as_ref()
            .ok_or("No document open")?
            .path.clone()
    };

    render_page_tile_base64(
        &state.pdfium_lib_path,
        &doc_path,
        page_index,
        1024,   // render at 1024px wide for Milestone 3
        1024,
    )
}

pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // Resolve pdfium path relative to resource directory
            let resource_dir = app.path().resource_dir()
                .expect("Could not resolve resource directory");
            let pdfium_lib_path = resource_dir
                .join("libs")
                .join("pdfium")
                .to_string_lossy()
                .to_string();

            tracing::info!("pdfium path: {}", pdfium_lib_path);

            app.manage(AppState {
                pdfium_lib_path,
                open_document: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_document,
            render_page,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Frontend — `Viewer.tsx` for Milestone 3

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface DocumentMeta {
  path: string;
  page_count: number;
  pages: { index: number; width_pts: number; height_pts: number }[];
}

export function Viewer() {
  const [doc, setDoc] = useState<DocumentMeta | null>(null);
  const [tileDataUrl, setTileDataUrl] = useState<string | null>(null);
  const [status, setStatus] = useState("No document open");

  async function handleOpen() {
    const selected = await open({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;

    setStatus("Opening document...");
    try {
      const meta = await invoke<DocumentMeta>("open_document", { path: selected });
      setDoc(meta);
      setStatus(`Opened: ${meta.page_count} pages. Rendering page 1...`);

      const dataUrl = await invoke<string>("render_page", { pageIndex: 0 });
      setTileDataUrl(dataUrl);
      setStatus("Rendered successfully");
    } catch (e) {
      setStatus(`ERROR: ${e}`);
      console.error(e);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#1e1e1e" }}>
      <div style={{ padding: "8px", background: "#2b2b2b", color: "#ccc", display: "flex", gap: "12px", alignItems: "center" }}>
        <button onClick={handleOpen} style={{ padding: "4px 12px", cursor: "pointer" }}>
          Open PDF
        </button>
        <span style={{ fontSize: "12px" }}>{status}</span>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" }}>
        {tileDataUrl ? (
          <img src={tileDataUrl} style={{ maxWidth: "100%", maxHeight: "100%" }} alt="PDF render" />
        ) : (
          <span style={{ color: "#555" }}>Open a PDF to begin</span>
        )}
      </div>
    </div>
  );
}
```

### Verification
```bash
cd desktop/src-frontend && npm install
cd ../.. && cargo tauri dev
```

Click "Open PDF", select any PDF file.

### Gate
**Do not proceed to Milestone 4 until PDF content is visible in the app window.**
If the status shows "ERROR:" — copy the exact error text and fix it before continuing.
If the window opens but nothing renders — check browser devtools console (F12) for JS errors.

---

## MILESTONE 4 — Full Tile Pipeline with Pan and Zoom

**Goal:** Replace the single full-page render from Milestone 3 with the proper 512×512 tile pipeline. Pan and zoom must sustain 60fps.

### Implement the full tile system

**`core/src/viewport/state.rs`**
```rust
use serde::{Deserialize, Serialize};
use crate::pdf::tile_manager::TileKey;

pub const TILE_SIZE_PX: u32 = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewportState {
    pub page_index: u32,
    pub zoom: f64,       // 1.0 = 100%
    pub pan_x: f64,      // pixels scrolled from left
    pub pan_y: f64,      // pixels scrolled from top
    pub width: u32,      // viewport width in screen pixels
    pub height: u32,     // viewport height in screen pixels
}

impl ViewportState {
    /// Returns TileKeys for all tiles visible in the current viewport,
    /// ordered from centre outward for priority rendering.
    pub fn visible_tiles(&self, page_width_px: u32, page_height_px: u32) -> Vec<TileKey> {
        let cols = (page_width_px + TILE_SIZE_PX - 1) / TILE_SIZE_PX;
        let rows = (page_height_px + TILE_SIZE_PX - 1) / TILE_SIZE_PX;

        let vp_left = self.pan_x as u32;
        let vp_top = self.pan_y as u32;
        let vp_right = vp_left + self.width;
        let vp_bottom = vp_top + self.height;

        let start_col = (vp_left / TILE_SIZE_PX).min(cols);
        let end_col = ((vp_right + TILE_SIZE_PX - 1) / TILE_SIZE_PX).min(cols);
        let start_row = (vp_top / TILE_SIZE_PX).min(rows);
        let end_row = ((vp_bottom + TILE_SIZE_PX - 1) / TILE_SIZE_PX).min(rows);

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
        keys
    }

    pub fn zoom_bucket(zoom: f64) -> u8 {
        match zoom {
            z if z <= 0.3 => 0,
            z if z <= 0.6 => 1,
            z if z <= 1.25 => 2,
            z if z <= 2.5 => 3,
            _ => 4,
        }
    }

    pub fn page_width_px(&self, width_pts: f64) -> u32 {
        (width_pts * self.zoom * 96.0 / 72.0) as u32
    }

    pub fn page_height_px(&self, height_pts: f64) -> u32 {
        (height_pts * self.zoom * 96.0 / 72.0) as u32
    }
}
```

**`core/src/pdf/tile_manager.rs`**
```rust
use lru::LruCache;
use parking_lot::Mutex;
use std::sync::Arc;
use std::num::NonZeroUsize;
use crossbeam_channel::{Sender, Receiver};
use serde::{Deserialize, Serialize};

pub const TILE_SIZE_PX: u32 = 512;
const MAX_CACHED_TILES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TileKey {
    pub page: u32,
    pub zoom_level: u8,
    pub tile_x: u32,
    pub tile_y: u32,
}

#[derive(Debug, Clone)]
pub struct TileData {
    pub key: TileKey,
    pub data_url: String,   // base64 PNG data URL
    pub x: u32,             // pixel offset in page coords
    pub y: u32,
}

pub struct RenderRequest {
    pub key: TileKey,
    pub pdf_path: String,
    pub lib_path: String,
    pub dpi: f32,
}

pub struct TileManager {
    cache: Arc<Mutex<LruCache<TileKey, TileData>>>,
    render_tx: Sender<RenderRequest>,
    pub completion_rx: Receiver<TileData>,
}

impl TileManager {
    pub fn new(render_tx: Sender<RenderRequest>, completion_rx: Receiver<TileData>) -> Self {
        Self {
            cache: Arc::new(Mutex::new(
                LruCache::new(NonZeroUsize::new(MAX_CACHED_TILES).unwrap())
            )),
            render_tx,
            completion_rx,
        }
    }

    /// Insert a completed tile into the cache
    pub fn insert(&self, tile: TileData) {
        self.cache.lock().put(tile.key, tile);
    }

    /// Get cached tile or queue a render request. Returns None if not yet rendered.
    pub fn get_or_queue(&self, key: TileKey, pdf_path: &str, lib_path: &str) -> Option<TileData> {
        let mut cache = self.cache.lock();
        if let Some(tile) = cache.get(&key) {
            return Some(tile.clone());
        }
        // Queue render — ignore send error if channel is full
        let dpi = 96.0 * 2f32.powi(key.zoom_level as i32 - 2);
        let _ = self.render_tx.try_send(RenderRequest {
            key,
            pdf_path: pdf_path.to_string(),
            lib_path: lib_path.to_string(),
            dpi: dpi.max(48.0),
        });
        None
    }

    pub fn invalidate_zoom(&self, zoom_level: u8) {
        self.cache.lock().retain(|k, _| k.zoom_level != zoom_level);
    }

    pub fn drain_completed(&self) -> Vec<TileData> {
        let mut results = Vec::new();
        while let Ok(tile) = self.completion_rx.try_recv() {
            self.insert(tile.clone());
            results.push(tile);
        }
        results
    }
}
```

**`core/src/render/worker.rs`** — full threaded worker pool
```rust
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use std::sync::Arc;
use pdfium_render::prelude::*;
use image::{ImageBuffer, Rgba};
use base64::{Engine as _, engine::general_purpose};
use std::io::Cursor;
use crate::pdf::tile_manager::{RenderRequest, TileData, TILE_SIZE_PX};
use crate::pdf::document::init_pdfium;

pub fn start_worker_pool(
    num_threads: usize,
    render_rx: Receiver<RenderRequest>,
    completion_tx: Sender<TileData>,
) {
    let render_rx = Arc::new(Mutex::new(render_rx));

    for _ in 0..num_threads {
        let rx = Arc::clone(&render_rx);
        let tx = completion_tx.clone();

        std::thread::spawn(move || {
            // Each thread holds its own pdfium instance — PdfDocument is not Send
            let mut current_path: Option<String> = None;
            let mut pdfium_opt: Option<Pdfium> = None;
            let mut doc_opt: Option<PdfDocument> = None;

            loop {
                let request: RenderRequest = {
                    match rx.lock().recv() {
                        Ok(r) => r,
                        Err(_) => break,
                    }
                };

                // Re-open document if path changed
                if current_path.as_deref() != Some(&request.pdf_path) {
                    let pdfium = init_pdfium(&request.lib_path);
                    match pdfium.load_pdf_from_file(&request.pdf_path, None) {
                        Ok(doc) => {
                            current_path = Some(request.pdf_path.clone());
                            doc_opt = Some(doc);
                            pdfium_opt = Some(pdfium);
                        }
                        Err(e) => {
                            tracing::error!("Worker failed to open PDF: {}", e);
                            continue;
                        }
                    }
                }

                if let Some(doc) = &doc_opt {
                    match render_tile(doc, &request) {
                        Ok(tile) => { let _ = tx.send(tile); }
                        Err(e) => tracing::error!("Tile render failed: {}", e),
                    }
                }
            }
        });
    }
}

fn render_tile(doc: &PdfDocument, req: &RenderRequest) -> Result<TileData, String> {
    let page = doc.pages().get(req.key.page as u16)
        .map_err(|e| format!("Page {} not found: {}", req.key.page, e))?;

    let tile_px_x = req.key.tile_x * TILE_SIZE_PX;
    let tile_px_y = req.key.tile_y * TILE_SIZE_PX;

    // Calculate what portion of the page this tile covers in PDF points
    let scale = req.dpi / 72.0;
    let page_w_pts = page.width().value;
    let page_h_pts = page.height().value;

    let clip_left = (tile_px_x as f32 / scale).min(page_w_pts);
    let clip_top = (tile_px_y as f32 / scale).min(page_h_pts);
    let clip_right = ((tile_px_x + TILE_SIZE_PX) as f32 / scale).min(page_w_pts);
    let clip_bottom = ((tile_px_y + TILE_SIZE_PX) as f32 / scale).min(page_h_pts);

    if clip_left >= clip_right || clip_top >= clip_bottom {
        // Tile is outside page bounds — return transparent tile
        return Ok(TileData {
            key: req.key,
            data_url: empty_tile_data_url(),
            x: tile_px_x,
            y: tile_px_y,
        });
    }

    let config = PdfRenderConfig::new()
        .set_target_width(TILE_SIZE_PX as i32)
        .set_target_height(TILE_SIZE_PX as i32)
        .clip_page_to_bounding_box(clip_left, clip_top, clip_right, clip_bottom);

    let bitmap = page.render_with_config(&config)
        .map_err(|e| format!("Render error: {}", e))?;

    let rgba = bitmap.as_rgba_bytes().to_vec();
    let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(
        TILE_SIZE_PX, TILE_SIZE_PX, rgba
    ).ok_or("Buffer size mismatch")?;

    let mut png_bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode error: {}", e))?;

    Ok(TileData {
        key: req.key,
        data_url: format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&png_bytes)),
        x: tile_px_x,
        y: tile_px_y,
    })
}

fn empty_tile_data_url() -> String {
    // 1x1 transparent PNG, base64 encoded
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==".to_string()
}
```

### Verification
The app must render a full tiled view of a PDF page with working pan (mouse drag) and zoom (scroll wheel).

Open the app, load a PDF, and confirm:
- The full page is visible as a grid of tiles
- Dragging pans the view smoothly
- Scrolling zooms in and out
- No white flashes during pan/zoom

### Gate
**Do not proceed to Milestone 5 until pan and zoom feel smooth.**

---

## MILESTONE 5 — Multi-Page Navigation and Final Verification

**Goal:** Page navigation works. All Definition of Done items are confirmed.

### What to implement
- `PageList.tsx` — sidebar showing page thumbnails/numbers, clicking navigates to that page
- Page prefetch — when navigating, queue tile renders for the new page before the user sees it
- `Toolbar.tsx` — zoom in/out buttons, fit-to-page button, current page / total pages display

### Verification
Run the full Definition of Done checklist below.

---

## Tauri Configuration

### `desktop/tauri.conf.json`
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "PDF CAD",
  "version": "0.1.0",
  "identifier": "com.pdfcad.app",
  "build": {
    "frontendDist": "../src-frontend/dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "PDF CAD",
        "width": 1400,
        "height": 900,
        "resizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "resources": {
      "../libs/pdfium/*": "libs/pdfium/"
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

### `desktop/capabilities/default.json`
```json
{
  "$schema": "https://schema.tauri.app/capability/2",
  "identifier": "default",
  "description": "Default permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-all"
  ]
}
```

---

## Thread Architecture

```
Tauri Async Command Thread
  ├── open_document → loads metadata, stores in AppState
  ├── update_viewport → queries TileManager, returns cached tiles
  └── poll_tiles → drains TileManager.completion_rx, returns new tiles

TileManager (shared via Arc<Mutex<AppState>>)
  ├── LRU cache (256 tiles max)
  ├── render_tx → sends RenderRequests to worker pool
  └── completion_rx ← receives completed TileData from workers

Worker Thread × N  (N = max(2, logical_cpus - 2))
  Each thread:
  ├── Owns its own Pdfium instance
  ├── Owns its own PdfDocument handle
  └── Renders tiles and sends to completion channel
```

**Critical rules:**
- Use `try_send` not `send` when queuing render requests — never block the command thread
- Use `try_recv` not `recv` when draining completions — never block waiting
- Worker threads re-open the document when the path changes — they do not share documents

---

## Definition of Done

Report against every item when all five milestones are complete:

- [ ] Milestone 1 terminal output confirmed — pdfium loads and reads page count
- [ ] Milestone 2 PNG file confirmed — tile renders correctly to disk
- [ ] Milestone 3 app confirmed — PDF content visible in app window after file picker
- [ ] Milestone 4 confirmed — full tiled render with smooth 60fps pan and zoom
- [ ] Milestone 5 confirmed — page navigation works for multi-page PDFs
- [ ] `cargo build --release` completes without errors
- [ ] `cargo tauri build` produces a distributable installer with pdfium bundled
- [ ] No memory leak over 15 minutes of continuous pan/zoom (document approach used)
- [ ] `README.md` documents all manual setup steps

---

## Out of Scope

Do not implement in Phase 1:

- Skia or GPU compositing
- Raw byte IPC (base64 PNG is acceptable for Phase 1)
- Vector extraction or snap engine
- Annotation or drawing tools
- Measurement or takeoff tools
- SQLite or cost estimation
- Automated pdfium binary download
- Benchmark suite (deferred — get it working first)

---

## README.md Contents

Generate a README that includes:
1. Prerequisites (Rust, Node.js, pdfium binary)
2. Exact pdfium binary filename per platform
3. Step-by-step setup commands
4. How to run each milestone verification
5. How to run the full app in dev mode
6. How to build the installer
