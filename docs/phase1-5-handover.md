# Phase 1.5 Handover: UI Shell & Dimension Group Data Model
## Desktop CAD/Takeoff Application — Rust + Tauri + React

---

## Decisions Already Made — Do Not Revisit

- **Rendering engine:** Complete from Phase 1. Do not modify any Phase 1 files unless explicitly required by this spec.
- **UI framework:** React + TypeScript + Vite inside Tauri v2. No other framework.
- **Styling:** Tailwind CSS utility classes only. No CSS modules, no styled-components, no external component libraries.
- **State management:** Zustand for global app state. No Redux, no Context API for shared state.
- **Database:** SQLite via `tauri-plugin-sql`. The schema defined in this document is authoritative. Do not alter it.
- **Layout engine:** CSS Grid for the top-level shell layout. No third-party layout libraries.
- **Tree model:** Both the drawing register and dimension group tree use a single recursive adjacency-list node table. There is no fixed hierarchy depth. Folders are containers; Dimension Groups are leaf nodes where measurements attach. This mirrors exactly how CostX works.
- **Measurements attach to Dimension Groups only — never to Folders.** Folders are organisational only.
- **Drawing register folders:** Arbitrarily nestable. No fixed discipline-only constraint.
- **Left pane split:** Two independent panes stacked vertically — Drawing Register (top) and Dimension Groups (bottom) — each with their own tab bar, matching the CostX layout exactly.

---

## Context & Goal

Phase 1.5 builds the **application shell** on top of the Phase 1 rendering engine. The goal is a pixel-accurate replication of the CostX working environment:

- A **top ribbon toolbar** with labelled tool groups
- A **left split pane** — top half is the Drawing Register with folder tree; bottom half is the Dimension Groups pane with its own tabs
- A **central drawing viewer** — the Phase 1 canvas, completely unchanged

When this phase is complete, a user must be able to:
1. Open the application and see the full shell layout matching CostX
2. Navigate a nestable folder tree in the Drawing Register and open a drawing into the viewer
3. Navigate the Dimension Group tree and see folders and dimension groups
4. Click a dimension group leaf node and have the viewer navigate to the correct page and highlight that group's measurements
5. Create, rename, delete, and nest folders and dimension groups in both panes

**Phase 1.5 does not implement measurement drawing tools.** It establishes the shell and the data model that Phase 2 writes into.

---

## Layout Specification

### Top-Level Shell

```
┌──────────────────────────────────────────────────────────────┐
│  RIBBON TOOLBAR (48px height, full width)                    │
├─────────────────────┬────────────────────────────────────────┤
│  DRAWING REGISTER   │                                        │
│  [Drawings][Layers] │                                        │
│  [Model][Views]     │                                        │
│                     │         VIEWER (Phase 1 canvas)        │
│  folder tree...     │                                        │
├─────────────────────┤                                        │
│  DIMENSION GROUPS   │                                        │
│  [Dim Groups]       │                                        │
│  [Dimensions]       │                                        │
│  [Auto Count]       │                                        │
│                     │                                        │
│  Current: path/... ←── breadcrumb bar                       │
│  folder/group tree  │                                        │
│  Name    Qty   UOM  │                                        │
└─────────────────────┴────────────────────────────────────────┘
```

- Shell fills 100vw × 100vh. No outer scrollbars.
- Left column is fixed at 320px default, resizable by dragging (min 220px, max 480px).
- Left column is split into two panes stacked vertically. The divider between them is draggable (default 50/50 split).
- Viewer fills all remaining width and height.
- Ribbon is always visible and does not scroll.

### CSS Grid Structure

```tsx
// App.tsx
<div style={{
  display: 'grid',
  gridTemplateRows: '48px 1fr',
  gridTemplateColumns: '320px 1fr',
  height: '100vh',
  width: '100vw',
  overflow: 'hidden'
}}>
  <Ribbon />           // row 1, spans both columns
  <LeftColumn />       // row 2, column 1 — contains two stacked panes
  <ViewerContainer />  // row 2, column 2
</div>
```

---

## Ribbon Toolbar Specification

