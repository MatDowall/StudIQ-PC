# Phase 1.5 Handover: UI Shell & Data Model
## Desktop CAD/Takeoff Application — Rust + Tauri + React
## Spec Version: 3 — Based on confirmed Phase 1 codebase

---

## How To Use This Document

This spec is structured as five sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

If a verification step fails, stop, diagnose, and fix before continuing.

---

## Decisions Already Made — Do Not Revisit

- **PDFium rendering runs in `pdf_renderer.exe` only.** Do not move rendering back
  into `desktop.exe` under any circumstances. This decision was made after confirmed
  in-process crashes on Windows.
- **`worker_count` stays at 1.** Do not change this value.
- **`TileData` carries `image_path`, not base64.** Do not change this.
- **Frontend uses `convertFileSrc(imagePath)` to load tile images.** Do not change this.
- **Single `<canvas>` compositor.** Do not replace with a DOM image grid.
- **Do not modify the wheel event handler in `Viewer.tsx`.** It has a known
  re-attachment pattern — leave it exactly as-is. Do not "fix" it.
- **Styling:** Tailwind CSS utility classes only. No CSS modules, no styled-components.
- **State management:** Zustand for all new global state. No Redux, no Context API.
- **Database:** SQLite via `tauri-plugin-sql`. Schema in this document is authoritative.
- **Tree model:** Single recursive `tree_nodes` table. No fixed depth limit.
- **Measurements attach to `dimension_group` leaf nodes only.**
- **Dark theme throughout.** No light backgrounds anywhere.

---

## Critical Tauri v2 Rules — Read Before Writing Any Code

**Rule 1 — `main.rs` must be a thin wrapper only.**
```rust
// desktop/src/main.rs — exact content, do not add anything here
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    desktop_lib::run();
}
```
All commands and AppState live in `desktop/src/lib.rs`.

**Rule 2 — Capabilities file controls all plugin access.**
`desktop/capabilities/default.json` must list every permission. Missing permissions
fail silently — no error message, just nothing happens.

**Rule 3 — `tauri.conf.json` uses v2 syntax only.**
No `allowlist`. `bundle.resources` is an object, not an array.

**Rule 4 — TypeScript `invoke<T>()` generics must exactly match Rust return types.**
Mismatches fail silently — frontend receives `undefined` with no error.

**Rule 5 — Plugin imports use the plugin package.**
```typescript
import { open } from "@tauri-apps/plugin-dialog";   // CORRECT
import { open } from "@tauri-apps/api/dialog";       // WRONG
```

**Rule 6 — Every plugin must be initialised in the Tauri builder.**
```rust
.plugin(tauri_plugin_sql::Builder::default().build())
.plugin(tauri_plugin_dialog::init())
.plugin(tauri_plugin_fs::init())
```

---

## Current Codebase State — Read This Before Touching Any File

The following is the exact state of the working Phase 1 codebase.
Do not contradict or break any of this.

### `desktop/src/lib.rs` — current `AppState`
```rust
pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
}
```

### Working Tauri commands — do not modify signatures
```
open_document(path: String)          → Result<DocumentMeta, String>
render_preview(page_index: u32)      → Result<PreviewData, String>
update_viewport(viewport: ViewportState) → Result<Vec<TileData>, String>
poll_tiles()                         → Result<Vec<TileData>, String>
```

### `desktop/src-frontend/src/components/Viewer.tsx` — current structure
- Single file containing: toolbar (Open button, page nav, zoom %), viewport div,
  and canvas compositor
- Canvas is a single `<canvas ref={canvasRef}>` — the sole drawing surface
- Tile images loaded via `convertFileSrc(imagePath)` into `imageCacheRef`
- Wheel handler attached via `addEventListener` (non-passive) — do not touch

---

## How to Add the Shell Without Breaking the Viewer

The current `Viewer.tsx` contains both the toolbar and the canvas in one component.
Phase 1.5 needs a shell layout around the viewer. Do this with a clean extraction:

**Step 1 — Create `ViewerCanvas.tsx`**
Extract everything below the toolbar `<div>` in `Viewer.tsx` into a new file
`ViewerCanvas.tsx`. This includes:
- All state: `zoom`, `pan`, `tiles`, `previews`, `imageVersion`, `imageCacheRef`,
  `loadingImagesRef`, `dragRef`
- All effects: tile polling, viewport update, canvas draw, resize observer,
  wheel listener
- The viewport `<div>` and `<canvas>` elements

`ViewerCanvas.tsx` accepts these props:
```typescript
interface ViewerCanvasProps {
  doc: DocumentMeta | null;
  pageIndex: number;
  onStatusChange: (status: string) => void;
  // Phase 1.5 addition — overlay measurements for dimension group highlights
  overlayMeasurements?: MeasurementDto[];
  overlayColour?: string;
}
```

**Step 2 — Update `Viewer.tsx`**
`Viewer.tsx` becomes the shell wrapper. It retains:
- `doc`, `pageIndex`, `status` state
- `handleOpen()` function
- The toolbar `<div>` with Open button and page navigation

It renders `<ViewerCanvas>` passing the required props.

**Step 3 — `App.tsx` uses the shell**
`App.tsx` renders the full layout grid. `<Viewer>` sits inside the viewer column.
`Viewer.tsx` no longer owns the full screen height — it fills its grid cell.

---

## New Dependencies

### `desktop/Cargo.toml` — add to existing dependencies
```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
```
`tauri-plugin-dialog` and `tauri-plugin-fs` are already present — do not duplicate.

### `desktop/src-frontend/package.json` — add to existing dependencies
```json
"zustand": "^4.5.0",
"@tauri-apps/plugin-sql": "^2.0.0"
```

### `desktop/capabilities/default.json` — full updated file
```json
{
  "$schema": "https://schema.tauri.app/capability/2",
  "identifier": "default",
  "description": "Default permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "dialog:allow-open",
    "fs:allow-read-all",
    "sql:allow-execute",
    "sql:allow-select",
    "sql:allow-load"
  ]
}
```

---

## SQLite Integration — `desktop/src/lib.rs`

Add a database connection pool to `AppState`:

```rust
use tauri_plugin_sql::{Builder as SqlBuilder};

pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    // Phase 1.5 addition — all other fields above are unchanged
    pub db_path: String,
}
```

Initialise in the `setup` closure after the existing path resolutions:
```rust
let db_path = app
    .path()
    .app_data_dir()
    .expect("Could not resolve app data directory")
    .join("pdfcad.db")
    .to_string_lossy()
    .to_string();
```

Add to builder before `.invoke_handler`:
```rust
.plugin(SqlBuilder::default().build())
```

Run migrations in a `setup` async block immediately after `app.manage(...)`:
```rust
// Run SQLite migrations
{
    let db_path = format!("sqlite:{}", db_path_clone);
    tauri::async_runtime::block_on(async {
        let db = tauri_plugin_sql::Database::connect(&db_path)
            .await
            .expect("Failed to connect to database");
        run_migrations(&db).await.expect("Migration failed");
        run_seed_if_empty(&db).await.expect("Seed failed");
    });
}
```

---

## SQLite Schema

```sql
-- Recursive node table for both drawing register and dimension group trees
CREATE TABLE IF NOT EXISTS tree_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tree        TEXT    NOT NULL,           -- 'drawings' or 'dimensions'
    node_type   TEXT    NOT NULL,           -- 'folder', 'drawing', 'dimension_group'
    parent_id   INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT,                       -- drawings only
    page_count  INTEGER,                    -- drawings only
    uom         TEXT,                       -- drawings only e.g. 'mm'
    colour      TEXT    DEFAULT '#4A9EFF',  -- dimension_group only
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent
    ON tree_nodes(parent_id, tree, sort_order);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_tree
    ON tree_nodes(tree, node_type);

-- Populated by Phase 2. Defined now for FK integrity only.
CREATE TABLE IF NOT EXISTS measurements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension_group_id  INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    drawing_id          INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    page_index          INTEGER NOT NULL,
    measurement_type    TEXT    NOT NULL,
    geometry_json       TEXT    NOT NULL,
    quantity            REAL,
    uom                 TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_measurements_group
    ON measurements(dimension_group_id);
```

