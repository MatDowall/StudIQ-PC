# Phase 1.5 Handover: UI Shell & Data Model
## Desktop CAD/Takeoff Application — Rust + Tauri + React

---

## How To Use This Document

This spec is structured as **five sequential milestones**. Each milestone ends with a verification step that produces visible, testable proof before work on the next milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

If a verification step fails, stop, diagnose, and fix before continuing. Do not accumulate failures across milestones.

---

## Decisions Already Made — Do Not Revisit

- **Phase 1 files are not to be modified** except where explicitly instructed in this document. The tile rendering pipeline, worker threads, and IPC commands from Phase 1 must remain working throughout Phase 1.5.
- **UI framework:** React + TypeScript + Vite inside Tauri v2.
- **Styling:** Tailwind CSS utility classes only. No CSS modules, no styled-components, no external component libraries.
- **State management:** Zustand for global app state. No Redux, no Context API.
- **Database:** SQLite via `tauri-plugin-sql`. The schema in this document is authoritative.
- **Layout engine:** CSS Grid for the top-level shell. No third-party layout libraries.
- **Tree model:** Both the drawing register and dimension group tree use a single recursive adjacency-list `tree_nodes` table. There is no fixed depth limit. This matches CostX exactly.
- **Measurements attach to dimension_group leaf nodes only.** Folder nodes are organisational containers only.
- **Left pane:** Two independent panes stacked vertically — Drawing Register (top), Dimension Groups (bottom) — each with their own tab bar. Both visible simultaneously, not tabbed.
- **Dark theme throughout.** No light backgrounds anywhere in the shell.

---

## Critical Tauri v2 Rules — Read Before Writing Any Code

**Rule 1 — `main.rs` must be a thin wrapper only.**
```rust
// desktop/src/main.rs — exact content, nothing else
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    desktop_lib::run();
}
```
All commands, AppState, and builder code live in `desktop/src/lib.rs`.

**Rule 2 — Capabilities file is mandatory.**
`desktop/capabilities/default.json` must list every permission used. Without it, dialog and filesystem access fail silently.

**Rule 3 — `tauri.conf.json` must use v2 syntax only.**
No `allowlist`. `bundle.resources` is an object, not an array.

**Rule 4 — TypeScript `invoke()` types must exactly match Rust return types.**
Every `invoke<T>()` generic must match the Rust Serde output exactly. Mismatches fail silently.

**Rule 5 — Plugin imports use the plugin package.**
```typescript
// CORRECT
import { open } from "@tauri-apps/plugin-dialog";
// WRONG
import { open } from "@tauri-apps/api/dialog";
```

**Rule 6 — Every plugin must be initialised in the builder.**
A plugin in `Cargo.toml` that is not added with `.plugin(tauri_plugin_name::init())` silently does nothing.

---

## New Dependencies

### `desktop/Cargo.toml` — add to existing
```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
```

### `desktop/src-frontend/package.json` — add to existing
```json
{
  "dependencies": {
    "zustand": "^4.5.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "@tauri-apps/plugin-sql": "^2.0.0"
  }
}
```

### `desktop/capabilities/default.json` — update to include new permissions
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

## SQLite Schema

Run these migrations on app startup before any other database operation.
All Phase 1.5 and future data lives in this schema. Do not alter column names or types.

```sql
-- Single recursive node table for both drawing register and dimension group trees.
-- tree = 'drawings' : node_type is 'folder' or 'drawing'
-- tree = 'dimensions': node_type is 'folder' or 'dimension_group'
-- parent_id = NULL means root level node

CREATE TABLE IF NOT EXISTS tree_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tree        TEXT    NOT NULL,
    node_type   TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT,           -- drawings only
    page_count  INTEGER,        -- drawings only
    uom         TEXT,           -- drawings only (e.g. 'mm')
    colour      TEXT DEFAULT '#4A9EFF',  -- dimension_group nodes only
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent
    ON tree_nodes(parent_id, tree, sort_order);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_tree
    ON tree_nodes(tree, node_type);

-- Measurements: populated by Phase 2. Schema defined now for FK integrity.
-- Do not implement measurement creation in Phase 1.5.
CREATE TABLE IF NOT EXISTS measurements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension_group_id  INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    drawing_id          INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    page_index          INTEGER NOT NULL,
    measurement_type    TEXT    NOT NULL,   -- 'linear', 'area', 'count', 'volume'
    geometry_json       TEXT    NOT NULL,   -- JSON [{x,y},...] in page coordinates
    quantity            REAL,
    uom                 TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_measurements_group
    ON measurements(dimension_group_id);
```

