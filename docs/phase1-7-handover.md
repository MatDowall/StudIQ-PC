# Phase 1.7 Handover: Persistent Renderer Service
## Desktop CAD/Takeoff Application — Rust + Tauri + React
## Target platforms: Windows and macOS

---

## How To Use This Document

This spec is structured as four sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

---

## Context and Goal

Phase 1.6 left the app spawning a new `pdf_renderer.exe` process for every
preview render and every tile render. This is intentionally conservative —
it gave a crash boundary while the architecture was being proven.

The problem for Phase 2 is that vector extraction and snap queries must run at
mouse-move speed. Spawning a new process per query is not viable at that
frequency.

Phase 1.7 replaces the process-per-render model with a **persistent renderer
service**. One `pdf_renderer` process is spawned when a project is opened and
stays alive until the project is closed. `desktop` communicates with it over
**stdin/stdout JSON lines**.

This is an internal architecture change. The user-visible behaviour does not
change — PDF rendering, pan, zoom, and page navigation work exactly as before,
but faster and without the per-render process spawn overhead.

**The PDFium process boundary is preserved.** `desktop` still never loads or
calls PDFium directly.

---

## Decisions Already Made — Do Not Revisit

- **PDFium must not run inside `desktop`.** This rule does not change.
- **stdin/stdout JSON lines for IPC.** Not named pipes, not HTTP, not shared
  memory. One JSON object per line, newline-delimited, UTF-8.
- **One renderer process per open project.** Spawned on project open, killed
  on project close.
- **`worker_count` stays at 1** for tile rendering workers inside the renderer.
- **`CREATE_NO_WINDOW` on Windows, no equivalent needed on macOS.** Use
  `#[cfg(target_os = "windows")]` guards.
- **Sibling path first, bundled resource fallback** for renderer path
  resolution. Do not change this logic.
- **`fs:allow-mkdir` not `fs:allow-create-dir`** in capabilities.
- **Inline styles only. No Tailwind.**
- **Zustand for all frontend state.**
- **`.tcop` files are SQLite databases.**
- **Single canvas compositor. Overlay canvas above it.**
- **Do not change any Tauri command signatures visible to the frontend.**
  The frontend must not need changes in Phase 1.7 except where explicitly
  stated in this document.

---

## Critical Tauri v2 Rules — unchanged from previous phases

**Rule 1 — `main.rs` is a thin wrapper only.**
**Rule 2 — Capabilities file controls all plugin access.**
**Rule 3 — v2 syntax only in `tauri.conf.json`.**
**Rule 4 — `invoke<T>()` must match Rust return types exactly.**
**Rule 5 — Plugin imports use the plugin package.**
**Rule 6 — Every plugin initialised in the builder.**

---

## IPC Protocol — stdin/stdout JSON Lines

Every message is a single JSON object followed by `\n`. The renderer reads
requests from stdin line by line and writes responses to stdout line by line.
stderr is used for logging only and is never parsed by `desktop`.

### Request format

```json
{ "id": 1, "cmd": "meta", "pdf_path": "C:\\path\\to\\drawing.pdf" }
{ "id": 2, "cmd": "preview", "pdf_path": "...", "page": 0, "max_dim": 1200, "output_path": "..." }
{ "id": 3, "cmd": "tile", "pdf_path": "...", "page": 0, "dpi": 96.0, "tile_x": 0, "tile_y": 0, "output_path": "..." }
{ "id": 4, "cmd": "shutdown" }
```

### Response format

```json
{ "id": 1, "ok": true, "data": { "path": "...", "page_count": 4, "pages": [...] } }
{ "id": 2, "ok": true, "data": { "page": 0, "width": 1200, "height": 849, "image_path": "..." } }
{ "id": 3, "ok": true, "data": { "key": {...}, "image_path": "...", "x": 0, "y": 0, "generation": 1 } }
{ "id": 1, "ok": false, "error": "Failed to open PDF: file not found" }
```

- `id` is an arbitrary u64 chosen by the caller. Responses carry the same `id`
  so the caller can match responses to requests.
- Responses may arrive out of order — the renderer processes requests
  concurrently where safe. The caller must match by `id`.
- `shutdown` causes the renderer to flush stdout, close handles, and exit
  cleanly with code 0.

### Phase 2 extension point

The protocol is designed to accept new commands without breaking existing ones.
Phase 2 will add:

```json
{ "id": 5, "cmd": "vectors", "pdf_path": "...", "page": 0 }
```

