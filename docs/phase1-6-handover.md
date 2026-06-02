# Phase 1.6 Handover: Project File Management
## Desktop CAD/Takeoff Application — Rust + Tauri + React

---

## How To Use This Document

This spec is structured as four sequential milestones. Each milestone ends with a
verification step that produces visible, testable proof before work on the next
milestone begins.

**Do not proceed to the next milestone until the current one is verified.**

---

## Context

Phase 1.5 left the app opening directly into the viewer with a single shared
SQLite database at a fixed app data path. There is no concept of a named project
that can be created, saved, closed, and reopened.

Phase 1.6 introduces proper project file management. Each project is a self-contained
`.tcop` file (Take-it-Off project) which is a SQLite database with a known schema.
The app opens to a start screen where the user creates or opens a project before
entering the viewer.

A project represents one contract or tender. Drawings are not shared between projects.

---

## Decisions Already Made — Do Not Revisit

- **PDFium must not run inside `desktop.exe`.** All PDF operations go through
  `pdf_renderer.exe`. This includes metadata reads when adding drawings.
- **`worker_count` stays at 1.**
- **`TileData` uses `image_path`, not base64.**
- **Single canvas compositor. Overlay canvas above it. Neither changes.**
- **Inline styles only. No Tailwind.**
- **Zustand for all global state.**
- **`sqlx` with `SqlitePool` for all database access. Frontend never touches
  SQLite directly.**
- **`fs:read-all` in capabilities — do not rename it.**
- **Tree mutations force full root reload and child cache clear.**
- **Seed data from Phase 1.5 is verification fixture only — real projects start
  with empty drawing register and empty dimension group tree.**
- **Project fields captured at creation: project name, client name,
  contract number.**
- **Project file extension: `.tcop`**
- **Project file location: user-chosen via save dialog.**
- **App launch behaviour: start screen.**

---

## Critical Tauri v2 Rules — Read Before Writing Any Code

**Rule 1 — `main.rs` is a thin wrapper only.**
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    desktop_lib::run();
}
```

**Rule 2 — Capabilities file controls all plugin access.**
Missing permissions fail silently.

**Rule 3 — `tauri.conf.json` uses v2 syntax only.** No `allowlist`.

**Rule 4 — `invoke<T>()` generics must exactly match Rust return types.**

**Rule 5 — Plugin imports use the plugin package.**
```typescript
import { save, open } from "@tauri-apps/plugin-dialog";
```

**Rule 6 — Every plugin must be initialised in the builder.**

---

## Current `AppState` — Do Not Remove Any Existing Fields

```rust
pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    pub db: Arc<SqlitePool>,          // Phase 1.5 — single shared database
}
```

Phase 1.6 replaces the single `db` field with a project-aware connection:

```rust
pub struct AppState {
    pub pdfium_lib_path: String,
    pub tile_cache_dir: String,
    pub renderer_path: String,
    pub open_document: Arc<Mutex<Option<DocumentMeta>>>,
    pub tile_manager: Arc<TileManager>,
    pub render_context: Arc<Mutex<Option<(u32, u8)>>>,
    // Phase 1.6 — replaces Arc<SqlitePool>
    pub active_project: Arc<Mutex<Option<ActiveProject>>>,
    pub recent_projects: Arc<Mutex<Vec<RecentProject>>>,
}

