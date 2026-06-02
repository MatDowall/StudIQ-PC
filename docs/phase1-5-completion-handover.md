# Phase 1.5 Completion Handover

Date: 2026-06-01

Project path: `C:\Users\Admin\Documents\Take-it-Off`

Specification source: `C:\Users\Admin\Downloads\phase1-5-handover-v3.md`

## Executive Summary

Phase 1.5 is complete and was manually accepted by the user.

Phase 1 delivered a stable PDF viewing engine after PDFium rendering was moved out of the Tauri UI process and into `pdf_renderer.exe`. Phase 1.5 built the application shell and project data model on top of that viewer:

- Tauri v2 desktop shell.
- React and TypeScript frontend.
- SQLite-backed drawing register and dimension group trees via `sqlx`.
- Sidebar-driven drawing and page navigation.
- In-app CRUD dialogs for drawings, folders, and dimension groups.
- CostX-style Dimension Groups tree-grid with Name, Quantity, UOM, and colour swatch columns.
- Transparent overlay canvas layered above the tile compositor.
- Production installer build.

The final manual gate check was passed by the user after Milestone 5:

```text
confirming all manual checks pass
```

## Critical Architecture Decisions To Preserve

These decisions are final for the current architecture and must not be undone by future work.

### PDFium Isolation

PDFium must not run inside `desktop.exe`.

All PDF metadata and rendering operations go through `pdf_renderer.exe`, including:

- opening document metadata;
- reading page count;
- reading page dimensions;
- rendering previews;
- rendering tiles;
- adding drawings to the drawing register.

This was necessary because Windows crash events showed native failures in `pdfium.dll` when PDFium was used inside the Tauri process.

Reference:

- `docs/phase1-5-rendering-safety-addendum.md`
- `docs/milestone4a-handover.md`

### Worker Count

`worker_count` remains `1`.

Do not increase it without a focused renderer architecture change and stress test pass.

### Tile Transport

`TileData` uses `image_path`, not base64.

Frontend tile and preview image loading uses Tauri asset URLs via `convertFileSrc(imagePath)`.

### Single Tile Canvas

The PDF page is rendered through a single canvas compositor. Do not replace it with a DOM image grid.

DOM tile grids previously caused visible splitting, tearing, white regions, and unstable zoom behaviour.

### Overlay Canvas

Phase 1.5 adds a second canvas only for measurement overlays.

The canvas stack is:

1. Tile canvas: existing PDF preview and tile compositor.
2. Overlay canvas: transparent, absolute-positioned, `pointer-events: none`.

The overlay canvas must remain visually transparent when there are no measurements.

## Important Spec Deviations And Approved Adjustments

The original Phase 1.5 spec contained several points that were superseded during implementation.

### Inline Styles Instead Of Tailwind

The user explicitly required inline styles throughout, using values imported from `theme.ts`.

Tailwind was not added.

### `sqlx` Instead Of `tauri-plugin-sql`

The user explicitly approved replacing `tauri-plugin-sql` with direct Rust-side `sqlx`.

Current database approach:

- `sqlx` with SQLite.
- `SqlitePool` stored in `AppState` as `Arc<SqlitePool>`.
- Database initialised in the Tauri setup closure using `tauri::async_runtime::block_on`.
- Frontend calls Rust commands via `invoke()`.
- Frontend never touches SQLite directly.

Removed/avoided:

- `tauri-plugin-sql`
- `sql:allow-execute`
- `sql:allow-select`
- `sql:allow-load`

### Capability String

The capabilities file keeps `fs:read-all` because that is what worked in the existing Phase 1 build.

Do not rename it to `fs:allow-read-all` unless a future Tauri upgrade requires it and the exact permission error has been captured.

### Sidebar-Driven Drawing Navigation

The toolbar page selector was removed.

Drawing and page navigation are driven from the drawing tree in the sidebar:

- Drawing folder nodes are database records.
- Drawing nodes are database records.
- Drawing page rows are virtual rows generated from the drawing's `page_count`.
- Page rows are navigation only and must not expose destructive context menu actions.

Reference:

- `docs/phase1-5-navigation-addendum.md`

### Project Tree Defaults

Seeded drawing and dimension folder structures from the original spec are treated as verification fixtures only.

Real project workflow should start blank unless the user explicitly imports or applies a future template.

References:

- `docs/phase1-5-project-workflow-addendum.md`
- `docs/phase1-5-dimension-workflow-addendum.md`

### Dimension Groups Summary Grid