### Seed Data

Insert only when `tree_nodes` table is empty (first launch):

```sql
-- Drawing register: discipline folders
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order) VALUES
  ('drawings', 'folder', NULL, 'ARCHITECTURE', 0),
  ('drawings', 'folder', NULL, 'SITE', 1),
  ('drawings', 'folder', NULL, 'MEP', 2),
  ('drawings', 'folder', NULL, 'STRUCTURAL', 3);

-- ARCHITECTURE sub-folders (parent_id = id of ARCHITECTURE row)
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'drawings', 'folder', id, 'HOUSE PLANS', 0
  FROM tree_nodes WHERE name = 'ARCHITECTURE' AND tree = 'drawings' LIMIT 1;

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'drawings', 'folder', id, 'PLANS', 1
  FROM tree_nodes WHERE name = 'ARCHITECTURE' AND tree = 'drawings' LIMIT 1;

-- Dimension groups: top-level folders
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order) VALUES
  ('dimensions', 'folder', NULL, '00 GENERAL', 0),
  ('dimensions', 'folder', NULL, '01 SITE PREPARATION', 1),
  ('dimensions', 'folder', NULL, '02 SUBSTRUCTURE', 2),
  ('dimensions', 'folder', NULL, '03 FRAME', 3),
  ('dimensions', 'folder', NULL, '05 UPPER FLOORS', 4),
  ('dimensions', 'folder', NULL, '06 ROOF', 5),
  ('dimensions', 'folder', NULL, '07 EXTERIOR WALLS', 6),
  ('dimensions', 'folder', NULL, '08 WINDOWS & EXTERIOR DOORS', 7),
  ('dimensions', 'folder', NULL, '09 STAIRS & BALUSTRADES', 8),
  ('dimensions', 'folder', NULL, '10 INTERIOR WALLS', 9),
  ('dimensions', 'folder', NULL, '11 INTERIOR DOORS', 10),
  ('dimensions', 'folder', NULL, '14 CEILING FINISHES', 11);

-- 00 GENERAL leaf items
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'dimension_group', id, 'GFA', 0
  FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions' LIMIT 1;

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'dimension_group', id, 'ROOMS', 1
  FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions' LIMIT 1;

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'dimension_group', id, 'SITE', 2
  FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions' LIMIT 1;

-- 11 INTERIOR DOORS sub-structure
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'folder', id, '11.01 INTERIOR DOORS', 0
  FROM tree_nodes WHERE name = '11 INTERIOR DOORS' AND tree = 'dimensions' LIMIT 1;

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'dimension_group', id, 'Timber Doors', 0
  FROM tree_nodes WHERE name = '11.01 INTERIOR DOORS' AND tree = 'dimensions' LIMIT 1;

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
  SELECT 'dimensions', 'folder', id, '11.07 FIRE RATED DOORS', 1
  FROM tree_nodes WHERE name = '11 INTERIOR DOORS' AND tree = 'dimensions' LIMIT 1;
```

---

## New Tauri Commands

