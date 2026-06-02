# Phase 1.7 Implementation Handover

Date: 2026-06-02

Phase 1.7 replaced the previous process-per-render model with a persistent renderer service using stdin/stdout JSON-lines IPC. The change is internal to the Rust/Tauri backend and renderer process. No frontend files were changed, and no frontend-visible Tauri command signatures were changed.

## Outcome

Phase 1.7 is complete and verified.

- The renderer binary now runs as a persistent service.
- `desktop` no longer launches a fresh renderer process for `open_document`, preview renders, or tile renders.
- `desktop` no longer calls PDFium directly for `open_document`.
- PDFium remains isolated inside `pdf_renderer`.
- `worker_count` remains `1`.
- Renderer process lifecycle is tied to app/project lifecycle.
- Project open/close regression testing passed.
- MSI and NSIS installers were produced by `cargo tauri build`.
- The installed app launched, opened PDFs, and rendered tiles correctly.

## Files Changed

### `core/src/bin/pdf_renderer.rs`

Rewritten from a single-shot CLI into a persistent renderer service.

Implemented commands:

- `meta`
- `preview`
- `tile`
- `shutdown`
- `vectors`, returning the required Phase 1.7 stub error

The renderer now:

- Accepts the PDFium library file path as its only CLI argument.
- Initializes PDFium once at process startup.
- Reads UTF-8 JSON request objects from stdin, one request per line.
- Writes JSON response objects to stdout, one response per line.
- Writes logs/errors to stderr only.
- Returns response envelopes in the required shape:

```json
{ "id": 1, "ok": true, "data": {} }
{ "id": 1, "ok": false, "error": "..." }
```

The renderer handlers preserve the previous PDFium behavior for metadata, preview, and tile rendering, with one performance improvement added during Milestone 3: tile rendering now applies a PDFium clipping rectangle for the requested tile area. This avoids rendering the entire page for every 512px tile.

### `desktop/src/lib.rs`

Added `RendererService` and integrated it into `AppState`.

`RendererService` owns:

- `Child`
- `ChildStdin`
- `BufReader<ChildStdout>`
- `AtomicU64` request id counter

It provides:

- `spawn(renderer_path, pdfium_lib_path)`
- `request(payload)`
- `shutdown()`
- best-effort shutdown in `Drop`

Desktop lifecycle behavior:

- A startup renderer is spawned during Tauri `setup()`.
- `create_project` replaces any existing renderer with a fresh renderer.
- `open_project` replaces any existing renderer with a fresh renderer.
- `close_project` sends shutdown and waits for the renderer process before clearing project/document state.

Command behavior:

- `open_document` now sends a renderer `meta` request.
- `render_preview` now sends a renderer `preview` request.
- `update_viewport` now queues tile jobs for the persistent renderer service.
- `poll_tiles` continues to return completed tile data to the frontend.
- `add_drawing` and `add_drawing_to_folder_path` now read PDF metadata through the renderer service.

Platform handling:

- Windows renderer path resolves to `pdf_renderer.exe`.
- Non-Windows renderer path resolves to `pdf_renderer`.
- Windows PDFium library path resolves to `pdfium.dll`.
- macOS PDFium library path resolves to `libpdfium.dylib`.
- Linux fallback resolves to `libpdfium.so`.
- `CREATE_NO_WINDOW` remains Windows-only behind `#[cfg(target_os = "windows")]`.

### `core/src/render/worker.rs`

Removed the per-tile renderer process spawn path.

The previous worker thread logic launched:

```text
pdf_renderer tile ...
```

for each tile. That has been removed.

`create_tile_manager_with_workers()` remains for compatibility with existing call sites, but no longer starts renderer-spawning worker threads. Tile rendering is now driven from `desktop/src/lib.rs` through the persistent `RendererService`.

### `core/src/pdf/tile_manager.rs`

Extended to support renderer-service-driven tile scheduling.

Added:

- `TileQueueState`
- `get_cached_or_mark_queued()`
- `complete_render()`
- `fail_render()`
- completion sender storage

The existing cache, queued-tile tracking, generation handling, and completion polling model remain in place.

## IPC Protocol Implementation

Implemented request format:

```json
{ "id": 1, "cmd": "meta", "pdf_path": "..." }
{ "id": 2, "cmd": "preview", "pdf_path": "...", "page": 0, "max_dim": 1200, "output_path": "..." }
{ "id": 3, "cmd": "tile", "pdf_path": "...", "page": 0, "dpi": 96.0, "tile_x": 0, "tile_y": 0, "output_path": "...", "generation": 1 }
{ "id": 4, "cmd": "shutdown" }
```

Implemented response format:

```json
{ "id": 1, "ok": true, "data": {} }
{ "id": 1, "ok": false, "error": "..." }
```

`RendererService::request()` assigns request ids, serializes payloads, writes a newline-delimited JSON request, flushes stdin, then reads stdout lines until it finds the matching response id.

Phase 1.7 remains sequential from the desktop side. No response map or async dispatcher was implemented.

## Tile Rendering Architecture

The final tile path is:

1. Frontend calls existing `update_viewport`.
2. `desktop` calculates visible/prefetch tile keys.
3. `TileManager` returns cached tiles immediately or marks missing tiles as queued.
4. `desktop` sends tile jobs to a single Tokio `mpsc` worker.
5. The worker coalesces duplicate jobs and prioritizes the newest viewport batch.
6. The worker calls `RendererService::request()` with a `tile` request.
7. The renderer writes the tile PNG to disk.
8. `TileManager::complete_render()` pushes completed tile data through the existing completion channel.
9. Frontend receives completed tiles through the existing `poll_tiles` command.

This preserves the frontend polling model while removing per-tile process spawns.

## Viewport Prioritization

During manual Milestone 3 testing, tile rendering was technically correct but workflow was hindered because the queue behaved like FIFO. If the user zoomed or panned to an area whose tiles were low in the old queue, the worker continued rendering older prefetch tiles first.

Resolution:

- Each `update_viewport` call now creates a monotonically increasing `batch_id`.
- Tile jobs carry `batch_id` and an in-batch `order`.
- The single worker drains pending jobs, coalesces duplicates by tile key, and chooses the highest-priority job:
  - newest `batch_id` first
  - lower in-batch `order` first
- Already queued tiles can be re-submitted to refresh priority.

This keeps `worker_count = 1` while prioritizing the active viewport.

## Issues Encountered and Resolutions

### 1. PowerShell `Start-Process` failed during Milestone 1 verification

Error:

```text
Start-Process : Item has already been added. Key in dictionary: 'Path'  Key being added: 'PATH'
```

Diagnosis:

The shell environment had duplicate `Path`/`PATH` variables, and PowerShell rejected the environment dictionary before launching the renderer.

Resolution:

Used equivalent stdin/stdout redirection via `cmd /c` to verify the standalone renderer. The renderer itself launched and was tested successfully.

### 2. Renderer failed to load PDFium on first standalone run

Error:

```text
Failed to load pdfium library: LoadLibraryError(LoadLibraryExW { source: 126 })
```

Diagnosis:

The old renderer treated the PDFium argument as a directory and called `pdfium_platform_library_name_at_path()`. The Phase 1.7 spec passes the actual PDFium library file path.

Resolution:

Changed renderer initialization to call:

```rust
Pdfium::bind_to_library(lib_path)
```

This matches the Phase 1.7 CLI contract.

### 3. Test stdin file initially included a UTF-8 BOM

Error:

```text
JSON parse error: expected value at line 1 column 1
```

Diagnosis:

The generated `test_stdin.txt` had a UTF-8 BOM, which caused `serde_json` to reject the first line.

Resolution:

Rewrote the test input as UTF-8 without BOM. The renderer then returned a valid `meta` response and clean `shutdown` response.