The Dimension Groups pane was changed from a plain tree to a CostX-style tree-grid:

- Name
- Quantity
- UOM
- Colour swatch

Quantity and UOM are currently dummy UI values only. They are not stored in SQLite and must be replaced by real measurement aggregation when measurement calculation is implemented.

Reference:

- `docs/phase1-5-dimension-summary-grid-addendum.md`

## Addenda Created During Phase 1.5

The following addenda are part of the effective Phase 1.5 specification and should be read by any future developer or chat before continuing work.

1. `docs/milestone4a-handover.md`

   Documents the Phase 1 rendering recovery work, the shift to an out-of-process PDF renderer, the failed rendering approaches, and the stable current rendering lifecycle.

2. `docs/phase1-5-navigation-addendum.md`

   Defines sidebar-driven drawing and page navigation. Removes toolbar page navigation as a control surface.

3. `docs/phase1-5-project-workflow-addendum.md`

   Defines user-created drawing folder workflows, in-app folder selection dialog, dynamic folder creation, destructive delete warnings, and tree refresh requirements.

4. `docs/phase1-5-rendering-safety-addendum.md`

   Makes the PDFium process boundary explicit for all metadata and rendering operations.

5. `docs/phase1-5-dimension-workflow-addendum.md`

   Aligns dimension group workflow with the drawing folder workflow: blank real-project tree, in-app dialogs, dynamic folder creation, guarded deletion, rename, colour change, breadcrumb, and measurement loading.

6. `docs/phase1-5-dimension-summary-grid-addendum.md`

   Defines the CostX-style Dimension Groups summary grid and records that current Quantity/UOM values are temporary presentation data.

## Final Application Structure

### Desktop Backend

Main backend file:

- `desktop/src/lib.rs`

Key responsibilities:

- Tauri builder setup.
- Tauri plugin setup for dialog and filesystem.
- Resolving `pdfium` resource path.
- Resolving `pdf_renderer.exe` path beside the current executable.
- Creating tile cache directory.
- Initialising SQLite.
- Managing shared app state.
- Registering Tauri commands.

Important `AppState` fields:

```rust
pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    pub db: Arc<SqlitePool>,
}
```

### Renderer Helper

Main renderer file:

- `core/src/bin/pdf_renderer.rs`

Supported modes:

```text
pdf_renderer.exe meta <pdfium-dir> <pdf-path>
pdf_renderer.exe preview <pdfium-dir> <pdf-path> <page> <max-dim> <output-path>
pdf_renderer.exe tile <pdfium-dir> <pdf-path> <page> <dpi> <tile-x> <tile-y> <output-path>
```

This helper loads PDFium, does one unit of work, writes output files or JSON, then exits.

### Frontend Entry Points

Important frontend files:

- `desktop/src-frontend/src/App.tsx`
- `desktop/src-frontend/src/theme.ts`
- `desktop/src-frontend/src/store/appStore.ts`
- `desktop/src-frontend/src/components/Ribbon.tsx`
- `desktop/src-frontend/src/components/LeftColumn.tsx`
- `desktop/src-frontend/src/components/DrawingRegisterPane.tsx`
- `desktop/src-frontend/src/components/DimensionGroupPane.tsx`
- `desktop/src-frontend/src/components/Viewer.tsx`
- `desktop/src-frontend/src/components/ViewerCanvas.tsx`

Dialog and menu components:

- `desktop/src-frontend/src/components/ContextMenu.tsx`
- `desktop/src-frontend/src/components/ConfirmDialog.tsx`
- `desktop/src-frontend/src/components/FolderPathDialog.tsx`
- `desktop/src-frontend/src/components/DimensionGroupDialog.tsx`
- `desktop/src-frontend/src/components/TextInputDialog.tsx`
- `desktop/src-frontend/src/components/ColourDialog.tsx`

## SQLite Model

The project uses a single recursive `tree_nodes` table for both major trees.

Important node types:

- `folder`
- `drawing`
- `dimension_group`

Virtual frontend-only node type:

- `drawing_page`

`drawing_page` rows are not stored in SQLite.

### `tree_nodes`

Used for:

- drawing folders;
- drawings;
- dimension folders;
- dimension groups.

Key fields:

- `tree`: `drawings` or `dimensions`
- `node_type`: `folder`, `drawing`, or `dimension_group`
- `parent_id`: recursive parent relation
- `name`
- `sort_order`
- `file_path`: drawings only
- `page_count`: drawings only
- `uom`: drawings currently use `mm`
- `colour`: dimension groups

