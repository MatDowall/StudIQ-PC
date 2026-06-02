# CLAUDE.md

Guidance for Claude Code (and future me) when working in this repository.

## What this is

**Take-it-Off** — a Windows desktop **PDF takeoff / measurement** application for
construction estimating (measuring quantities off tender drawings). The driving real-world
test data is a set of architectural PDFs from Cook Brothers tenders (Dunedin).

- **Backend:** Rust, Tauri v2 workspace — `core` (PDF/render) + `desktop` (app, commands, DB).
- **Frontend:** React 18 + TypeScript + Vite + **Zustand** (`desktop/src-frontend`).
- **Persistence:** SQLite via `sqlx` (per-project `.tcop` file + a global `registry.db` of recent projects).
- **PDF engine:** PDFium via `pdfium-render`.

## Architecture — read this before changing rendering

PDFium runs **out-of-process**. The desktop app spawns a long-lived child process
`pdf_renderer.exe` (built from `core/src/bin/pdf_renderer.rs`) and talks to it over
**JSON-lines on stdin/stdout**. This is the live rendering path — NOT the in-process
worker pool described in the early Phase 1 docs.

```
React/Zustand UI ──Tauri invoke──► desktop/src/lib.rs ──JSON lines──► pdf_renderer.exe ──► PDFium
   (appStore.ts)                    (commands + AppState + SQLite)      (child process)
```

Renderer protocol commands: `meta`, `preview`, `tile`, `vectors`, `shutdown`
(see `dispatch()` in `core/src/bin/pdf_renderer.rs`).

Key backend pieces in `desktop/src/lib.rs`:
- `RendererService` — owns the child process; `request()` is synchronous and serialized
  behind a `Mutex`. There is currently **one** renderer process and **one** tile worker.
- `AppState` — pdfium path, tile cache dir, tile manager, active project (DB pool), recent
  projects, renderer handle.
- Tile rendering: `update_viewport` computes visible tiles (zoom buckets + generation
  counters for stale-tile invalidation), enqueues `TileRenderJob`s; `run_tile_render_worker`
  renders them via the renderer; `poll_tiles` drains completed tiles. Tiles are written as
  PNG files into the app cache dir and loaded in the frontend via `convertFileSrc`.

Frontend state lives in `desktop/src-frontend/src/store/appStore.ts` (Zustand). The snap
engine (endpoint → midpoint → intersection, with a bbox prefilter) is in `resolveSnap` there.
Canvas drawing + pan/zoom + snap UI is in `components/ViewerCanvas.tsx`.

## Coordinate convention — IMPORTANT for measurement work

The snap engine and snap indicator work in **PDF points, Y-up** (origin bottom-left;
`ViewerCanvas` converts with `pageHeightPts - ptY`). The existing `drawOverlays` for stored
measurements currently draws **Y-down** with no flip — these disagree. No measurement can be
saved yet (no `create_measurement` command), so `geometry_json` has no established format.
**When implementing Phase 3 measurement tools, standardize on PDF points / Y-up and make the
snap path and the overlay path agree.**

## Build & run

pdfium.dll must be present at `libs/pdfium/pdfium.dll` (developer-placed; gitignored).
The frontend `npm run build` also rebuilds the `pdf_renderer` binary (see package.json script).

```powershell
# Frontend build (also builds pdf_renderer in release)
cd C:\Users\Admin\Documents\Take-it-Off\desktop\src-frontend
cmd /c npm run build

# Backend build
cd C:\Users\Admin\Documents\Take-it-Off
cargo build --package desktop

# Full installer (MSI + NSIS) — outputs under target/release/bundle/
cd C:\Users\Admin\Documents\Take-it-Off\desktop
cargo tauri build

# Dev mode
cd C:\Users\Admin\Documents\Take-it-Off\desktop
cargo tauri dev
```

Gotchas observed historically:
- File-lock build errors (`os error 32`) mean a running `desktop.exe`/`pdf_renderer.exe` is
  holding the binary or `pdfium.dll` — stop those processes before rebuilding.
- A stale `pdf_renderer` binary silently serves old behavior (e.g. "vectors not implemented")
  — rebuild `core --bin pdf_renderer` after changing it.

## Project status (as of June 2026)

Complete through **Phase 2**. Working: project create/open (.tcop), drawing register tree,
dimension-group tree, multi-page PDF view with tiled pan/zoom + preview, vector extraction
(lines + rects, incl. straight subsegments of compound paths), and the endpoint/midpoint/
intersection snap engine.

**Phase 3 (next, not yet built):** measurement tools (drawing/saving measurements —
no `create_measurement` command exists yet), scale calibration, quantity calculation.
Later: perpendicular/nearest-edge/arc snap, snap settings UI, costing/reporting.

## Docs & process

`docs/` holds the phase **prompts** (specs), **handovers** (architecture/state between
phases), and **completion reports**. The most recent state is
`docs/phase2-completion-report.md`. This project was developed milestone-by-milestone with
explicit verification gates — keep that discipline: implement a milestone, verify it produces
visible/testable proof, then move on.

## Conventions

- No build/CI yet; no automated tests. Pure geometry logic (intersection, distance-to-segment,
  rect detection) is good candidate for unit tests if/when added.
- SQL is always parameterized. Node mutations verify `expected_node_type` before acting — keep this.
- British spelling is used in identifiers in places (`colour`). Match surrounding code.