Single horizontal bar, divided into labelled tool groups with vertical dividers.

### Tool Groups

| Group Label | Tools in Phase 1.5 |
|---|---|
| Dimension Group | Add (active), Properties (disabled), Copy (disabled), Import (disabled), Export (disabled) |
| BIM | Check BIM Objects (disabled), Show All Objects (disabled) |
| Dimension | Add (disabled), Copy (disabled), Select In Area (disabled), Edit Controls (disabled) |
| Type | Line (active — current tool indicator), Point (disabled), Object (disabled) |
| Zones | Edit Zones (disabled) |
| Snap | Geometry (disabled), Angle (disabled), Rebar (disabled) |
| Mode | Measured (active toggle), Legend (disabled) |
| Show | Labels (disabled), Markups (disabled), Properties on Add (disabled) |

- Active tools are clickable. Disabled tools are visible at 35% opacity, non-interactive.
- Each tool: 20px icon above a 10px label.
- Group label: 9px uppercase text below the group, centred.
- The active tool in the Type group (Line) shows a depressed/highlighted state.

### Ribbon Visual

```
Height:           48px
Background:       #2B2B2B
Active tool bg:   #3D3D3D (hover), #4A4A4A (active/selected)
Disabled opacity: 0.35
Group divider:    1px solid #444444
Group label:      9px, #888888, uppercase, centred under group
Tool label:       10px, #CCCCCC
Icon size:        20px
```

---

## Left Column — Drawing Register Pane

### Tab Bar
```
[ Drawings ] [ Layers ] [ Model ] [ Views ]
```
- Drawings tab is active and functional in Phase 1.5. Others are visible placeholders.
- Active tab: bottom border 2px #4A9EFF, text #CCCCCC.
- Inactive tab: text #888888.
- Tab switching uses CSS `display: none` — do not unmount inactive tabs.

### Drawing Register Tree

The drawing register is a recursive folder tree. Folders can contain other folders or drawing files. There is no fixed depth limit.

```
▼ ARCHITECTURE
  ▼ HOUSE PLANS
      EX01-01 - Ground Floor Plan.pdf
      EX01-02 - First Floor Plan.pdf
  ▼ PLANS
    ► EX01-03 - Second Floor Plan.pdf   ← currently open (highlighted)
      EX01-04 - Roof Plan.pdf
► SITE
► MEP
► STRUCTURAL
```

Node types:
- **Folder node:** triangle expand/collapse indicator, folder icon, name. Starts collapsed.
- **Drawing node:** document icon, name, UOM column value (e.g. "mm").

Behaviour:
- Clicking a folder: toggles expand/collapse.
- Clicking a drawing: opens it in the viewer via `open_document` Tauri command. Highlights the row.
- Right-click folder: context menu — Add Sub-folder, Add Drawing, Rename, Delete.
- Right-click drawing: context menu — Rename, Remove.
- Drag-and-drop reordering within the same parent: **out of scope for Phase 1.5**.
- Tree state persists in SQLite.

---

## Left Column — Dimension Groups Pane

### Tab Bar
```
[ Dimension Groups ] [ Dimensions ] [ Auto Count ]
```
- Dimension Groups tab is active and functional. Others are visible placeholders.

### Breadcrumb Bar

Directly below the tab bar. Shows the path to the currently selected node:

```
Current:  11 INTERIOR DOORS\11.01 INTERIOR DOORS\Timber Doors
```

- Label "Current:" in #888888, path in #CCCCCC.
- Truncates from the left with ellipsis if too long.
- Updates whenever the active dimension group changes.
- Shows empty when nothing is selected.

### Dimension Group Tree

The dimension group tree is also a recursive folder tree. Folders are organisational. Dimension Groups are leaf nodes — they are where measurements attach.

```
▼ 00 GENERAL
    GFA
    ROOMS
    SITE
► 01 SITE PREPARATION
► 02 SUBSTRUCTURE
► 03 FRAME
► 05 UPPER FLOORS
► 06 ROOF
► 07 EXTERIOR WALLS
► 08 WINDOWS & EXTERIOR DOORS
► 09 STAIRS & BALUSTRADES
► 10 INTERIOR WALLS
▼ 11 INTERIOR DOORS
  ▼ 11.01 INTERIOR DOORS
    # Timber Doors          0    no   ← dimension group leaf, # icon, qty + UOM columns
  ► 11.07 FIRE RATED DOORS
► 14 CEILING FINISHES
```