pub struct ActiveProject {
    pub meta: ProjectMeta,
    pub db: SqlitePool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ProjectMeta {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub file_path: String,           // absolute path to .tcop file
    pub created_at: String,
    pub last_opened_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RecentProject {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub file_path: String,
    pub last_opened_at: String,
}
```

---

## Project File Format

A `.tcop` file is a SQLite database. It contains:

1. A `project_meta` table with one row — the project's name, client, and
   contract number.
2. The full Phase 1.5 schema — `tree_nodes` and `measurements` tables.

All drawing register and dimension group data for a project lives inside its
`.tcop` file. Switching projects means closing one SQLitePool and opening another.

### Project database schema

```sql
-- Project identity — always exactly one row
CREATE TABLE IF NOT EXISTS project_meta (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    name             TEXT NOT NULL,
    client           TEXT NOT NULL,
    contract_number  TEXT NOT NULL,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inherited from Phase 1.5 — identical schema
CREATE TABLE IF NOT EXISTS tree_nodes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tree        TEXT    NOT NULL,
    node_type   TEXT    NOT NULL,
    parent_id   INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    file_path   TEXT,
    page_count  INTEGER,
    uom         TEXT,
    colour      TEXT    DEFAULT '#4A9EFF',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent
    ON tree_nodes(parent_id, tree, sort_order);

CREATE INDEX IF NOT EXISTS idx_tree_nodes_tree
    ON tree_nodes(tree, node_type);

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

---

## Recent Projects Registry

Recent projects are tracked in a separate app-level SQLite database at a fixed
path in the app data directory. This is separate from project files and is never
exposed to the user as a file.

Path: `{app_data_dir}/registry.db`

```sql
CREATE TABLE IF NOT EXISTS recent_projects (
    file_path        TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    client           TEXT NOT NULL,
    contract_number  TEXT NOT NULL,
    last_opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Maximum 10 recent projects. When a new project is opened, upsert its record.
When the list exceeds 10, delete the oldest by `last_opened_at`.

---

## New Dependencies

### `desktop/Cargo.toml` — add to existing
```toml
# save dialog support — open is already present
# no new crates required — tauri-plugin-dialog already supports save
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
    "dialog:allow-save",
    "fs:read-all",
    "fs:allow-write-file",
    "fs:allow-create-dir"
  ]
}
```

---

## New Tauri Commands

Add to `desktop/src/lib.rs`. Do not modify existing command signatures.
All commands that previously accepted `State<'_, AppState>` and called
`state.db` must now call `state.active_project.lock().as_ref()?.db` instead.

```rust
/// Creates a new project file at the user-chosen path.
/// Initialises the project database schema and inserts project_meta.
/// Sets it as the active project. Adds to recent projects registry.
/// Returns the new project's metadata.
#[tauri::command]
pub async fn create_project(
    name: String,
    client: String,
    contract_number: String,
    file_path: String,          // chosen by user via save dialog on frontend
    state: tauri::State<'_, AppState>,
) -> Result<ProjectMeta, String>

/// Opens an existing .tcop file.
/// Validates it contains a valid project_meta row.
/// Sets it as the active project. Updates last_opened_at.
/// Adds to recent projects registry.
/// Returns the project's metadata.
#[tauri::command]
pub async fn open_project(
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<ProjectMeta, String>

/// Closes the active project.
/// Clears active_project, open_document, tile_manager, render_context.
/// Does not delete the file.
#[tauri::command]
pub async fn close_project(
    state: tauri::State<'_, AppState>,
) -> Result<(), String>

/// Returns the active project metadata, or null if none open.
#[tauri::command]
pub async fn get_active_project(
    state: tauri::State<'_, AppState>,
) -> Result<Option<ProjectMeta>, String>

/// Returns the recent projects list (max 10, newest first).
#[tauri::command]
pub async fn get_recent_projects(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RecentProject>, String>
```

### Guard all existing tree and measurement commands

Every existing command that accesses the database must guard against no active
project. Pattern:

```rust
let project_guard = state.active_project.lock();
let project = project_guard.as_ref()
    .ok_or("No project open")?;
let db = &project.db;
// ... use db
```

---

## Frontend — Start Screen

When no project is active, the app renders a **start screen** instead of the
viewer shell. The start screen replaces the entire window content.

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│           [App Logo / Name]                             │
│           Take-it-Off                                   │
│                                                         │
│   ┌─────────────────────┐  ┌─────────────────────┐     │
│   │   + New Project     │  │   Open Project      │     │
│   └─────────────────────┘  └─────────────────────┘     │
│                                                         │
│   Recent Projects                                       │
│   ┌───────────────────────────────────────────────┐     │
│   │  Project Name        Client       Contract    │     │
│   │  ─────────────────────────────────────────    │     │
│   │  Riverside Apts      ABC Corp     T-2024-001  │     │
│   │  City Office Fit     XYZ Ltd      T-2024-002  │     │
│   └───────────────────────────────────────────────┘     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- Background: `#1E1E1E`
- App name: large, `#CCCCCC`
- Two primary action buttons side by side
- Recent projects list below — clicking any row opens that project
- If recent projects list is empty, show "No recent projects" in `#555555`
- Missing file: if a recent project file no longer exists at its path, show
  the row greyed out with "File not found" and do not attempt to open it

### New Project Dialog

Triggered by "New Project" button. An in-app modal dialog (not browser native):

```
┌─────────────────────────────────────┐
│  New Project                        │
│                                     │
│  Project Name   [________________]  │
│  Client         [________________]  │
│  Contract No.   [________________]  │
│                                     │
│  Save Location  [________________]  │
│                 [ Browse... ]        │
│                                     │
│  [ Cancel ]            [ Create ]   │
└─────────────────────────────────────┘
```

- "Browse" triggers a Tauri save dialog filtered to `.tcop` files
- All three text fields are required — Create button disabled until all filled
  and a save path is chosen
- On Create: call `create_project` command, then transition to viewer shell
- Project name is pre-filled into the save dialog filename suggestion

### Open Project

"Open Project" button triggers a Tauri open dialog filtered to `.tcop` files.
On selection: call `open_project` command, then transition to viewer shell.

---

## Frontend — Viewer Shell Changes

### Title bar / ribbon project indicator

Add a project indicator to the ribbon showing the active project:

```
[ ribbon tools... ]    |    Riverside Apts  |  ABC Corp  |  T-2024-001    [ Close Project ]
```

- Project name, client, contract number shown as read-only text in the ribbon
- `Close Project` button on the right — calls `close_project`, returns to
  start screen
- These are new ribbon elements — do not remove existing tool groups

### Close Project behaviour

When `close_project` is called:
1. Clear Zustand store completely — drawing roots, dimension roots, child cache,
   active drawing, active dimension group, overlay, breadcrumb, all of it
2. Clear `open_document` and tile cache in backend
3. Transition frontend to start screen
4. Refresh recent projects list on start screen

---

## Zustand Store Changes

```typescript
// Add to appStore.ts

interface ProjectState {
  activeProject: ProjectMeta | null;
  recentProjects: RecentProject[];

  // Project actions
  createProject: (name: string, client: string, contractNumber: string, filePath: string) => Promise<void>;
  openProject: (filePath: string) => Promise<void>;
  closeProject: () => Promise<void>;
  loadRecentProjects: () => Promise<void>;
}
```

On `closeProject`:
- Call `close_project` Tauri command
- Reset ALL store state to initial values:
  - `activeProject: null`
  - `drawingRoots: []`
  - `dimensionRoots: []`
  - `childCache: {}`
  - `activeDrawingId: null`
  - `activePageIndex: 0`
  - `currentDocument: null`
  - `activeDimensionGroupId: null`
  - `activeBreadcrumb: ''`
  - `overlayMeasurements: []`
  - `overlayColour: '#4A9EFF'`

---

## `App.tsx` Routing Logic

```tsx
// App.tsx
function App() {
  const activeProject = useAppStore(s => s.activeProject);

  useEffect(() => {
    // On app load, check if there's an active project in backend state
    // (handles app restart with a project already open — not needed for Phase 1.6
    // but keep the hook so it can be wired in future)
    invoke<ProjectMeta | null>('get_active_project').then(project => {
      if (project) useAppStore.getState().setActiveProject(project);
    });
  }, []);

  if (!activeProject) {
    return <StartScreen />;
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateRows: '48px 1fr',
      gridTemplateColumns: `${leftWidth}px 1fr`,
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      background: theme.bg.shell,
    }}>
      <Ribbon />
      <LeftColumn />
      <Viewer />
    </div>
  );
}
```

---

## Implementation Order

Implement all files end to end without stopping between them:

1. `AppState` updated in `desktop/src/lib.rs` — replace `db: Arc<SqlitePool>`
   with `active_project` and `recent_projects` fields
2. Registry database initialisation in `setup` closure — `registry.db` at
   fixed app data path
3. All five new Tauri commands in `desktop/src/lib.rs`
4. Update all existing tree/measurement commands to use
   `active_project.lock().as_ref()?.db` pattern
5. Add new commands to `.invoke_handler`
6. Update `capabilities/default.json`
7. `store/appStore.ts` — add ProjectState slice, update closeProject to reset all state
8. `components/StartScreen.tsx` — start screen with New Project, Open Project,
   Recent Projects list
9. `components/NewProjectDialog.tsx` — in-app modal with three fields + save path
10. `App.tsx` — conditional render: StartScreen vs viewer shell
11. `components/Ribbon.tsx` — add project indicator and Close Project button

---

## MILESTONE 1 — Start Screen Renders

**Goal:** App launches showing the start screen. No project functionality yet.
New Project and Open Project buttons are visible. Recent projects list shows
"No recent projects."

**Implement:** `StartScreen.tsx`, `App.tsx` conditional render,
`loadRecentProjects` Zustand action calling `get_recent_projects` command,
`get_recent_projects` and `get_active_project` Tauri commands,
registry database initialisation.

**Do not implement** project creation or opening in this milestone.

**Verification:**
```powershell
cargo build --package core --bin pdf_renderer
cargo build --package desktop
npm --prefix desktop/src-frontend run build
Start-Process -FilePath ".\target\debug\desktop.exe" `
  -WorkingDirectory "C:\Users\Admin\Documents\Take-it-Off"
```

Confirm:
- App opens to start screen, not the viewer
- Start screen shows app name, New Project button, Open Project button
- Recent projects section shows "No recent projects"
- Dark theme throughout
- No console errors

**Gate: do not proceed until start screen renders correctly.**

---

## MILESTONE 2 — Create and Open a Project

**Goal:** User can create a new project. App transitions to viewer shell.
Project file exists on disk. Recent projects list updates.

**Implement:** `NewProjectDialog.tsx`, `create_project` Tauri command,
`open_project` Tauri command, `createProject` and `openProject` Zustand actions,
project database schema migrations, registry upsert logic.

**Verification:**
Confirm in app:
- Clicking New Project opens the in-app dialog
- All three fields required — Create disabled until all filled and path chosen
- Browse triggers a save dialog filtered to `.tcop`
- Creating a project transitions to the full viewer shell
- Ribbon shows project name, client, contract number
- A `.tcop` file exists at the chosen path
- Close app, reopen — start screen shows the project in Recent Projects
- Clicking the recent project row opens it and transitions to viewer shell
- Open Project button opens a file picker filtered to `.tcop` — selecting the
  file opens it correctly
- Drawing register and dimension group trees are empty (no seed data)

**Gate: do not proceed until a project can be created, closed, and reopened.**

---

## MILESTONE 3 — Close Project and Multi-Project

**Goal:** Close Project returns to start screen cleanly. Two projects can be
created independently with completely separate data.

**Implement:** `close_project` Tauri command, Close Project button in ribbon,
full Zustand state reset on close.

**Verification:**
Confirm in app:
- Clicking Close Project in ribbon returns to start screen
- Start screen shows the closed project in Recent Projects
- Add a drawing and dimension group to Project A
- Close Project A, create Project B
- Project B has empty drawing register and empty dimension group tree
- Close Project B, reopen Project A — drawings and dimension groups are intact
- Both projects appear in Recent Projects list

**Gate: do not proceed until two projects are provably independent.**

---

## MILESTONE 4 — Full Regression and Installer

**Goal:** All Phase 1 and 1.5 functionality works within the project context.
Installer builds successfully.

**Verification:**
Confirm in app:
- Create a project
- Add a drawing to the register from a real PDF file
- Navigate pages from the sidebar
- Pan and zoom work on the PDF
- Add a dimension group folder and a dimension group leaf
- Click the dimension group — breadcrumb updates, no console errors
- Overlay canvas is present and transparent
- Close and reopen the project — all data intact

Then run:
```powershell
cargo tauri build
```

Confirm:
- MSI and NSIS installers produced in `target/release/bundle/`
- Installer installs and launches correctly

**Gate: Phase 1.6 complete when all Definition of Done items confirmed.**

---

## Definition of Done

- [ ] Milestone 1: Start screen renders, no console errors
- [ ] Milestone 2: Project created, file on disk, recent projects updates,
      reopens correctly
- [ ] Milestone 3: Close Project returns to start screen, two projects are
      completely independent
- [ ] Milestone 4: All Phase 1 and 1.5 functionality works within project context
- [ ] Empty drawing register and dimension group tree on new project
- [ ] `cargo tauri build` produces MSI and NSIS installers
- [ ] Dark theme consistent throughout including start screen
- [ ] No seed data in production project workflow

---

## Out of Scope for Phase 1.6

Do not implement:
- Project rename after creation
- Editing project metadata (name, client, contract number) after creation
- Project templates
- Exporting or importing projects
- Duplicate project
- Any measurement tools
- Any costing or reporting features
- Persistent renderer service upgrade (Phase 1.7)
