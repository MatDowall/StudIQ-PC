# Milestone 4a Handover

Date: 2026-06-01

Project path: `C:\Users\Admin\Documents\Take-it-Off`

## Current Status

Milestone 4 is functionally passable for a single-page PDF: the user confirmed the PDF is visible and pan/zoom works.

Milestone 4a was added because the user wanted to test multi-page navigation before moving to Milestone 5. The page selector is now working well after moving PDF rendering out of the Tauri app process.

Do not proceed to Milestone 5 until the user explicitly confirms Milestone 4a is stable enough for multi-page navigation testing.

## Why Milestone 4a Was Needed

The original Milestone 4 proved pan/zoom on a lightweight one-page PDF, but that was not enough confidence for a CAD/takeoff viewer. The user correctly raised that multi-page, heavier, vector-heavy PDFs need to navigate without:

- app hangs
- full-app crashes
- white canvases
- tearing/splitting
- visible tile-grid artifacts

The immediate Milestone 4a goal became: add page selection and make page changes stable enough to test real multi-page PDFs.

## Important Spec Constraint Change

The original Phase 1 spec said:

- base64 PNG tile transfer was acceptable
- no raw byte IPC
- no Skia
- no GPU compositing beyond normal webview behavior
- PDF rendering happens inside the app worker threads

Those constraints became too limiting for the product requirement. We relaxed the architecture while still keeping:

- `pdfium-render` as the only PDF library
- no Skia
- no new PDF library
- React/Tauri app shell

The major change is that PDFium rendering is now isolated in a child process.

## Current Architecture

The app is now split into two executables:

1. `desktop.exe`
   - Tauri app.
   - Owns UI, toolbar, page selector, canvas compositor, tile cache state.
   - Does not perform preview/tile PDF rendering directly.

2. `pdf_renderer.exe`
   - New helper binary in `core/src/bin/pdf_renderer.rs`.
   - Loads `pdfium.dll`.
   - Renders one preview or one tile to a PNG file.
   - Exits after each render request.

This is intentionally conservative. Process-per-render is not the final performance architecture, but it gives a crash boundary: if PDFium faults, `pdf_renderer.exe` can die without taking down `desktop.exe`.

## Rendering Flow

Preview:

1. User opens/selects a page.
2. Frontend invokes `render_preview`.
3. `desktop.exe` spawns:
   `pdf_renderer.exe preview <pdfium-dir> <pdf-path> <page> <max-dim> <output-path>`
4. Renderer writes `preview_page_N.png` to the app tile cache directory.
5. Renderer prints JSON:
   `{ page, width, height, image_path }`
6. Frontend loads that file through Tauri asset protocol and draws it onto a canvas.

Tiles:

1. Frontend sends viewport to `update_viewport`.
2. Rust computes visible 512x512 tile keys.
3. Tile worker spawns:
   `pdf_renderer.exe tile <pdfium-dir> <pdf-path> <page> <dpi> <tile-x> <tile-y> <output-path>`
4. Renderer writes the tile PNG.
5. Frontend loads tile image through the asset protocol and draws it over the preview on one canvas.

## Frontend State

Main file:

`desktop/src-frontend/src/components/Viewer.tsx`

Current behavior:

- Single `<canvas>` compositor.
- No DOM `<img>` grid for the page view.
- Page selector added:
  - `Prev`
  - `Next`
  - page dropdown
- Page change resets:
  - pan to `{ x: 0, y: 0 }`
  - zoom to `1`
- Preview cache is keyed by page number.
- Tile cache is keyed by page/zoom/tile.
- Canvas redraw is tied to image load completion through `imageVersion`.
- Wheel handling uses a native non-passive listener so cursor-centered zoom can call `preventDefault()`.

## Backend State

Important files:

- `core/src/bin/pdf_renderer.rs`
- `core/src/render/worker.rs`
- `core/src/pdf/tile_manager.rs`
- `desktop/src/lib.rs`
- `desktop/tauri.conf.json`
- `desktop/Cargo.toml`

Important implementation details:

- `TileData` now carries `image_path`, not base64 image data.
- `RenderRequest` carries:
  - `pdf_path`
  - `lib_path`
  - `cache_dir`
  - `renderer_path`
  - tile key
  - DPI
  - generation
- `desktop/src/lib.rs` resolves `renderer_path` using:
  `std::env::current_exe().with_file_name("pdf_renderer.exe")`