### Seed Data

On first launch (when `tree_nodes` table is empty), insert this seed data so the
app opens with a realistic structure matching the CostX screenshot:

**Drawing register seed:**
```sql
-- Root discipline folders
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
VALUES
  ('drawings', 'folder', NULL, 'ARCHITECTURE', 0),
  ('drawings', 'folder', NULL, 'SITE', 1),
  ('drawings', 'folder', NULL, 'MEP', 2),
  ('drawings', 'folder', NULL, 'STRUCTURAL', 3);

-- Sub-folders under ARCHITECTURE (id=1)
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
VALUES
  ('drawings', 'folder', 1, 'HOUSE PLANS', 0),
  ('drawings', 'folder', 1, 'PLANS', 1);
```

**Dimension groups seed:**
```sql
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
VALUES
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

-- Children of 00 GENERAL (id will be 5 after drawing seeds, adjust with subquery)
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'dimension_group', id, 'GFA', 0
FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions';

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'dimension_group', id, 'ROOMS', 1
FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions';

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'dimension_group', id, 'SITE', 2
FROM tree_nodes WHERE name = '00 GENERAL' AND tree = 'dimensions';

-- Sub-folder and items under 11 INTERIOR DOORS
INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'folder', id, '11.01 INTERIOR DOORS', 0
FROM tree_nodes WHERE name = '11 INTERIOR DOORS' AND tree = 'dimensions';

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'dimension_group', id, 'Timber Doors', 0
FROM tree_nodes WHERE name = '11.01 INTERIOR DOORS' AND tree = 'dimensions';

INSERT INTO tree_nodes (tree, node_type, parent_id, name, sort_order)
SELECT 'dimensions', 'folder', id, '11.07 FIRE RATED DOORS', 1
FROM tree_nodes WHERE name = '11 INTERIOR DOORS' AND tree = 'dimensions';
```

---

## Tauri Commands — New in Phase 1.5

Add to `desktop/src/lib.rs`. Do not modify Phase 1 commands.

```rust
// ── Tree node DTO ──────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct TreeNodeDto {
    pub id: i64,
    pub tree: String,
    pub node_type: String,       // "folder", "drawing", "dimension_group"
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
    pub has_children: bool,      // precomputed — avoids extra round trip
    // drawing fields
    pub file_path: Option<String>,
    pub page_count: Option<i64>,
    pub uom: Option<String>,
    // dimension_group fields
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

// ── Commands ───────────────────────────────────────────────────────────────

/// Returns all root-level nodes for a tree with has_children populated
#[tauri::command]
pub async fn get_root_nodes(
    tree: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TreeNodeDto>, String>

/// Returns direct children of a node (called on folder expand)
#[tauri::command]
pub async fn get_children(
    parent_id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TreeNodeDto>, String>

/// Creates a folder node in either tree
#[tauri::command]
pub async fn create_folder(
    tree: String,
    parent_id: Option<i64>,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<TreeNodeDto, String>

/// Creates a drawing node in the drawings tree
#[tauri::command]
pub async fn add_drawing(
    parent_id: Option<i64>,
    name: String,
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<TreeNodeDto, String>

/// Creates a dimension_group leaf node in the dimensions tree
#[tauri::command]
pub async fn create_dimension_group(
    parent_id: Option<i64>,
    name: String,
    colour: String,
    state: tauri::State<'_, AppState>,
) -> Result<TreeNodeDto, String>

/// Renames any node
#[tauri::command]
pub async fn rename_node(
    node_id: i64,
    name: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String>

/// Deletes any node — SQLite CASCADE handles descendants and measurements
#[tauri::command]
pub async fn delete_node(
    node_id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<(), String>

/// Returns measurements for a dimension group — used by viewer overlay
#[tauri::command]
pub async fn get_measurements_for_group(
    group_id: i64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<MeasurementDto>, String>
```