Column headers: **Name**, **Quantity**, **UOM**

Node types:
- **Folder node:** triangle indicator, folder icon, name only (no qty/UOM).
- **Dimension Group node (leaf):** # icon, name, Quantity value (blank until Phase 2), UOM.

Behaviour:
- Clicking a folder: toggles expand/collapse.
- Clicking a dimension group leaf node:
  1. Highlights the row as active
  2. Updates the breadcrumb bar
  3. Calls `get_measurements_for_item` and passes results to viewer
  4. Viewer navigates to first measurement's page
  5. Viewer renders coloured highlight overlays for all measurements in that group
- Right-click folder: Add Sub-folder, Add Dimension Group, Rename, Delete Folder (with confirmation — deletes all descendants and their measurements).
- Right-click dimension group: Rename, Delete (with confirmation).
- Each dimension group has an associated colour used for highlight overlays.

---

## Data Model — SQLite Schema

The schema uses a single recursive node table for both the drawing register and dimension group tree. This matches CostX's architecture exactly and supports unlimited nesting.

```sql
-- Unified recursive node table for both trees
-- node_type determines what kind of node this is
CREATE TABLE IF NOT EXISTS tree_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tree        TEXT NOT NULL,              -- 'drawings' or 'dimensions'
    node_type   TEXT NOT NULL,              -- 'folder' or 'drawing' or 'dimension_group'
    parent_id   INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
                                            -- NULL = root level node
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,

    -- Drawing-specific fields (null for folders and dimension groups)
    file_path   TEXT,                       -- absolute path to PDF
    page_count  INTEGER,
    uom         TEXT,                       -- unit of measure e.g. 'mm'

    -- Dimension group-specific fields (null for folders and drawings)
    colour      TEXT DEFAULT '#4A9EFF',     -- highlight colour for measurements

    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast children lookups
CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent
    ON tree_nodes(parent_id, tree, sort_order);

-- Measurements table — populated by Phase 2, schema defined now for FK integrity
-- Measurements attach to dimension_group nodes only (node_type = 'dimension_group')
CREATE TABLE IF NOT EXISTS measurements (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dimension_group_id  INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    drawing_id          INTEGER NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
    page_index          INTEGER NOT NULL,
    measurement_type    TEXT NOT NULL,      -- 'linear', 'area', 'count', 'volume'
    geometry_json       TEXT NOT NULL,      -- JSON [{x, y}, ...] in page coordinates
    quantity            REAL,               -- computed, null until Phase 2
    uom                 TEXT,               -- 'm', 'm2', 'nr', 'm3'
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_measurements_group
    ON measurements(dimension_group_id);

CREATE INDEX IF NOT EXISTS idx_measurements_drawing
    ON measurements(drawing_id);
```

### Schema Notes

- `tree = 'drawings'` nodes: `node_type` is either `'folder'` or `'drawing'`
- `tree = 'dimensions'` nodes: `node_type` is either `'folder'` or `'dimension_group'`
- `parent_id = NULL` means the node is at the root level of its tree
- Deleting a folder cascades to all descendants automatically via `ON DELETE CASCADE`
- The `colour` field on dimension_group nodes drives the overlay highlight colour in the viewer

---

## Tauri Commands — New in Phase 1.5

Add to `desktop/src/main.rs`. Do not modify Phase 1 commands.