Add to `desktop/src/lib.rs`. Do not modify existing command signatures.
All new commands use `async fn` and accept `tauri::State<'_, AppState>`.

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct TreeNodeDto {
    pub id: i64,
    pub tree: String,
    pub node_type: String,        // "folder", "drawing", "dimension_group"
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
    pub has_children: bool,
    pub file_path: Option<String>,
    pub page_count: Option<i64>,
    pub uom: Option<String>,
    pub colour: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct MeasurementDto {
    pub id: i64,
    pub dimension_group_id: i64,
    pub drawing_id: i64,
    pub page_index: i64,
    pub measurement_type: String,
    pub geometry_json: String,
    pub quantity: Option<f64>,
    pub uom: Option<String>,
}

// Returns root-level nodes for a tree with has_children populated
#[tauri::command]
pub async fn get_root_nodes(tree: String, state: tauri::State<'_, AppState>)
    -> Result<Vec<TreeNodeDto>, String>

// Returns direct children of a node — called on folder expand
#[tauri::command]
pub async fn get_children(parent_id: i64, state: tauri::State<'_, AppState>)
    -> Result<Vec<TreeNodeDto>, String>

// Creates a folder node in either tree
#[tauri::command]
pub async fn create_folder(
    tree: String, parent_id: Option<i64>, name: String,
    state: tauri::State<'_, AppState>
) -> Result<TreeNodeDto, String>

// Creates a drawing node — drawings tree only
#[tauri::command]
pub async fn add_drawing(
    parent_id: Option<i64>, name: String, file_path: String,
    state: tauri::State<'_, AppState>
) -> Result<TreeNodeDto, String>

// Creates a dimension_group leaf node — dimensions tree only
#[tauri::command]
pub async fn create_dimension_group(
    parent_id: Option<i64>, name: String, colour: String,
    state: tauri::State<'_, AppState>
) -> Result<TreeNodeDto, String>

// Renames any node
#[tauri::command]
pub async fn rename_node(node_id: i64, name: String, state: tauri::State<'_, AppState>)
    -> Result<(), String>

// Deletes any node — SQLite CASCADE handles all descendants and measurements
#[tauri::command]
pub async fn delete_node(node_id: i64, state: tauri::State<'_, AppState>)
    -> Result<(), String>

// Returns measurements for a dimension group — used by viewer overlay
#[tauri::command]
pub async fn get_measurements_for_group(group_id: i64, state: tauri::State<'_, AppState>)
    -> Result<Vec<MeasurementDto>, String>
```

Add all new commands to `.invoke_handler`:
```rust
.invoke_handler(tauri::generate_handler![
    open_document,
    render_preview,
    update_viewport,
    poll_tiles,
    // Phase 1.5 additions
    get_root_nodes,
    get_children,
    create_folder,
    add_drawing,
    create_dimension_group,
    rename_node,
    delete_node,
    get_measurements_for_group,
])
```

---

## Layout Specification

### Shell Grid

```
┌──────────────────────────────────────────────────────────────────┐
│  RIBBON (48px, spans full width)                                 │
├──────────────────────┬───────────────────────────────────────────┤
│  DRAWING REGISTER    │                                           │
│  [Drawings][Layers]  │                                           │
│  [Model][Views]      │                                           │
│  ── folder tree ──   │         VIEWER CANVAS                     │
│                      │         (ViewerCanvas.tsx — unchanged)    │
├──────────────────────┤                                           │
│  DIMENSION GROUPS    │                                           │
│  [Dim Groups]        │                                           │
│  [Dimensions]        │                                           │
│  [Auto Count]        │                                           │
│  Current: path/...   │                                           │
│  ── group tree ──    │                                           │
│  Name    Qty   UOM   │                                           │
└──────────────────────┴───────────────────────────────────────────┘
```

```tsx
// App.tsx
<div style={{
  display: 'grid',
  gridTemplateRows: '48px 1fr',
  gridTemplateColumns: `${leftWidth}px 1fr`,
  height: '100vh',
  width: '100vw',
  overflow: 'hidden',
  background: '#1E1E1E',
}}>
  <Ribbon />           {/* row 1, spans cols 1-2 */}
  <LeftColumn />       {/* row 2, col 1 */}
  <Viewer />           {/* row 2, col 2 — now fills its grid cell */}
</div>
```

- Left column: 320px default, resizable (min 220px, max 480px) by dragging right edge
- Left column split into two stacked panes with draggable horizontal divider
- Viewer fills remaining width and height completely

---

## Design Tokens

```typescript
// src/theme.ts
export const theme = {
  bg: {
    shell:   '#1E1E1E',
    pane:    '#252526',
    ribbon:  '#2B2B2B',
    hover:   '#2D2D2D',
    active:  '#094771',
    input:   '#3C3C3C',
    tabBar:  '#2D2D2D',
  },
  text: {
    primary:   '#CCCCCC',
    secondary: '#888888',
    disabled:  '#555555',
    accent:    '#4A9EFF',
  },
  border: {
    subtle:  '#333333',
    divider: '#444444',
  },
  accent:        '#4A9EFF',
  danger:        '#F44747',
  treeIndent:    16,
  rowHeight:     22,
  ribbonHeight:  48,
  tabHeight:     28,
  leftPaneWidth: 320,
}
```

---

## Component Specifications

### `Ribbon.tsx`

| Group | Tools |
|---|---|
| Dimension Group | Add (active), Properties (disabled), Copy (disabled), Import (disabled), Export (disabled) |
| BIM | Check BIM Objects (disabled), Show All Objects (disabled) |
| Dimension | Add (disabled), Copy (disabled), Select In Area (disabled), Edit Controls (disabled) |
| Type | Line (highlighted), Point (disabled), Object (disabled) |
| Zones | Edit Zones (disabled) |
| Snap | Geometry (disabled), Angle (disabled), Rebar (disabled) |
| Mode | Measured (active toggle), Legend (disabled) |
| Show | Labels (disabled), Markups (disabled), Properties on Add (disabled) |

### `LeftColumn.tsx`

Two stacked resizable panes. Renders:
- `<DrawingRegisterPane />` top
- Draggable horizontal divider (4px hit area, `cursor-row-resize`)
- `<DimensionGroupPane />` bottom

Min height per pane: 120px. Store split ratio in local state.

### `DrawingRegisterPane.tsx`

**Tabs:** `[ Drawings ] [ Layers ] [ Model ] [ Views ]`
Only Drawings functional. Use `display: none` to hide inactive tab content.

**Tree behaviour:**
- Folder: expand/collapse on click. Starts collapsed.
- Drawing: highlight on click, call `open_document` Phase 1 command
- Right-click folder: Add Sub-folder, Add Drawing, Rename, Delete
- Right-click drawing: Rename, Remove
- Load children lazily on first expand via `get_children`

### `DimensionGroupPane.tsx`

**Tabs:** `[ Dimension Groups ] [ Dimensions ] [ Auto Count ]`
Only Dimension Groups functional.

**Breadcrumb** (below tabs):
```
Current:  11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors
```
Font 11px. `Current:` in `#888888`, path in `#CCCCCC`. Left-truncate on overflow.

**Column headers:** Name (flex) | Quantity (60px) | UOM (40px)

**Tree behaviour:**
- Folder: expand/collapse. Starts expanded.
- Dimension group leaf (`#` icon): on click:
  1. Highlight row, update breadcrumb
  2. Call `get_measurements_for_group`
  3. Pass measurements and colour to `ViewerCanvas` overlay props
  4. If measurements exist, navigate viewer to `measurements[0].page_index`

### `TreeNode.tsx`

Shared recursive component for both trees:

```typescript
interface TreeNodeProps {
  node: TreeNodeDto;
  depth: number;
  activeNodeId: number | null;
  onNodeClick: (node: TreeNodeDto) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNodeDto) => void;
}
```

Row height 22px. Indent `depth * 16px`. Expand triangle calls `get_children`
on first expand. Renders children recursively when expanded.

### `ContextMenu.tsx`

```typescript
interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean }[];
  onClose: () => void;
}
```

Rendered via `ReactDOM.createPortal` into `document.body`.
Close on click outside or Escape. Danger items: text `#F44747`.

### `ViewerCanvas.tsx` (extracted from `Viewer.tsx`)

Overlay canvas additions only — do not alter any existing tile rendering logic:

```typescript
// Two stacked canvases:
// 1. tileCanvasRef  — existing tile compositor (unchanged)
// 2. overlayCanvasRef — new, position: absolute, pointer-events: none

function drawOverlays(
  ctx: CanvasRenderingContext2D,
  measurements: MeasurementDto[],
  colour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (measurements.length === 0) return;

  const pageLeft = -pan.x;
  const pageTop  = -pan.y;
  const scaleX = (page.width_pts * zoom * 96) / (72 * page.width_pts);
  const scaleY = (page.height_pts * zoom * 96) / (72 * page.height_pts);

  ctx.fillStyle   = colour + '55';
  ctx.strokeStyle = colour;
  ctx.lineWidth   = 2;

  for (const m of measurements) {
    const pts: { x: number; y: number }[] = JSON.parse(m.geometry_json);
    if (pts.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(pageLeft + pts[0].x * scaleX, pageTop + pts[0].y * scaleY);
    for (const p of pts.slice(1)) {
      ctx.lineTo(pageLeft + p.x * scaleX, pageTop + p.y * scaleY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}
```

---

## Zustand Store

```typescript
// src/store/appStore.ts
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

interface AppStore {
  drawingRoots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;
  activeDrawingId: number | null;

  dimensionRoots: TreeNodeDto[];
  activeDimensionGroupId: number | null;
  activeBreadcrumb: string;
  overlayMeasurements: MeasurementDto[];
  overlayColour: string;

  loadRoots: (tree: 'drawings' | 'dimensions') => Promise<void>;
  loadChildren: (parentId: number) => Promise<void>;
  createFolder: (tree: string, parentId: number | null, name: string) => Promise<void>;
  addDrawing: (parentId: number | null, name: string, filePath: string) => Promise<void>;
  createDimensionGroup: (parentId: number | null, name: string, colour: string) => Promise<void>;
  renameNode: (nodeId: number, name: string) => Promise<void>;
  deleteNode: (nodeId: number) => Promise<void>;
  openDrawing: (node: TreeNodeDto) => Promise<void>;
  selectDimensionGroup: (node: TreeNodeDto) => Promise<void>;
}
```

---

## File List

Files to create (new):
1. `desktop/src-frontend/src/theme.ts`
2. `desktop/src-frontend/src/store/appStore.ts`
3. `desktop/src-frontend/src/App.tsx`
4. `desktop/src-frontend/src/components/Ribbon.tsx`
5. `desktop/src-frontend/src/components/LeftColumn.tsx`
6. `desktop/src-frontend/src/components/DrawingRegisterPane.tsx`
7. `desktop/src-frontend/src/components/DimensionGroupPane.tsx`
8. `desktop/src-frontend/src/components/TreeNode.tsx`
9. `desktop/src-frontend/src/components/ContextMenu.tsx`
10. `desktop/src-frontend/src/components/ViewerCanvas.tsx`

Files to modify (existing):
11. `desktop/src/lib.rs` — add SQLite, new commands, new AppState field
12. `desktop/src-frontend/src/components/Viewer.tsx` — extract canvas to
    `ViewerCanvas.tsx`, retain toolbar and page nav, render `<ViewerCanvas>`
13. `desktop/capabilities/default.json` — add SQL permissions
14. `desktop/Cargo.toml` — add `tauri-plugin-sql`
15. `desktop/src-frontend/package.json` — add zustand and plugin-sql

---

## MILESTONE 1 — Shell Layout Renders

**Goal:** App launches showing the full layout. No data, no functionality.
Visual structure only. Phase 1 viewer still works.

**Implement:** `theme.ts`, `App.tsx`, `Ribbon.tsx`, `LeftColumn.tsx` (placeholder
content in both panes), `ViewerCanvas.tsx` extraction from `Viewer.tsx`.

**Do not implement** SQLite, tree components, or Tauri commands in this milestone.

**Verification:**
```powershell
cargo build --package core --bin pdf_renderer
cargo build --package desktop
npm --prefix desktop/src-frontend run build
Start-Process -FilePath ".\target\debug\desktop.exe" -WorkingDirectory "C:\Users\Admin\Documents\Take-it-Off"
```

Confirm:
- Ribbon visible across the top with tool group labels
- Left column shows two stacked panes with draggable divider
- Right side shows the viewer area
- Opening a PDF still works — pan, zoom, page navigation all functional
- Dark theme throughout — no white or light backgrounds

**Gate: do not proceed until layout is confirmed and Phase 1 viewer still works.**

---

## MILESTONE 2 — Drawing Register Tree with Seeded Data

**Goal:** Drawing register shows folder structure. Expand/collapse works.
No open-drawing functionality yet.

**Implement:** SQLite init + migrations + drawing register seed data,
`get_root_nodes` and `get_children` commands, `DrawingRegisterPane.tsx`,
`TreeNode.tsx`, Zustand store `loadRoots`/`loadChildren` for drawings.

**Verification:**
Confirm in app:
- Drawing register shows ARCHITECTURE, SITE, MEP, STRUCTURAL
- ARCHITECTURE expands to show HOUSE PLANS and PLANS
- Collapse works
- Only Drawings tab is active; others are visible but disabled
- Tree state preserved when resizing panes

**Gate: do not proceed until folder tree is interactive with seeded data.**

---

## MILESTONE 3 — Opening a Drawing from the Register

**Goal:** Right-click adds a drawing. Clicking a drawing opens it in the viewer.
Data persists after app restart.

**Implement:** `add_drawing` command, `ContextMenu.tsx`, right-click handlers,
drawing click handler calling Phase 1 `open_document`, active row highlight,
Zustand `addDrawing` and `openDrawing` actions.

**Verification:**
Confirm in app:
- Right-clicking ARCHITECTURE shows context menu
- Add Drawing opens file picker filtered to PDF
- Selected PDF appears in tree under chosen folder
- Clicking the drawing opens it in the viewer (pan/zoom still work)
- Active drawing row is highlighted
- Restart app — drawing is still in register

**Gate: do not proceed until drawing opens in viewer from register click
and survives restart.**

---

## MILESTONE 4 — Dimension Group Tree

**Goal:** Dimension group tree shows seeded data. All CRUD operations work.
Breadcrumb updates on selection. Everything persists.

**Implement:** Dimension groups seed data, remaining Tauri commands
(`create_folder`, `create_dimension_group`, `rename_node`, `delete_node`,
`get_measurements_for_group`), `DimensionGroupPane.tsx`, right-click handlers,
breadcrumb path builder, Zustand dimension group actions.

**Verification:**
Confirm in app:
- Full seeded structure visible (00 GENERAL through 14 CEILING FINISHES)
- 11 INTERIOR DOORS → 11.01 INTERIOR DOORS → Timber Doors visible
- Clicking Timber Doors updates breadcrumb to:
  `11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors`
- Create new dimension group under a folder — appears immediately
- Rename a node — updates immediately
- Delete a folder — confirmation dialog shown, removes folder and children
- All changes persist after app restart

**Gate: do not proceed until all tree operations work and persist.**

---

## MILESTONE 5 — Overlay Canvas and Final Verification

**Goal:** Overlay canvas wired up. No errors when dimension group is clicked.
Full regression confirms Phase 1 still works. Build produces installer.

**Implement:** Overlay canvas in `ViewerCanvas.tsx`, `drawOverlays()` function,
`ViewerContainer` passes overlay props from Zustand store to `ViewerCanvas`,
overlay clears on dimension group change.

**Verification:**
Confirm in app:
- Open a PDF, then click a dimension group
- No JavaScript errors in browser console (F12 → Console)
- Two canvas elements visible in DOM (F12 → Elements — one tile, one overlay)
- Overlay is transparent — PDF fully visible (no measurements yet)
- Pan, zoom, page navigation all still work
- Tile rendering unchanged from Phase 1 behaviour

Then run:
```powershell
cargo tauri build
```
Confirm installer is produced in `target/release/bundle/`.

**Gate: Phase 1.5 complete when all Definition of Done items are confirmed.**

---

## Definition of Done

- [ ] Milestone 1: Shell layout confirmed, Phase 1 viewer still works
- [ ] Milestone 2: Drawing register shows seeded data, expand/collapse works
- [ ] Milestone 3: Drawing opens in viewer from register click, persists in SQLite
- [ ] Milestone 4: Dimension group tree interactive, all CRUD persists
- [ ] Milestone 5: Overlay canvas present, no errors on dimension group click
- [ ] Phase 1 regression: pan, zoom, page nav, tile rendering all unchanged
- [ ] `cargo tauri build` produces a working installer
- [ ] Dark theme consistent — no light backgrounds
- [ ] All data survives app restart

---

## Out of Scope for Phase 1.5

Do not implement:
- Measurement drawing tools
- Scale calibration
- Quantity calculation or cost rollup
- Drag and drop reordering
- Export to Excel or CSV
- Thumbnail generation
- Search or filter within trees
- Multi-select
- Undo/redo
- Layers, Model, Views tab content
- Dimensions, Auto Count tab content