---

## Layout Specification

### Shell Structure

```
┌──────────────────────────────────────────────────────────────────┐
│  RIBBON (48px, full width, spans both columns)                   │
├──────────────────────┬───────────────────────────────────────────┤
│  DRAWING REGISTER    │                                           │
│  [Drawings][Layers]  │                                           │
│  [Model][Views]      │                                           │
│  ── folder tree ──   │         VIEWER                            │
│  (scrollable)        │         (Phase 1 canvas, unchanged)       │
├──────────────────────┤                                           │
│  DIMENSION GROUPS    │                                           │
│  [Dim Groups]        │                                           │
│  [Dimensions]        │                                           │
│  [Auto Count]        │                                           │
│  Current: path/...   │                                           │
│  ── group tree ──    │                                           │
│  Name   Qty   UOM    │                                           │
└──────────────────────┴───────────────────────────────────────────┘
```

### CSS Grid

```tsx
// App.tsx
<div className="grid h-screen w-screen overflow-hidden"
     style={{ gridTemplateRows: '48px 1fr', gridTemplateColumns: `${leftWidth}px 1fr` }}>
  <Ribbon />           {/* row 1, col 1-2 */}
  <LeftColumn />       {/* row 2, col 1 */}
  <ViewerContainer />  {/* row 2, col 2 */}
</div>
```

- Left column default width: 320px. Resizable by dragging right edge (min 220px, max 480px).
- Left column is split into two panes by a draggable horizontal divider (default 50/50).
- Each pane scrolls independently.
- Viewer fills remaining space completely — no padding or margin.

---

## Visual Design Tokens

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
  treeIndent:    16,    // px per nesting level
  rowHeight:     22,    // px — compact like CostX
  ribbonHeight:  48,    // px
  tabHeight:     28,    // px
  leftPaneWidth: 320,   // px default
}
```

Apply these values via inline styles or Tailwind arbitrary values. Do not introduce
a CSS variables file — keep all theme values in this single TypeScript object.

---

## Component Specifications

### `Ribbon.tsx`

Single horizontal bar. Tool groups separated by vertical dividers.

| Group | Tools (Phase 1.5) |
|---|---|
| Dimension Group | Add (active), Properties (disabled), Copy (disabled), Import (disabled), Export (disabled) |
| BIM | Check BIM Objects (disabled), Show All Objects (disabled) |
| Dimension | Add (disabled), Copy (disabled), Select In Area (disabled), Edit Controls (disabled) |
| Type | Line (highlighted as current tool), Point (disabled), Object (disabled) |
| Zones | Edit Zones (disabled) |
| Snap | Geometry (disabled), Angle (disabled), Rebar (disabled) |
| Mode | Measured (active toggle), Legend (disabled) |
| Show | Labels (disabled), Markups (disabled), Properties on Add (disabled) |

- Active: clickable, full opacity
- Disabled: visible, `opacity-35`, `cursor-not-allowed`, no click handler
- Each tool: icon (20px) above label (10px, `#CCCCCC`)
- Group label: 9px uppercase `#888888` centred below the group tools
- Group divider: `1px solid #444444`

### `LeftColumn.tsx`

Container for two stacked resizable panes. Renders:
- `<DrawingRegisterPane />` in the top half
- A draggable horizontal divider (4px hit area, `cursor-row-resize`)
- `<DimensionGroupPane />` in the bottom half

Track split position in local React state. Min height per pane: 120px.

### `DrawingRegisterPane.tsx`

**Tab bar:** `[ Drawings ] [ Layers ] [ Model ] [ Views ]`
- Only Drawings tab is functional. Others render as disabled placeholders.
- Use CSS `display: none` to hide inactive tab content — do not unmount.
- Active tab: `border-b-2 border-[#4A9EFF] text-[#CCCCCC]`
- Inactive tab: `text-[#888888] opacity-50 cursor-not-allowed`