```rust
// Tree commands — used by both drawing register and dimension group trees

/// Returns all root-level nodes for a given tree, with children populated recursively
#[tauri::command]
async fn get_tree(tree: String, state: State<'_, AppState>) -> Result<Vec<TreeNodeDto>, String>

/// Returns direct children of a node (for lazy loading on expand)
#[tauri::command]
async fn get_children(parent_id: i64, state: State<'_, AppState>) -> Result<Vec<TreeNodeDto>, String>

/// Creates a folder node
#[tauri::command]
async fn create_folder(tree: String, parent_id: Option<i64>, name: String, state: State<'_, AppState>) -> Result<TreeNodeDto, String>

/// Creates a drawing node (drawings tree only)
#[tauri::command]
async fn add_drawing(parent_id: Option<i64>, name: String, file_path: String, uom: String, state: State<'_, AppState>) -> Result<TreeNodeDto, String>

/// Creates a dimension group node (dimensions tree only)
#[tauri::command]
async fn create_dimension_group(parent_id: Option<i64>, name: String, colour: String, state: State<'_, AppState>) -> Result<TreeNodeDto, String>

/// Renames any node
#[tauri::command]
async fn rename_node(node_id: i64, name: String, state: State<'_, AppState>) -> Result<(), String>

/// Deletes any node — cascades to all children and their measurements
#[tauri::command]
async fn delete_node(node_id: i64, state: State<'_, AppState>) -> Result<(), String>

/// Returns all measurements for a dimension group (for viewer highlight overlay)
#[tauri::command]
async fn get_measurements_for_group(group_id: i64, state: State<'_, AppState>) -> Result<Vec<MeasurementDto>, String>
```