Do not implement `vectors` in Phase 1.7. Define the dispatch match arm as
`"vectors" => Err("not implemented")` so the renderer rejects it cleanly
rather than hanging.

---

## Renderer Architecture — `core/src/bin/pdf_renderer.rs`

The renderer is rewritten from a single-shot CLI tool to a service loop.

### Entry point

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};

fn main() {
    // pdfium lib path is the only CLI argument
    let args: Vec<String> = std::env::args().collect();
    let lib_path = args.get(1).expect("Usage: pdf_renderer <pdfium-lib-path>");

    let pdfium = init_pdfium(lib_path);

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut stdout_lock = stdout.lock();
    let reader = BufReader::new(stdin.lock());

    for line in reader.lines() {
        let line = match line {
            Ok(l) if l.trim().is_empty() => continue,
            Ok(l) => l,
            Err(e) => {
                eprintln!("stdin read error: {e}");
                break;
            }
        };

        let request: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("JSON parse error: {e}");
                continue;
            }
        };

        let id = request["id"].as_u64().unwrap_or(0);
        let cmd = request["cmd"].as_str().unwrap_or("");

        if cmd == "shutdown" {
            let _ = writeln!(stdout_lock, "{{\"id\":{id},\"ok\":true,\"data\":null}}");
            let _ = stdout_lock.flush();
            break;
        }

        let result = dispatch(&pdfium, cmd, &request);

        let response = match result {
            Ok(data) => serde_json::json!({ "id": id, "ok": true, "data": data }),
            Err(e)   => serde_json::json!({ "id": id, "ok": false, "error": e }),
        };

        if let Err(e) = writeln!(stdout_lock, "{}", response) {
            eprintln!("stdout write error: {e}");
            break;
        }
        let _ = stdout_lock.flush();
    }
}

fn dispatch(
    pdfium: &Pdfium,
    cmd: &str,
    req: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    match cmd {
        "meta"     => handle_meta(pdfium, req),
        "preview"  => handle_preview(pdfium, req),
        "tile"     => handle_tile(pdfium, req),
        "vectors"  => Err("vectors not implemented in Phase 1.7".to_string()),
        other      => Err(format!("unknown command: {other}")),
    }
}
```

### Handler signatures

```rust
fn handle_meta(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String>
// reads req["pdf_path"], returns DocumentMeta as serde_json::Value

fn handle_preview(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String>
// reads req["pdf_path"], req["page"], req["max_dim"], req["output_path"]
// returns PreviewData as serde_json::Value

fn handle_tile(pdfium: &Pdfium, req: &serde_json::Value) -> Result<serde_json::Value, String>
// reads req["pdf_path"], req["page"], req["dpi"], req["tile_x"], req["tile_y"],
//        req["output_path"], req["generation"]
// returns TileData as serde_json::Value
```

The pdfium rendering logic inside each handler is unchanged from Phase 1.6.
Only the entry point and dispatch change.

---

## Desktop Architecture — `desktop/src/lib.rs`

### RendererService

Replace the ad-hoc `Command::new(&renderer_path)` calls throughout `lib.rs`
with a single `RendererService` struct stored in `AppState`.

```rust
use std::process::{Child, ChildStdin, ChildStdout};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};

pub struct RendererService {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: AtomicU64,
}

impl RendererService {
    /// Spawn the renderer process with pdfium lib path as the only argument.
    pub fn spawn(renderer_path: &str, pdfium_lib_path: &str) -> Result<Self, String> {
        use std::process::Stdio;

        let mut cmd = std::process::Command::new(renderer_path);
        cmd.arg(pdfium_lib_path)
           .stdin(Stdio::piped())
           .stdout(Stdio::piped())
           .stderr(Stdio::inherit());  // renderer logs go to desktop stderr

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()
            .map_err(|e| format!("Failed to spawn renderer: {e}"))?;

        let stdin  = child.stdin.take()
            .ok_or("Renderer stdin unavailable")?;
        let stdout = child.stdout.take()
            .ok_or("Renderer stdout unavailable")?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: AtomicU64::new(1),
        })
    }

    /// Send a request and wait for the matching response.
    /// This is synchronous — caller must not hold any mutex while calling.
    pub fn request(&mut self, mut payload: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        payload["id"] = serde_json::json!(id);

        let line = serde_json::to_string(&payload)
            .map_err(|e| format!("Serialise error: {e}"))?;

        writeln!(self.stdin, "{line}")
            .map_err(|e| format!("Renderer stdin write error: {e}"))?;
        self.stdin.flush()
            .map_err(|e| format!("Renderer stdin flush error: {e}"))?;

        // Read lines until we find the response with matching id
        loop {
            let mut response_line = String::new();
            self.stdout.read_line(&mut response_line)
                .map_err(|e| format!("Renderer stdout read error: {e}"))?;

            if response_line.trim().is_empty() { continue; }

            let response: serde_json::Value = serde_json::from_str(response_line.trim())
                .map_err(|e| format!("Response parse error: {e}"))?;

            if response["id"].as_u64() == Some(id) {
                if response["ok"].as_bool() == Some(true) {
                    return Ok(response["data"].clone());
                } else {
                    return Err(response["error"]
                        .as_str()
                        .unwrap_or("unknown renderer error")
                        .to_string());
                }
            }
            // Response for a different id — discard for now
            // (In Phase 1.7 all requests are sequential, so this should not occur)
        }
    }

    /// Send shutdown and wait for process exit.
    pub fn shutdown(&mut self) {
        let _ = self.request(serde_json::json!({ "cmd": "shutdown" }));
        let _ = self.child.wait();
    }
}