### `measurements`

Defined for future measurement persistence and overlay support.

Measurements attach to `dimension_group` leaf nodes and reference drawings/pages:

- `dimension_group_id`
- `drawing_id`
- `page_index`
- `measurement_type`
- `geometry_json`
- `quantity`
- `uom`

Phase 1.5 does not create measurement records.

## Tauri Commands Implemented

Existing Phase 1 viewer commands retained:

- `open_document`
- `render_preview`
- `update_viewport`
- `poll_tiles`

Phase 1.5 tree/data commands:

- `get_root_nodes`
- `get_children`
- `create_folder`
- `add_drawing`
- `add_drawing_to_folder_path`
- `create_dimension_group`
- `create_dimension_group_in_folder_path`
- `delete_node`
- `rename_node`
- `update_dimension_group_colour`
- `get_measurements_for_group`

Safety behaviour:

- `delete_node` verifies the expected node type before deleting.
- `rename_node` verifies supported node types.
- `update_dimension_group_colour` verifies the target is a `dimension_group`.
- PDF metadata used when adding drawings is loaded through `pdf_renderer.exe meta`, not in-process PDFium.

## Frontend State Model

Main store:

- `desktop/src-frontend/src/store/appStore.ts`

Key state:

- `drawingRoots`
- `dimensionRoots`
- `childCache`
- `treeRevision`
- `activeDrawingId`
- `activePageIndex`
- `activePageNodeId`
- `currentDocument`
- `activeDimensionGroupId`
- `activeBreadcrumb`
- `overlayMeasurements`
- `overlayColour`

Important behaviours:

- Tree children load lazily.
- Tree mutations force a root reload and clear child cache to avoid stale expand/collapse state.
- Drawing page rows are generated virtually from page count.
- Dimension group selection loads measurements and sets overlay colour.
- If measurement data exists in future, dimension group selection can navigate to the first measurement page when it belongs to the currently opened drawing.

## Milestone Outcomes

### Milestone 1: Shell Layout

Outcome: Passed.

Implemented:

- Ribbon.
- Left column.
- Resizable vertical divider.
- Top drawing pane placeholder.
- Bottom dimension pane placeholder.
- Viewer embedded in shell.
- Phase 1 viewer still functional.

User later verified left column width and horizontal divider behaviour after fixes.

### Milestone 2: Drawing Register Tree

Outcome: Passed.

Implemented:

- SQLite migrations via `sqlx`.
- Root and child tree loading.
- Drawing register pane.
- Folder expand/collapse.
- Drawing tree persistence.

Original seeded-folder assumption was later superseded by the real project workflow addendum.

### Milestone 3: Opening Drawings From Register

Outcome: Passed.

Implemented:

- Add Drawing from in-app folder path dialog.
- Dynamic folder creation when adding drawings.
- Drawing node opens PDF in viewer.
- Drawing node exposes virtual page children.
- Sidebar page navigation.
- Remove toolbar page selector.
- Drawing and folder deletion with explicit warnings.
- Backend type verification before deletes.
- Persistence confirmed by the user.

Important fix during this milestone:

- Adding drawings originally crashed when PDF metadata was read in-process.
- The metadata path was moved to `pdf_renderer.exe meta`.
- This is now covered by `phase1-5-rendering-safety-addendum.md`.

### Milestone 4: Dimension Group Tree

Outcome: Passed.

Implemented:

- Dimension Groups pane.
- Add Folder.
- Add Dimension Group.
- Add Sub-folder.
- Rename folder/group.
- Change group colour.
- Delete folder/group with in-app destructive confirmation.
- Breadcrumb on selected group.
- Measurement loading through `get_measurements_for_group`.
- Dimension group tree persistence.
- CostX-style summary grid after user screenshot review.

Final user gate:

```text
looking good. happy with how it is working. this should satisfy the gate check for this milestone
```

### Milestone 5: Overlay Canvas And Installer

Outcome: Passed.

Implemented:

- Transparent overlay canvas in `ViewerCanvas.tsx`.
- `drawOverlays()` function.
- Overlay props passed from Zustand store through `Viewer.tsx`.
- Overlay clears when no measurements exist.
- Existing PDF tile compositor left intact.
- Installer build produced MSI and NSIS bundles.

Final user gate:

```text
confirming all manual checks pass
```

## Final Verification Evidence

The final Milestone 5 verification produced:

```text
npm.cmd run build
OK 61 modules transformed.
OK built in 791ms
```

```text
cargo build --package desktop
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.78s
```

```text
cargo build --package core --bin pdf_renderer
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.38s
```

```text
cargo tauri build
Finished `release` profile [optimized] target(s) in 4m 26s
Built application at: C:\Users\Admin\Documents\Take-it-Off\target\release\desktop.exe
Finished 2 bundles at:
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\msi\PDF CAD_0.1.0_x64_en-US.msi
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\nsis\PDF CAD_0.1.0_x64-setup.exe
```

Installer files confirmed:

```text
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\msi\PDF CAD_0.1.0_x64_en-US.msi
C:\Users\Admin\Documents\Take-it-Off\target\release\bundle\nsis\PDF CAD_0.1.0_x64-setup.exe
```

## Manual Checks Passed

The user confirmed:

- PDF opens.
- PDF remains visible after selecting a dimension group.
- Overlay is transparent when there are no measurements.
- Pan and zoom still work.
- Page navigation from drawing sidebar works.
- Two canvas elements are present in the viewer.
- No console errors were observed during the manual gate check.

## Current Known Tradeoffs

### Process-Per-Render

`pdf_renderer.exe` currently runs one render or metadata operation per process invocation.

This is stable-first. It gives a crash boundary around PDFium, but it is not the final high-performance architecture.

Future improvement should be a persistent renderer service process, not a return to in-process PDFium.

Recommended future renderer direction:

- Keep `pdf_renderer.exe` or a sibling renderer process.
- Make it persistent.
- Communicate over JSON lines, named pipes, or a local socket.
- Preserve request generation/cancellation.
- Preserve file-backed tile output or use an explicitly designed shared-memory/file cache.
- Never load PDFium in `desktop.exe`.

### Quantity And UOM Dummy Values

Dimension group `Quantity` and `UOM` columns currently show deterministic dummy UI values.

They are not persisted and are not real quantities.

Future measurement work must replace them with aggregation over `measurements`.

Reference:

- `docs/phase1-5-dimension-summary-grid-addendum.md`

### Project Templates Not Yet Implemented

Current real-project guidance is blank trees by default.

Future work may add templates for common drawing/dimension structures, but they should be explicit user actions, not hidden startup seed data.

## Recommended Next Phase Priorities

The next phase should avoid revisiting completed Phase 1.5 foundations unless a specific bug demands it.

Recommended order:

1. Introduce real project creation/opening semantics.
2. Remove or gate any remaining demo/verification seed behaviour behind explicit templates or development mode.
3. Add measurement creation tools.
4. Persist measurement geometry to `measurements.geometry_json`.
5. Replace dummy Quantity/UOM values with real aggregates.
6. Stress test with multi-page and vector-heavy PDFs.
7. Design a persistent renderer service if performance becomes the limiting factor.
8. Add export/report workflows only after measurement data is reliable.

## Definition Of Done Status

- [x] Milestone 1: Shell layout confirmed, Phase 1 viewer still works.
- [x] Milestone 2: Drawing register tree works.
- [x] Milestone 3: Drawing opens in viewer from register click and persists in SQLite.
- [x] Milestone 4: Dimension group tree interactive, CRUD persists.
- [x] Milestone 5: Overlay canvas present, no errors on dimension group click.
- [x] Phase 1 regression: pan, zoom, page navigation, tile rendering unchanged in manual verification.
- [x] `cargo tauri build` produced MSI and NSIS installers.
- [x] Dark theme consistent.
- [x] Data survives app restart.

## Future Chat Startup Checklist

Before continuing work in a future chat, read these files in this order:

1. `docs/phase1-5-completion-handover.md`
2. `docs/milestone4a-handover.md`
3. `docs/phase1-5-rendering-safety-addendum.md`
4. `docs/phase1-5-navigation-addendum.md`
5. `docs/phase1-5-project-workflow-addendum.md`
6. `docs/phase1-5-dimension-workflow-addendum.md`
7. `docs/phase1-5-dimension-summary-grid-addendum.md`
8. `desktop/src/lib.rs`
9. `desktop/src-frontend/src/store/appStore.ts`
10. `desktop/src-frontend/src/components/ViewerCanvas.tsx`
11. `desktop/src-frontend/src/components/DrawingRegisterPane.tsx`
12. `desktop/src-frontend/src/components/DimensionGroupPane.tsx`

The most important rule for future work: keep PDFium out of `desktop.exe`.
