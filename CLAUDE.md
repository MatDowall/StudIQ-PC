# CLAUDE.md

Guidance for Claude Code (and future me) when working in this repository.

## What this is

**StudIQ** — a Windows desktop **PDF takeoff / measurement** application for
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

## Coordinate convention — measurements are PDF points, Y-up

All on-page geometry uses **PDF points with a Y-up, bottom-left origin** (the convention
PDFium and the snap engine use). `ViewerCanvas` converts to screen with `pageToScreen`
(`pageHeightPts - ptY`). The snap engine (`resolveSnap` / `scheduleSnapResolution`) produces
snap points in this space, and `drawOverlays` renders stored measurements through that same
`pageToScreen` path — so snap indicators and saved geometry share one coordinate space.

**Measurement tools store `geometry_json` as `[{ "x": <pt>, "y": <pt> }, ...]` in PDF points,
Y-up**, so saved geometry round-trips through snap and overlay with no flip. Internal canonical
units are millimetres: page scale is stored as `mm_per_point` (`page_scales` table), and group
width/height/offset are metres (the unit the properties dialog edits). Quantities are derived
on the frontend (`src-frontend/src/lib/quantity.ts`), not persisted to `measurements.quantity`.

## Build & run

pdfium.dll must be present at `libs/pdfium/pdfium.dll` (developer-placed; gitignored).
The frontend `npm run build` also rebuilds the `pdf_renderer` binary (see package.json script).

```powershell
# Frontend build (also builds pdf_renderer in release)
cd C:\Users\Admin\Documents\StudIQ\desktop\src-frontend
cmd /c npm run build

# Backend build
cd C:\Users\Admin\Documents\StudIQ
cargo build --package desktop

# Full installer (MSI + NSIS) — outputs under target/release/bundle/
cd C:\Users\Admin\Documents\StudIQ\desktop
cargo tauri build

# Dev mode
cd C:\Users\Admin\Documents\StudIQ\desktop
cargo tauri dev
```

Gotchas observed historically:
- File-lock build errors (`os error 32`) mean a running `desktop.exe`/`pdf_renderer.exe` is
  holding the binary or `pdfium.dll` — stop those processes before rebuilding.
- A stale `pdf_renderer` binary silently serves old behavior (e.g. "vectors not implemented")
  — rebuild `core --bin pdf_renderer` after changing it.

## Project status (as of June 2026)

Complete through **Phase 3**. Working: project create/open (.tcop), drawing register tree,
dimension-group tree, multi-page PDF view with tiled pan/zoom + preview, vector extraction,
the endpoint/midpoint/intersection snap engine, and the full CostX-style measurement suite —
**count / length / area** tools owned by the dimension group, per-drawing-page scale
calibration, the dimension-group properties dialog with the measurement-type → display
derivation matrix (length/area/wall area/volume; weight stubbed), positive/negative polarity
netting, live per-group quantities, CostX styling (bold outlines, circular handles, filled
areas, ringed-cross count markers, per-polarity colour + line style), and full
create/select/move/add-vertex/delete-vertex/delete editing with multi-group concurrent
rendering. See `docs/phase3-completion-report.md`.

CostX interaction model (authoritative — see `docs/phase3-plan.md`): add-mode is active while a
group is selected (no tool button); draw is **click-to-place** (right-click/Enter/double-click
to finish, Ctrl+click resumes from the last point, **middle-drag pans**); Add/Select toggle and
Positive/Negative toggle live in the viewer toolbar.

**Later (not yet built):** weight computation (needs a density/rate model), project-wide GFA
roll-up, persisting quantities, per-dimension overrides ("Use Default"), costing/reporting,
snap settings UI, perpendicular/nearest-edge/arc snap, dimension cutouts.

## Design decisions

### Timber framing: one quantity per framing size

A framing dimension group has a single `framingSize` (e.g. 90×45). Its **canonical quantity is
`matchingTotalM`** — the sum of all non-lintel components (plates, studs, dwangs, kings,
trimmers, jacks, sills, sill jacks). This is what the group header displays.

**Lintels are always their own separate quantity**, regardless of whether their size matches
the group's `framingSize`. They are excluded from `matchingTotalM` and shown as **virtual
sub-quantity rows** below the component breakdown — visually distinct, with their own total per
lintel size.

**Worksheet implication:** when a framing group is dragged onto a takeoff worksheet it emits:
- One row for non-lintel components → quantity = `matchingTotalM`, size = group's `framingSize`
- One row per distinct lintel size present → quantity = sum of that size's lintel `totalM`

Never use `FramingGroupBreakdown.totalM` as the worksheet quantity — it combines all sizes.