### 4. Milestone 2 exposed expected blurry zoom behavior

Observation:

Metadata and previews worked, but zoomed rendering stayed blurry.

Diagnosis:

Milestone 2 only moved metadata and preview rendering to the persistent renderer. Tile rendering was still on the old process-per-tile path, which no longer matched the service-mode renderer binary.

Resolution:

Handled in Milestone 3 by routing tiles through `RendererService`.

### 5. Initial Milestone 3 implementation could hang on later pages

Observation:

Initial PDF page loaded, but subsequent pages stayed on "Preparing page".

Diagnosis:

The first tile implementation spawned one background task per missing tile. Although each task serialized on the renderer mutex, stale tile jobs could still sit ahead of newer page/preview work.

Resolution:

Replaced many task-per-tile scheduling with a single tile-render worker queue. The worker checks generation before rendering and skips stale tiles.

### 6. Tile reveal was visually jarring

Observation:

Zoomed-in high-quality tiles appeared one at a time, visibly replacing blurry preview content.

Diagnosis:

The renderer was rendering the full page for every 512px tile, then cropping the requested tile. On complex A1/A0 drawings, this made each tile expensive.

Resolution:

Added PDFium clipping to tile rendering so PDFium only paints the requested tile rectangle. This materially improved tile arrival time.

### 7. FIFO queue delayed active viewport tiles

Observation:

If the user panned to a new zoomed-in area, active viewport tiles could wait behind older off-screen or prefetch tiles.

Diagnosis:

The single tile worker was FIFO.

Resolution:

Added viewport batch ids, duplicate coalescing, and newest-batch-first priority scheduling.

### 8. Production build failed in sandbox

Error:

```text
Cannot read directory "../../../..": Access is denied.
Could not resolve "...\\desktop\\src-frontend\\vite.config.ts"
```

Diagnosis:

Vite/esbuild attempted to read outside the sandboxed working tree.

Resolution:

Reran `cargo tauri build` outside the sandbox with user approval. The first elevated run exceeded the tool timeout but produced installer files. A second elevated run with a longer timeout completed cleanly with exit code 0.

### 9. Production rebuild was blocked by running debug app

Error:

```text
failed to remove file `...\\target\\debug\\desktop.exe`
Caused by:
  Access is denied. (os error 5)
```

Diagnosis:

Windows had the running debug executable locked.

Resolution:

Stopped running `desktop.exe` and `pdf_renderer.exe`, then rebuilt successfully.

## Deviations from the Original Spec

### Additional file modified: `core/src/pdf/tile_manager.rs`

The original plan listed:

- `core/src/bin/pdf_renderer.rs`
- `desktop/src/lib.rs`
- `core/src/render/worker.rs`

During implementation, `core/src/pdf/tile_manager.rs` also needed changes to preserve cache/queued/completion behavior while moving tile rendering out of the old worker thread and into the persistent renderer service path.

### Tile routing implementation differs from the illustrative spec note

The spec suggested routing tile requests through a channel and mentioned an illustrative `svc_ptr` note. The final implementation uses:

- a Tokio unbounded channel in `desktop`
- a single async worker
- `spawn_blocking` for synchronous renderer IPC
- `Arc<Mutex<Option<RendererService>>>` for serialized renderer access

This satisfies the approved constraints:

- serialized renderer access
- `worker_count = 1`
- no per-tile process spawn

### Renderer path and PDFium library path handling was made platform explicit

The existing code stored the PDFium directory path. The Phase 1.7 renderer expects the actual library file path. The setup code now resolves:

- Windows: `libs/pdfium/pdfium.dll`
- macOS: `libs/pdfium/libpdfium.dylib`
- other: `libs/pdfium/libpdfium.so`

Renderer executable names are also platform-specific:

- Windows: `pdf_renderer.exe`
- non-Windows: `pdf_renderer`

This preserves sibling-first, bundled-resource-fallback renderer path resolution.