### DTO Structs

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TreeNodeDto {
    pub id: i64,
    pub tree: String,
    pub node_type: String,          // 'folder', 'drawing', 'dimension_group'
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
    pub has_children: bool,         // for rendering expand indicator without loading children
    // Drawing fields
    pub file_path: Option<String>,
    pub page_count: Option<i64>,
    pub uom: Option<String>,
    // Dimension group fields
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
```

---

## Zustand Store Structure

```typescript
// desktop/src-frontend/src/store/appStore.ts

interface TreeState {
  // Drawing register
  drawingNodes: TreeNodeDto[];
  activeDrawingId: number | null;

  // Dimension groups
  dimensionNodes: TreeNodeDto[];
  activeDimensionGroupId: number | null;
  activeBreadcrumb: string;

  // Tree actions (shared)
  loadTree: (tree: 'drawings' | 'dimensions') => Promise<void>;
  loadChildren: (parentId: number) => Promise<TreeNodeDto[]>;
  createFolder: (tree: string, parentId: number | null, name: string) => Promise<void>;
  renameNode: (nodeId: number, name: string) => Promise<void>;
  deleteNode: (nodeId: number) => Promise<void>;

  // Drawing-specific actions
  addDrawing: (parentId: number | null, name: string, filePath: string, uom: string) => Promise<void>;
  openDrawing: (node: TreeNodeDto) => Promise<void>;

  // Dimension group-specific actions
  createDimensionGroup: (parentId: number | null, name: string, colour: string) => Promise<void>;
  selectDimensionGroup: (node: TreeNodeDto) => Promise<void>;
}
```

---

## Viewer Integration — Measurement Highlighting

When a dimension group leaf node is selected, the viewer must:

1. Call `get_measurements_for_group(groupId)`
2. If measurements exist, navigate viewer to `measurements[0].page_index`
3. Render coloured overlays on a second canvas layered above the tile canvas

The overlay canvas sits directly above the tile canvas, same dimensions, `pointer-events: none`.

```typescript
// Viewer.tsx additions — do not touch tile rendering logic

function drawMeasurementOverlays(
  overlayCtx: CanvasRenderingContext2D,
  measurements: MeasurementDto[],
  groupColour: string,
  viewport: ViewportState
) {
  overlayCtx.clearRect(0, 0, overlayCtx.canvas.width, overlayCtx.canvas.height);

  for (const m of measurements) {
    const points: { x: number; y: number }[] = JSON.parse(m.geometry_json);
    if (points.length === 0) continue;

    const screenPoints = points.map(p => pageToScreen(p, viewport));

    overlayCtx.beginPath();
    overlayCtx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (const pt of screenPoints.slice(1)) overlayCtx.lineTo(pt.x, pt.y);
    overlayCtx.closePath();

    overlayCtx.fillStyle = groupColour + '55';   // colour at 33% opacity
    overlayCtx.strokeStyle = groupColour;
    overlayCtx.lineWidth = 2;
    overlayCtx.fill();
    overlayCtx.stroke();
  }
}
```

---

## Visual Design Tokens

```typescript
// desktop/src-frontend/src/theme.ts
export const theme = {
  bg: {
    shell:   '#1E1E1E',
    pane:    '#252526',
    ribbon:  '#2B2B2B',
    hover:   '#2D2D2D',
    active:  '#094771',   // CostX-style blue row highlight
    input:   '#3C3C3C',
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
  accent:       '#4A9EFF',
  danger:       '#F44747',
  treeIndent:   16,    // px per nesting level
  rowHeight:    22,    // px — CostX uses compact row heights
  ribbonHeight: 48,    // px
  leftPaneWidth: 320,  // px default
  tabHeight:    28,    // px
}
```

---

## New Dependencies

### `desktop/src-frontend/package.json`
```json
{
  "dependencies": {
    "zustand": "^4.5.0"
  }
}
```

### `desktop/Cargo.toml`
```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-dialog = "2"
```

### `desktop/tauri.conf.json` — add to plugins section
```json
{
  "plugins": {
    "sql": {},
    "dialog": {}
  }
}
```

---

## Implementation Order

Implement all files end to end without stopping:

1. SQLite schema — run migrations on app startup in `main.rs`; seed both trees with example data matching the screenshot (ARCHITECTURE > HOUSE PLANS, PLANS etc. and 00 GENERAL through 14 CEILING FINISHES)
2. All new DTO structs in `desktop/src/main.rs`
3. All new Tauri commands in `desktop/src/main.rs`
4. `theme.ts`
5. `store/appStore.ts` — Zustand store
6. `App.tsx` — CSS Grid shell with resizable left column
7. `components/Ribbon.tsx`
8. `components/LeftColumn.tsx` — two stacked resizable panes
9. `components/DrawingRegister.tsx` — recursive folder tree
10. `components/DimensionGroupPane.tsx` — breadcrumb + recursive folder/group tree with Qty + UOM columns
11. `components/TreeNode.tsx` — shared recursive tree node component used by both trees
12. `components/ContextMenu.tsx` — reusable right-click context menu
13. `components/Viewer.tsx` — add overlay canvas only; do not touch tile rendering

---

## Definition of Done

- [ ] `cargo tauri dev` launches with full shell layout matching the CostX screenshot
- [ ] Ribbon displays all tool groups with correct active/disabled states and group labels
- [ ] Left column splits into Drawing Register (top) and Dimension Groups (bottom) with draggable divider
- [ ] Drawing Register tree shows seeded data with nestable folders that expand/collapse
- [ ] Adding a drawing via right-click opens file picker and adds drawing node correctly
- [ ] Clicking a drawing opens it in the viewer and highlights its row
- [ ] Dimension Groups tree shows seeded data matching the screenshot (00 GENERAL through 14 CEILING FINISHES with correct nesting)
- [ ] Folders and dimension groups can be created, renamed, and deleted — persists to SQLite
- [ ] Deleting a folder shows confirmation dialog and cascades correctly
- [ ] Clicking a dimension group updates the breadcrumb bar correctly
- [ ] Clicking a dimension group triggers overlay rendering on the viewer (no error even when measurements are empty)
- [ ] Both trees support arbitrary nesting depth
- [ ] Left column is resizable by dragging the outer divider
- [ ] Both pane heights within the left column are resizable by dragging their shared divider
- [ ] All design tokens applied — dark theme, correct row heights, correct colours
- [ ] `cargo tauri build` still produces a working installer

---

## Out of Scope for Phase 1.5

Do not implement:

- Measurement drawing tools (linear, area, count, volume)
- Scale calibration
- Quantity calculation or cost rollup
- Workbook or cost plan views
- Drag and drop reordering of tree nodes
- Export to Excel or CSV
- Thumbnail generation
- Search or filter within trees
- Multi-select in either tree
- Undo/redo
- Zone categories
- Layers, Model, Views tabs (placeholders only)
- Dimensions, Auto Count tabs (placeholders only)