The `sizeOverride` field on `FramingComponent` / `FramingComponentTotal` is **always set on
lintel members** (to the lintel's own `FramingSize`) and absent on all other member kinds. This
is the key that excludes lintels from `matchingTotalM` and marks them for separate worksheet rows.

## Docs & process

`docs/` holds the phase **prompts** (specs), **handovers** (architecture/state between
phases), and **completion reports**. The most recent state is
`docs/phase3-completion-report.md` (plan in `docs/phase3-plan.md`). This project was developed
milestone-by-milestone with
explicit verification gates — keep that discipline: implement a milestone, verify it produces
visible/testable proof, then move on.

## UI styling rules

### Theme
All colours, spacing, and sizing constants live in `desktop/src-frontend/src/theme.ts`. Never
hardcode a colour or size that already exists in the theme — always reference `theme.*`.
Current key values:
- `theme.ribbonHeight` = 76 px — ribbon row in the App grid is driven by this value; changing it
  resizes both the CSS grid row (`App.tsx`) and the ribbon container together.
- `theme.rowHeight` = 22 px — used for tree rows throughout both sidebar panes.
- `theme.treeIndent` = 16 px — per-depth indent for tree rows.

### Icons — Google Material Symbols
The app uses **Google Material Symbols Outlined** loaded from the Google Fonts CDN in
`desktop/src-frontend/index.html`. Render icons as:

```tsx
<span className="material-symbols-outlined" style={{ fontSize: <px>, lineHeight: 1 }}>
  icon_name_here
</span>
```

Icon names use **snake_case** exactly as listed on fonts.google.com/icons (e.g. `save_as`,
`view_in_ar`, `calendar_view_week`). Do not use the older Material Icons font — always use
Material Symbols Outlined.

**Established icon assignments** (do not reassign without a design reason):

| UI element | Icon name |
|---|---|
| Add dimension group | `add` |
| Properties | `tune` |
| Copy | `copy_all` |
| Point drawing type | `polyline` |
| Line drawing type | `show_chart` |
| Plan View | `architecture` |
| View in 3D | `view_in_ar` |
| Dim (drawing dimmer) | `contrast` |
| Geometry (snap toggle) | `my_location` |
| Export project | `save_as` |
| Edit / Project Info | `edit` |
| Timber Framing group | `calendar_view_week` |
| Area group | `crop_free` |
| Count group | `123` |
| Length group | `straighten` |
| Recalculate workbook | `calculate` |

### Ribbon layout rules
- The ribbon uses `display: flex; align-items: stretch` — group divs fill the full ribbon height.
- Each group div uses `flex-direction: column` with **no** `justify-content: space-between`.
  The group label sits at the bottom via `margin-top: auto` on the label element. Using
  `space-between` when content height ≥ container height causes flex items to overlap and get
  clipped by the ribbon's `overflow: hidden` — avoid it.
- Ribbon buttons stack the icon **above** the label text (`flex-direction: column`). Icon size
  is 32 px; label font-size is 9 px. Button height is 50 px.
- Only add a group to `groups` in `Ribbon.tsx` if it has real wired behaviour. Static
  decorative-only groups were removed.

### Snap group
The Snap group contains only the **Geometry** button, which toggles `snapEnabled` in the store.
The Angle and Rebar buttons were removed as they had no wired behaviour. Do not re-add
dummy buttons to the ribbon.

### Sidebar trees — default expanded
Both `TreeNode` (`DrawingRegisterPane`) and `DimensionTreeRow` (`DimensionGroupPane`) initialise
`expanded` to `true` for folder nodes so all folders are open when a project loads. This is
intentional — do not change the default back to `false`.

### Dimension group icons
`measurement_type` is included on every `TreeNodeDto` via a `LEFT JOIN dimension_group_props`
in `query_tree_nodes` and `get_tree_node`. This means the icon for a dimension group is always
known from the node itself — no need to load full props first, and no glyph fallback.
When adding new measurement types, add an entry to `MEASUREMENT_TYPE_ICONS` in
`DimensionGroupPane.tsx` and a row to the table above.

### Project status
Projects have a `status` field (`TEXT NOT NULL DEFAULT 'Tendering'`) in `project_meta` and
in `recent_projects` (registry DB). Valid values are **"Tendering"** and **"Closed"** —
enforced by the dropdown in `ProjectInfoDialog`. The status is shown in the Recent Projects
list on the splash screen. If new status values are added, update both `STATUS_OPTIONS` in
`ProjectInfoDialog.tsx` and the docs here.

### Additive DB migrations
New columns are added with bare `ALTER TABLE … ADD COLUMN` executed at startup and the error
silently ignored (`.await` result discarded with `let _ = …`). This keeps existing project
files working without a versioned migration system. Follow this pattern for any new nullable or
`DEFAULT`-valued columns — never drop or rename columns.

## Conventions

- No build/CI yet; no automated tests. Pure geometry logic (intersection, distance-to-segment,
  rect detection) is good candidate for unit tests if/when added.
- SQL is always parameterized. Node mutations verify `expected_node_type` before acting — keep this.
- British spelling is used in identifiers in places (`colour`). Match surrounding code.