**Tree:** Recursive folder tree using `<TreeNode />` component.
- Folder node: `▶/▼` triangle + folder icon + name. Starts collapsed.
- Drawing node: document icon + name + UOM column value.
- Active drawing row: background `#094771`.
- Right-click folder: context menu — Add Sub-folder, Add Drawing, Rename, Delete.
- Right-click drawing: context menu — Rename, Remove.
- Clicking a drawing: calls `open_document` Tauri command (Phase 1), updates active drawing in store.

**Lazy loading:** Call `get_children(parentId)` only when a folder is expanded for
the first time. Cache children in Zustand store — do not re-fetch on every expand.

### `DimensionGroupPane.tsx`

**Tab bar:** `[ Dimension Groups ] [ Dimensions ] [ Auto Count ]`
- Only Dimension Groups tab is functional. Others are disabled placeholders.

**Breadcrumb bar** (below tab bar):
```
Current:  11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors
```
- `Current:` label in `#888888`, path in `#CCCCCC`, font-size 11px.
- Truncates from left with ellipsis if overflow.
- Blank when nothing selected.
- Updates immediately on node click.

**Column headers:** Name | Quantity | UOM
- Name column takes remaining width. Quantity and UOM are fixed at 60px and 40px.

**Tree:** Recursive using same `<TreeNode />` component.
- Folder node: triangle + folder icon + name. Starts expanded (dimension groups
  should be visible on first open, unlike drawing register which starts collapsed).
- Dimension group leaf node: `#` icon + name + Quantity (blank until Phase 2) + UOM.
- Active item row: background `#094771`.
- Right-click folder: Add Sub-folder, Add Dimension Group, Rename, Delete Folder.
- Right-click dimension group: Rename, Delete.

**On dimension group click:**
1. Set active item in Zustand store
2. Update breadcrumb — build path by walking up parent chain
3. Call `get_measurements_for_group(groupId)`
4. If measurements exist: navigate viewer to `measurements[0].page_index`
5. Pass measurements and group colour to viewer overlay renderer
6. If no measurements: clear overlay (Phase 2 will populate them)

### `TreeNode.tsx`

Shared recursive component used by both trees. Props:

```typescript
interface TreeNodeProps {
  node: TreeNodeDto;
  depth: number;            // current nesting level, starts at 0
  activeNodeId: number | null;
  onNodeClick: (node: TreeNodeDto) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNodeDto) => void;
}
```

- Indent: `depth * 16px` left padding
- Row height: 22px
- Expand/collapse toggle: call `get_children` on first expand, cache result
- Renders children recursively when expanded

### `ContextMenu.tsx`

Reusable floating context menu. Renders at mouse position on right-click.
Closes on click outside or Escape key.

```typescript
interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean }[];
  onClose: () => void;
}
```

- Background: `#2D2D2D`, border `1px solid #444`
- Item height: 28px, padding `0 12px`
- Hover: background `#094771`
- Danger item (Delete): text `#F44747`
- Renders via `ReactDOM.createPortal` into `document.body`

### `ViewerContainer.tsx`

Thin wrapper around the Phase 1 `<Viewer />` component. Accepts an overlay prop:

```typescript
interface ViewerContainerProps {
  overlayMeasurements: MeasurementDto[];
  overlayColour: string;
}
```

The overlay canvas sits directly above the tile canvas, same dimensions,
`pointer-events: none`, `position: absolute`.

Overlay rendering (add to `Viewer.tsx` — do not touch tile rendering code):

```typescript
function drawOverlays(
  ctx: CanvasRenderingContext2D,
  measurements: MeasurementDto[],
  colour: string,
  viewport: ViewportState
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = colour + '55';   // 33% opacity
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;

  for (const m of measurements) {
    const pts: { x: number; y: number }[] = JSON.parse(m.geometry_json);
    if (pts.length < 2) continue;
    const screen = pts.map(p => pageToScreen(p, viewport));
    ctx.beginPath();
    ctx.moveTo(screen[0].x, screen[0].y);
    screen.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
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
  // Drawing register
  drawingRoots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;   // parentId → children
  activeDrawingId: number | null;

  // Dimension groups
  dimensionRoots: TreeNodeDto[];
  activeDimensionGroupId: number | null;
  activeBreadcrumb: string;
  overlayMeasurements: MeasurementDto[];
  overlayColour: string;

  // Tree actions
  loadRoots: (tree: 'drawings' | 'dimensions') => Promise<void>;
  loadChildren: (parentId: number) => Promise<void>;
  createFolder: (tree: string, parentId: number | null, name: string) => Promise<void>;
  addDrawing: (parentId: number | null, name: string, filePath: string) => Promise<void>;
  createDimensionGroup: (parentId: number | null, name: string, colour: string) => Promise<void>;
  renameNode: (nodeId: number, name: string) => Promise<void>;
  deleteNode: (nodeId: number) => Promise<void>;

  // Viewer actions
  openDrawing: (node: TreeNodeDto) => Promise<void>;
  selectDimensionGroup: (node: TreeNodeDto, allNodes: TreeNodeDto[]) => Promise<void>;
}
```