impl Drop for RendererService {
    fn drop(&mut self) {
        // Best-effort shutdown on drop
        let _ = writeln!(self.stdin, "{{\"id\":0,\"cmd\":\"shutdown\"}}");
        let _ = self.stdin.flush();
        let _ = self.child.wait();
    }
}
```

### Updated `AppState`

```rust
pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    pub active_project: Arc<Mutex<Option<ActiveProject>>>,
    pub recent_projects: Arc<Mutex<Vec<RecentProject>>>,
    pub registry_db: SqlitePool,
    // Phase 1.7 — replaces all ad-hoc Command::new calls
    pub renderer: Arc<Mutex<Option<RendererService>>>,
}
```

`renderer` is `None` when no project is open. It is spawned in `open_project`
and `create_project`, and shut down in `close_project`.

### Renderer lifecycle

```rust
// In create_project and open_project — after setting active_project:
{
    let mut renderer_guard = state.renderer.lock();
    if let Some(mut old) = renderer_guard.take() {
        old.shutdown();
    }
    *renderer_guard = Some(
        RendererService::spawn(&state.renderer_path, &state.pdfium_lib_path)
            .map_err(|e| format!("Failed to start renderer: {e}"))?
    );
}

// In close_project — before clearing active_project:
{
    let mut renderer_guard = state.renderer.lock();
    if let Some(mut svc) = renderer_guard.take() {
        svc.shutdown();
    }
}
```

### Replacing ad-hoc Command calls

Every `Command::new(&renderer_path).arg("preview")...` and
`Command::new(&renderer_path).arg("tile")...` call in `lib.rs` and
`core/src/render/worker.rs` must be replaced with calls to
`RendererService::request()`.

**`render_preview` command — updated:**
```rust
#[tauri::command]
async fn render_preview(
    page_index: u32,
    state: State<'_, AppState>,
) -> Result<PreviewData, String> {
    let (doc_path, output_path) = {
        let guard = state.open_document.lock();
        let doc = guard.as_ref().ok_or("No document open")?;
        let out = std::path::Path::new(&state.tile_cache_dir)
            .join(format!("preview_page_{page_index}.png"))
            .to_string_lossy()
            .to_string();
        (doc.path.clone(), out)
    };

    let request = serde_json::json!({
        "cmd": "preview",
        "pdf_path": doc_path,
        "page": page_index,
        "max_dim": 1200,
        "output_path": output_path,
    });

    let data = {
        let mut renderer = state.renderer.lock();
        renderer.as_mut()
            .ok_or("Renderer not running")?
            .request(request)?
    };

    serde_json::from_value::<PreviewData>(data)
        .map_err(|e| format!("PreviewData deserialise error: {e}"))
}
```

**Tile workers — `core/src/render/worker.rs`:**

The worker pool currently spawns a new process per tile. Replace this with a
call back to the `RendererService` via a channel.

The cleanest approach for Phase 1.7 given `worker_count = 1`:

- Remove the `Command::new` spawn from the worker thread.
- Pass a `Sender<(RenderRequest, oneshot::Sender<Result<TileData, String>>)>`
  into the worker.
- The Tauri async runtime services render requests by calling
  `renderer.lock().request(...)` directly in the `update_viewport` command
  using `spawn_blocking`.
- This avoids the complexity of routing the renderer through the worker thread
  while `worker_count = 1`.

Revised `update_viewport` tile rendering:

```rust
// For each visible tile key that is not cached:
let request = serde_json::json!({
    "cmd": "tile",
    "pdf_path": doc.path,
    "page": key.page,
    "dpi": dpi,
    "tile_x": key.tile_x,
    "tile_y": key.tile_y,
    "output_path": tile_output_path,
    "generation": current_generation,
});