### Tile renderer response is not the authoritative source of frontend tile metadata

The renderer writes the tile PNG and returns a JSON `TileOutput`. Since the request does not include `zoom_level`, `desktop` reconstructs the authoritative `TileData` from the original `TileKey`, output path, and generation after the renderer request succeeds.

This keeps the frontend-facing tile metadata correct while preserving the Phase 1.7 request format.

### Performance fixes were added inside Milestone 3

Two performance-oriented changes were added after manual verification showed workflow issues:

- PDFium clipping for tile rendering
- active-viewport-prioritized tile scheduling

These were not explicitly required by the original spec, but they were necessary for Milestone 3 acceptance because the first correct implementation was too visually disruptive for takeoff workflow.

## Verification Summary

### Milestone 1

Verified:

- Renderer builds.
- Renderer starts as a service.
- Renderer accepts a JSON `meta` request.
- Renderer returns valid metadata.
- Renderer accepts `shutdown`.
- Renderer exits cleanly with exit code 0.

Representative verified output:

```json
{"data":{"page_count":1,"pages":[{"height_pts":792.0,"index":0,"width_pts":612.0}],"path":"...\\test_milestone1.pdf"},"id":1,"ok":true}
{"id":2,"ok":true,"data":null}
```

### Milestone 2

Verified by user:

- Project opened.
- PDF drawing opened.
- Page count/status loaded correctly.
- No relevant console errors.
- `desktop.exe` did not crash.

Observed console error:

```text
/favicon.ico 404
```

This was confirmed unrelated.

### Milestone 3

Verified by user after fixes:

- Tiles render through persistent renderer service.
- Zoomed rendering sharpens correctly.
- Subsequent pages no longer hang on "Preparing page".
- Tile rendering is materially faster.
- Active viewport tiles are prioritized.
- No command windows flash.
- No relevant console errors.

### Milestone 4

Verified by user:

- Create Project A.
- Open PDF.
- Navigate pages.
- Pan and zoom.
- Close Project A.
- No orphan `pdf_renderer.exe` after project close.
- Create Project B.
- Open PDF and render.
- Close Project B.
- Reopen Project A with data intact.
- Add dimension group.
- Select dimension group and breadcrumb updates.
- Overlay canvas remains transparent.
- No console errors.

### Production Build and Installer

Verified:

```text
cargo tauri build
```

completed with exit code 0.

Installers produced:

```text
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\msi\PDF CAD_0.1.0_x64_en-US.msi
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\nsis\PDF CAD_0.1.0_x64-setup.exe
```

The installed app launched, opened PDFs, and rendered tiles correctly.

Build warning:

```text
The bundle identifier "com.pdfcad.app" ends with ".app". This is not recommended on macOS.
```

This warning is unrelated to Phase 1.7 renderer behavior.

## Definition of Done Status

- [x] Milestone 1: renderer service responds to JSON requests and shuts down cleanly
- [x] Milestone 2: `open_document` uses renderer meta command; no in-process PDFium
- [x] Milestone 3: tile rendering routes through renderer service; no per-tile spawns
- [x] Milestone 4: project lifecycle correctly spawns and kills renderer
- [x] No orphaned renderer processes after project close
- [x] No command window flashes on Windows
- [x] All Phase 1, 1.5, and 1.6 functionality regression-tested
- [x] `cargo tauri build` produces MSI and NSIS installers
- [x] Installed app opens a PDF and renders tiles correctly

## Follow-Up Notes

The Phase 1.7 architecture is now in place for Phase 2. The renderer protocol already has a clean `"vectors"` rejection path and can be extended with vector extraction commands without changing frontend-visible Tauri signatures.

Potential cleanup for a future phase:

- Remove or refactor now-unused legacy tile queue fields and compatibility helpers if no longer needed.
- Consider whether renderer tile responses should include `zoom_level` explicitly once protocol fields are expanded.
- Consider addressing the Tauri bundle identifier warning for macOS packaging.