---

## MILESTONE 1 — Shell Layout Renders

**Goal:** The app launches showing the full shell layout. No data, no functionality.
Just the visual structure matching CostX.

### What to implement
- `theme.ts`
- `App.tsx` — CSS Grid shell with placeholder panes
- `Ribbon.tsx` — all tool groups, correct active/disabled states
- `LeftColumn.tsx` — two stacked panes with draggable divider, placeholder content
- `ViewerContainer.tsx` — renders the Phase 1 `<Viewer />` component unchanged

Do not implement tree components, SQLite, or Tauri commands in this milestone.
Use hardcoded placeholder text in the left panes (e.g. "Drawing Register" and
"Dimension Groups" as labels).

### Verification
```bash
cargo tauri dev
```

Take a screenshot and confirm:
- Ribbon is visible across the top with tool groups and labels
- Left column shows two stacked panes with a draggable divider
- Viewer area fills the right side and a PDF can still be opened (Phase 1 still works)
- Left column is resizable by dragging its right edge
- Dark theme throughout — no white or light backgrounds

### Gate
**Do not proceed to Milestone 2 until the layout matches the CostX screenshot structure.**

---

## MILESTONE 2 — Drawing Register Tree with Seeded Data

**Goal:** The drawing register pane shows the seeded folder structure.
Folders expand and collapse. No drawing open functionality yet.

### What to implement
- SQLite initialisation and migration on app startup
- Seed data insertion (drawings tree only)
- `get_root_nodes` and `get_children` Tauri commands
- `DrawingRegisterPane.tsx` — tab bar + recursive tree with seeded data
- `TreeNode.tsx` — recursive tree node component
- Zustand store — `loadRoots` and `loadChildren` actions for drawings tree

### Verification
```bash
cargo tauri dev
```

Confirm in the app:
- Drawing register shows ARCHITECTURE, SITE, MEP, STRUCTURAL folders
- Clicking ARCHITECTURE expands it to show HOUSE PLANS and PLANS sub-folders
- Collapsing works
- Tab bar shows all four tabs, only Drawings is active
- Folder expand/collapse state is not lost when switching between panes

### Gate
**Do not proceed to Milestone 3 until the folder tree is interactive with seeded data.**

---

## MILESTONE 3 — Opening a Drawing from the Register

**Goal:** Right-clicking a folder and selecting "Add Drawing" opens a file picker.
The selected PDF is added to the register and clicking it opens it in the viewer.

### What to implement
- `add_drawing` Tauri command — saves drawing node to SQLite
- `ContextMenu.tsx` — reusable right-click menu
- Right-click handlers on folder and drawing nodes in `DrawingRegisterPane.tsx`
- Click handler on drawing node — calls Phase 1 `open_document` command
- Active drawing highlighted in tree
- Zustand store — `addDrawing` and `openDrawing` actions

### Verification
```bash
cargo tauri dev
```

Confirm in the app:
- Right-clicking ARCHITECTURE shows context menu: Add Sub-folder, Add Drawing, Rename, Delete
- Selecting Add Drawing opens a file picker filtered to PDF files
- After selecting a PDF, it appears in the tree under the chosen folder
- Clicking the drawing opens it in the viewer
- The drawing row is highlighted in the tree while open
- Closing and reopening the app: the drawing is still in the register (SQLite persisted)