// Dispatch to renderer — use try_lock to avoid blocking the command thread
if let Some(renderer) = state.renderer.try_lock() {
    if let Some(svc) = renderer.as_ref() {
        // spawn_blocking because request() does synchronous I/O
        let svc_ptr = ...; // see note below on thread safety
    }
}
```

**Note on thread safety for renderer in tile dispatch:**

`RendererService` contains `ChildStdin` and `BufReader<ChildStdout>` which are
not `Send`. Wrap in `Arc<Mutex<RendererService>>` (already done via AppState)
and use `spawn_blocking` to call `request()` without holding the async executor.

For Phase 1.7 with `worker_count = 1`, tile requests are effectively
serialised through the single renderer mutex. This is acceptable — the goal
of Phase 1.7 is stability and eliminating spawn overhead, not parallelism.
Parallelism comes in Phase 2 when the renderer is extended.

---

## `open_document` Safety Rule

The current `open_document` command in `lib.rs` calls `init_pdfium` and
`load_document_meta` directly — this is an in-process PDFium call that
violates the process boundary rule.

**This must be fixed in Phase 1.7.**

Replace the in-process metadata read with a renderer `meta` request:

```rust
#[tauri::command]
fn open_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentMeta, String> {
    // Send meta request to renderer — no in-process PDFium
    let request = serde_json::json!({
        "cmd": "meta",
        "pdf_path": path,
    });

    let data = {
        let mut renderer = state.renderer.lock();
        renderer.as_mut()
            .ok_or("Renderer not running — open a project first")?
            .request(request)?
    };

    let meta = serde_json::from_value::<DocumentMeta>(data)
        .map_err(|e| format!("DocumentMeta deserialise error: {e}"))?;

    *state.open_document.lock() = Some(meta.clone());
    let _ = std::fs::remove_dir_all(&state.tile_cache_dir);
    let _ = std::fs::create_dir_all(&state.tile_cache_dir);
    *state.render_context.lock() = None;
    state.tile_manager.clear();

    Ok(meta)
}
```

Remove the `init_pdfium` and `load_document_meta` imports from `lib.rs` once
this is done. `desktop` should have no remaining direct pdfium-render calls.

---

## Startup Renderer — Before Project Open

The renderer requires a project to be open (so we know pdfium lib path and
tile cache dir are resolved). Since `open_document` now requires the renderer,
the renderer must be started when the app launches — not just on project open.

Resolve this by spawning a **startup renderer** during `setup()` using the
resolved `pdfium_lib_path`. This renderer handles `open_document` calls made
before a project is opened (e.g. the user opens a PDF directly from the start
screen in a future phase). For Phase 1.7 it ensures `open_document` always has
a renderer available.

```rust
// In setup() after resolving paths:
let startup_renderer = RendererService::spawn(&renderer_path, &pdfium_lib_path)
    .expect("Failed to start renderer on startup");

app.manage(AppState {
    // ... existing fields ...
    renderer: Arc::new(Mutex::new(Some(startup_renderer))),
});
```

On `open_project` and `create_project`: replace the startup renderer with a
fresh one (same process, same pdfium lib path — but this gives a clean slate
with no stale state from a previous session).

---

## Files to Create or Modify

**Modified:**
1. `core/src/bin/pdf_renderer.rs` — rewrite as service loop
2. `desktop/src/lib.rs` — add `RendererService`, update `AppState`,
   update `open_document`, `render_preview`, `open_project`,
   `create_project`, `close_project`
3. `core/src/render/worker.rs` — remove `Command::new` tile spawns,
   route tile requests through renderer channel

**No frontend changes required in Phase 1.7.**
The Tauri command signatures visible to the frontend do not change.
`Viewer.tsx`, `appStore.ts`, and all React components are untouched.

---

## MILESTONE 1 — Renderer Service Runs and Responds

**Goal:** The new renderer binary starts as a service, reads a JSON line from
stdin, and responds correctly. Verified via a standalone test — no Tauri app
needed yet.

**Implement:** Rewrite `core/src/bin/pdf_renderer.rs` as the service loop.
Keep handler logic identical to Phase 1.6 — only the entry point and dispatch
change.

**Verification:**
```powershell
cargo build --package core --bin pdf_renderer