- In debug builds this expects:
  `target/debug/pdf_renderer.exe`
  beside:
  `target/debug/desktop.exe`

## Tauri Asset Protocol

File-backed preview/tile images initially produced white canvas and console errors:

`Failed to load resource: net::ERR_CONNECTION_REFUSED`

Cause: cached PNGs were being loaded as raw Windows paths instead of through Tauri's asset protocol.

Fixes:

- `desktop/Cargo.toml`
  - enabled Tauri feature:
    `protocol-asset`

- `desktop/tauri.conf.json`
  - enabled:
    `app.security.assetProtocol`
  - scoped:
    `$APPLOCALDATA/tiles/**`
    `$APPCACHE/tiles/**`

Frontend uses `convertFileSrc(imagePath)`.

## Failed Approaches

### 1. DOM image tile grid

Symptoms:

- visible tile splitting
- white regions during zoom/pan
- tile layers from different zoom buckets appearing together
- jittery zoom

Diagnosis:

React DOM image elements were the wrong compositor for a CAD-like PDF viewer. The viewer needed a stable single drawing surface.

Fix:

Replaced DOM tile grid with one canvas compositor.

### 2. Full-page / batch tile attempts

Symptoms:

- worked after cache filled
- initial white space
- hangs/non-responsiveness

Diagnosis:

Too much synchronous rendering and cache fill work in the app path.

Fix:

Backed away from synchronous full-page batching.

### 3. Raw PDFium FFI tile renderer inside `desktop.exe`

Symptoms:

- crashes during page switching

Windows crash event:

```text
Faulting application name: desktop.exe
Faulting module name: pdfium.dll
Exception code: 0x80000003
Fault offset: 0x000000000136ecb2
Faulting module path: ...\target\debug\libs\pdfium\pdfium.dll
```

Diagnosis:

The unsafe direct `FPDF_RenderPageBitmap` path was unstable in-process.

Fix:

Removed raw FFI from the active path.

### 4. Serialized in-process `pdfium-render`

Symptoms:

- still crashed `desktop.exe`
- latest crash again showed:
  `Faulting module name: pdfium.dll`

Diagnosis:

Even the safe wrapper can still trigger a native PDFium process crash for this workflow/document/path. In-process rendering cannot be trusted for product stability.

Fix:

Moved preview/tile rendering into `pdf_renderer.exe`.

## Verification So Far

Known passed commands after the external renderer change:

```powershell
cargo check --package desktop
cargo check --package core --bin pdf_renderer
npm.cmd run build
cargo build --package core --bin pdf_renderer
cargo build --package desktop
```

User reported after the external renderer build:

```text
thats working well
```

This refers to multi-page switching after moving PDF rendering out of process.

## Current Known Tradeoffs

The current design is stable-first, not final-performance.

Tradeoffs:

- Spawns one renderer process per preview/tile.
- This is slower than a persistent render service.
- But it protects the Tauri UI process from PDFium crashes.

Recommended next architecture step:

- Replace process-per-tile with a persistent renderer service process.
- Communicate via stdin/stdout JSON lines, local sockets, or named pipes.
- Keep PDFium isolated from `desktop.exe`.
- Add request cancellation/generation in that renderer service.
- Add a proper multi-resolution page cache.

Do not move PDFium rendering back into `desktop.exe`.

## Commands To Run For Future Testing

Build both executables:

```powershell
cargo build --package core --bin pdf_renderer
cargo build --package desktop
```

Launch:

```powershell
Start-Process -FilePath "C:\Users\Admin\Documents\Take-it-Off\target\debug\desktop.exe" -WorkingDirectory "C:\Users\Admin\Documents\Take-it-Off"
```

The app expects:

```text
C:\Users\Admin\Documents\Take-it-Off\target\debug\desktop.exe
C:\Users\Admin\Documents\Take-it-Off\target\debug\pdf_renderer.exe
C:\Users\Admin\Documents\Take-it-Off\target\debug\libs\pdfium\pdfium.dll
```

## Next Milestone Guidance

Before Milestone 5:

1. Keep testing Milestone 4a with multi-page PDFs.
2. Confirm the app no longer closes when switching pages.
3. Confirm page switching is acceptable enough for Phase 1.
4. If page switching is too slow, improve the renderer service architecture, not the UI.

Milestone 5 should only add formal multi-page navigation/sidebar once this page-selector test proves the rendering lifecycle is stable.