### Gate
**Do not proceed to Milestone 4 until a drawing opens in the viewer from a register click and survives an app restart.**

---

## MILESTONE 4 — Dimension Group Tree

**Goal:** The dimension group pane shows the seeded dimension group structure.
Clicking a dimension group updates the breadcrumb. Tree management (create, rename,
delete) works and persists.

### What to implement
- Seed data insertion (dimensions tree)
- All remaining Tauri commands: `create_folder`, `create_dimension_group`,
  `rename_node`, `delete_node`, `get_measurements_for_group`
- `DimensionGroupPane.tsx` — tab bar, breadcrumb, column headers, recursive tree
- Right-click handlers for dimension group tree nodes
- Breadcrumb path builder — walk parent chain using cached node data
- Zustand store — all dimension group actions

### Verification
```bash
cargo tauri dev
```

Confirm in the app:
- Dimension group tree shows full seeded structure (00 GENERAL through 14 CEILING FINISHES)
- 11 INTERIOR DOORS expands to show 11.01 INTERIOR DOORS sub-folder
- 11.01 INTERIOR DOORS expands to show Timber Doors (# icon)
- Clicking Timber Doors updates breadcrumb to:
  `11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors`
- Right-clicking a folder shows correct context menu
- Right-clicking a dimension group shows correct context menu
- Creating a new dimension group under a folder appears immediately in the tree
- Renaming a node updates the tree immediately
- Deleting a folder shows a confirmation dialog, then removes it and all children
- All changes persist after app restart

### Gate
**Do not proceed to Milestone 5 until all tree operations work and persist.**

---

## MILESTONE 5 — Overlay Integration and Final Verification

**Goal:** Clicking a dimension group triggers the overlay canvas on the viewer.
No measurements exist yet — verify the overlay system runs without error and
clears correctly. All Definition of Done items confirmed.

### What to implement
- Overlay canvas added to `Viewer.tsx` (second canvas, `position: absolute`,
  `pointer-events: none`, same dimensions as tile canvas)
- `drawOverlays()` function as specified in the Component Specifications section
- `ViewerContainer.tsx` — passes `overlayMeasurements` and `overlayColour` from
  Zustand store to the viewer
- Overlay clears when a different dimension group is selected
- Overlay clears when page navigation changes away from the measurement page

### Verification
```bash
cargo tauri dev
```

Confirm in the app:
- Open a PDF from the drawing register
- Click a dimension group in the tree
- No JavaScript errors in the browser console (F12)
- Overlay canvas is present in the DOM (inspect element — two canvas elements stacked)
- Overlay is transparent (empty measurements) — PDF remains fully visible
- Clicking a different dimension group: breadcrumb updates, no errors
- Full regression: Phase 1 tile rendering still works — pan, zoom, page navigation
  all perform as before

### Final check — run `cargo tauri build` and confirm a distributable installer
is produced.

### Gate
**Phase 1.5 is complete when all items in the Definition of Done are confirmed.**

---

## Definition of Done

Report against every item when all five milestones are complete:

- [ ] Milestone 1: Shell layout confirmed — screenshot matches CostX structure
- [ ] Milestone 2: Drawing register tree shows seeded data, expand/collapse works
- [ ] Milestone 3: Drawing opens in viewer from register click, persists in SQLite
- [ ] Milestone 4: Dimension group tree interactive, all CRUD operations persist
- [ ] Milestone 5: Overlay canvas present, no errors on dimension group click
- [ ] Phase 1 regression: tile rendering, pan, zoom still work after all changes
- [ ] `cargo tauri build` produces a working installer
- [ ] Dark theme consistent throughout — no light backgrounds
- [ ] App opens with seeded data on first launch
- [ ] All data survives app restart (SQLite persisting correctly)

---

## Out of Scope for Phase 1.5

Do not implement:

- Measurement drawing tools of any kind
- Scale calibration
- Quantity calculation or cost rollup
- Drag and drop reordering of tree nodes
- Export to Excel or CSV
- Thumbnail generation for drawings
- Search or filter within either tree
- Multi-select
- Undo/redo
- Layers, Model, Views tab content (placeholders only)
- Dimensions, Auto Count tab content (placeholders only)
- Zone categories