# On Windows — test with PowerShell
$proc = Start-Process -FilePath ".\target\debug\pdf_renderer.exe" `
  -ArgumentList ".\target\debug\libs\pdfium\pdfium.dll" `
  -RedirectStandardInput ".\test_stdin.txt" `
  -RedirectStandardOutput ".\test_stdout.txt" `
  -NoNewWindow -PassThru -Wait

# test_stdin.txt contents:
# {"id":1,"cmd":"meta","pdf_path":"C:\\path\\to\\test.pdf"}
# {"id":2,"cmd":"shutdown"}

Get-Content ".\test_stdout.txt"
```

Expected output in `test_stdout.txt`:
```
{"id":1,"ok":true,"data":{"path":"...","page_count":N,"pages":[...]}}
{"id":2,"ok":true,"data":null}
```

**Gate: do not proceed until the renderer responds correctly to a meta request
and exits cleanly on shutdown.**

---

## MILESTONE 2 — Desktop Spawns and Communicates with Renderer

**Goal:** `desktop` spawns the renderer on startup, sends a meta request via
`RendererService::request()`, and receives the response. Verified by opening
a PDF in the app and confirming it loads without errors.

**Implement:** `RendererService` struct in `lib.rs`, spawn in `setup()`,
update `open_document` to use renderer `meta` command instead of in-process
pdfium call. Remove all remaining direct pdfium-render calls from `lib.rs`.

**Verification:**
```powershell
cargo build --package core --bin pdf_renderer
cargo build --package desktop
Start-Process -FilePath ".\target\debug\desktop.exe" `
  -WorkingDirectory "C:\Users\Admin\Documents\Take-it-Off"
```

In the app:
- Create or open a project
- Open a PDF drawing
- Confirm status shows page count correctly
- Confirm no errors in console (F12)
- Confirm `desktop.exe` does not crash when opening the PDF

**Gate: do not proceed until a PDF opens successfully via the renderer service.**

---

## MILESTONE 3 — Tile Rendering via Renderer Service

**Goal:** Tile rendering routes through `RendererService::request()` instead of
spawning a new process per tile. Pan and zoom work. No command window flashes.

**Implement:** Remove `Command::new` tile spawn from `core/src/render/worker.rs`.
Route tile requests through `RendererService` in `update_viewport`.

**Verification:**
Open a large A1 or A0 PDF in the app. Confirm:
- Tiles render and appear on the canvas
- Pan is smooth — no visible lag from process spawn overhead
- Zoom re-tiles correctly
- No command window flashes during pan/zoom
- No errors in console

**Gate: do not proceed until tile rendering works without per-tile process
spawns.**

---

## MILESTONE 4 — Full Regression, Lifecycle, and Build

**Goal:** Project open/close lifecycle correctly manages the renderer process.
All Phase 1, 1.5, and 1.6 functionality works. Installer builds.

**Verification:**
Confirm in app:
- Create Project A, open a PDF, navigate pages, pan and zoom — all work
- Close Project A — renderer shuts down cleanly (no orphan processes in
  Task Manager)
- Create Project B — new renderer spawns, PDF opens correctly
- Close Project B, reopen Project A — renderer restarts, all data intact
- Add a dimension group, select it, breadcrumb updates, no errors
- Overlay canvas transparent, no console errors

Check Task Manager after closing a project:
- No orphaned `pdf_renderer.exe` processes remain

Then run:
```powershell
cargo tauri build
```

Confirm:
- MSI and NSIS installers produced
- Installed app launches and opens a PDF correctly

**Gate: Phase 1.7 complete when all Definition of Done items confirmed.**

---

## Definition of Done

- [ ] Milestone 1: renderer service responds to JSON requests and shuts down cleanly
- [ ] Milestone 2: `open_document` uses renderer meta command — no in-process PDFium
- [ ] Milestone 3: tile rendering routes through renderer service — no per-tile spawns
- [ ] Milestone 4: project lifecycle correctly spawns and kills renderer
- [ ] No orphaned renderer processes after project close
- [ ] No command window flashes on Windows
- [ ] All Phase 1, 1.5, 1.6 functionality regression-tested
- [ ] `cargo tauri build` produces MSI and NSIS installers
- [ ] Installed app opens a PDF and renders tiles correctly

---

## Out of Scope for Phase 1.7

Do not implement:
- `vectors` command in renderer (dispatch stub only)
- Concurrent tile requests to renderer (serialised through mutex is correct
  for Phase 1.7)
- Any frontend changes
- Any measurement tools
- Any costing or reporting features
- R-tree snap index (Phase 2)
