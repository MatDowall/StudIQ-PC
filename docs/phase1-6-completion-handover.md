# Phase 1.6 Completion Handover: Project File Management

Date: 2026-06-02  
Application: Take-it-Off / PDF CAD desktop takeoff application  
Stack: Rust, Tauri v2, React, TypeScript, Zustand, SQLite / sqlx

## Summary

Phase 1.6 added project file management on top of the Phase 1.5 drawing register, dimension group, and PDF rendering workflow.

The application now launches to a project start screen instead of directly opening the viewer. Users can create, open, close, and reopen `.tcop` project files. A `.tcop` file is a SQLite database containing project metadata plus the Phase 1.5 project data tables. Recent projects are tracked separately in an app-level SQLite registry database.

The single shared `db: Arc<SqlitePool>` in `AppState` has been replaced with a project-aware `active_project` field. Existing tree and measurement commands now require an active project and return `No project open` if called before a project is opened.

PDFium remains out of process. `desktop.exe` does not load or run PDFium directly. All PDF metadata, preview, and tile operations continue to go through `pdf_renderer.exe`.

## Implementation Scope

### Backend

Implemented in `desktop/src/lib.rs`:

- Replaced the Phase 1.5 shared database field with:
  - `active_project: Arc<Mutex<Option<ActiveProject>>>`
  - `recent_projects: Arc<Mutex<Vec<RecentProject>>>`
  - `registry_db: SqlitePool`
- Added:
  - `ActiveProject`
  - `ProjectMeta`
  - `RecentProject`
- Added Tauri commands:
  - `create_project`
  - `open_project`
  - `close_project`
  - `get_active_project`
  - `get_recent_projects`
- Added project database initialization for `.tcop` files.
- Added the `project_meta` table to project migrations.
- Kept the Phase 1.5 `tree_nodes` and `measurements` schema intact.
- Added app-level recent-project registry initialization at:
  - `{app_data_dir}/registry.db`
- Added recent-project upsert, list refresh, and max-10 trimming.
- Updated existing tree and measurement commands to use the active project database instead of a global shared database.
- Added project-file validation for `.tcop` paths.
- Added release-safe renderer path resolution:
  - first checks for `pdf_renderer.exe` beside `desktop.exe`
  - falls back to bundled Tauri resource `pdf_renderer.exe`

### Frontend

Implemented in `desktop/src-frontend/src`:

- Added start-screen routing in `App.tsx`.
- Added `StartScreen.tsx`.
- Added `NewProjectDialog.tsx`.
- Added project state and actions to `store/appStore.ts`.
- Added recent-project loading and display.
- Added file-missing display support for recent projects.
- Added create/open project actions.
- Added close project action and full store reset.
- Added project indicator in `Ribbon.tsx`.
- Added `Close Project` button in `Ribbon.tsx`.

### Capabilities and Packaging

Updated:

- `desktop/capabilities/default.json`
- `desktop/tauri.conf.json`
- `desktop/src-frontend/package.json`
- `core/src/bin/pdf_renderer.rs`
- `core/src/render/worker.rs`

The release and installer build now bundles `pdf_renderer.exe` so installed builds can render PDFs without relying on a local debug binary.

## Milestone Results

### Milestone 1: Start Screen Renders

Implemented:

- Start screen
- `get_active_project`
- `get_recent_projects`
- registry database initialization
- frontend conditional routing
- initial project state in Zustand

Verification result:

- Rust renderer build passed.
- Rust desktop build passed.
- Frontend build passed after using `npm.cmd` because PowerShell blocked `npm.ps1`.
- App opened to the start screen.
- Start screen showed:
  - app name
  - New Project
  - Open Project
  - Recent Projects
  - No recent projects
- Dark theme was applied.

User confirmed Milestone 1 and approved proceeding.

### Milestone 2: Create and Open a Project

Implemented:

- New Project dialog
- Tauri save dialog integration
- `.tcop` database creation
- `project_meta` insertion
- project schema migration
- `create_project`
- `open_project`
- recent-project registry upsert
- project metadata display in ribbon
- open project dialog
- recent project row opening

Verification result:

User confirmed all requested steps passed:

1. New Project opened the in-app dialog.
2. Required fields and disabled Create behavior worked.
3. Browse opened a save dialog filtered to `.tcop`.
4. Creating a project transitioned to the viewer shell.
5. Ribbon showed project name, client, and contract number.
6. `.tcop` file existed at the chosen path.
7. Reopen showed the project in Recent Projects.
8. Recent project row opened the project.
9. Open Project dialog filtered to `.tcop`.
10. Drawing register and dimension group trees were empty for a new project.

User confirmed Milestone 2 and approved proceeding.

### Milestone 3: Close Project and Multi-Project

Implemented:

- `close_project`
- backend clearing of:
  - active project
  - open document
  - render context
  - tile manager
  - tile cache directory
- frontend full Zustand reset on close:
  - active project
  - drawing roots
  - dimension roots
  - child cache
  - active drawing
  - active page
  - active document
  - active dimension group
  - breadcrumb
  - overlay measurements
  - overlay colour
- Close Project button in the ribbon.

Verification result:

User confirmed all requested steps passed:

1. Close Project returned to the start screen.
2. Closed project appeared in Recent Projects.
3. Project A accepted drawing and dimension group data.
4. Project B started empty.
5. Reopening Project A restored Project A data.
6. Project A and Project B remained independent.
7. Both projects appeared in Recent Projects.

User confirmed Milestone 3 and approved proceeding.

### Milestone 4: Full Regression and Installer

Implemented and verified by build:

- `cargo tauri build` completed successfully.
- MSI installer produced.
- NSIS installer produced.
- Release `desktop.exe` produced.
- Release `pdf_renderer.exe` produced and bundled.

Generated artifacts:

- `target/release/desktop.exe`
- `target/release/pdf_renderer.exe`
- `target/release/bundle/msi/PDF CAD_0.1.0_x64_en-US.msi`
- `target/release/bundle/nsis/PDF CAD_0.1.0_x64-setup.exe`

Runtime testing found two release-specific issues. Both were fixed and the release app/installers were rebuilt.

## Issues Found During Testing and Resolutions

### 1. PowerShell blocked `npm.ps1`

Symptom:

```text
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running scripts is disabled on this system.
```

Cause:

The local PowerShell execution policy blocks the `npm.ps1` shim.

Resolution:

Used `npm.cmd` for frontend build verification:

```powershell
npm.cmd --prefix desktop/src-frontend run build
```

No code change was needed.

### 2. Vite could not read config inside the sandbox path

Symptom:

```text
Cannot read directory "../../../..": Access is denied.
Could not resolve "...desktop\src-frontend\vite.config.ts"
```

Cause:

When run inside the sandbox, Vite/esbuild resolved paths through the sandbox copy and failed to read the config.

Resolution:

Reran frontend and Tauri build commands outside the sandbox with user approval. The actual project build passed. No application code change was needed for this issue.

### 3. Capability permission name mismatch

Symptom:

```text
Permission fs:allow-create-dir not found
```

Cause:

The Phase 1.6 spec listed `fs:allow-create-dir`, but this project's installed Tauri v2 FS plugin exposes `fs:allow-mkdir`.

Resolution:

Updated `desktop/capabilities/default.json` to use:

```json
"fs:allow-mkdir"
```

This preserves the intended directory-creation permission while using the valid permission name for the installed plugin.

### 4. SQLx executor double-reference compile error

Symptom:

```text
the trait bound `&&Pool<Sqlite>: Executor<'_>` is not satisfied
```

Cause:

`load_recent_projects_from_registry()` accepted `&SqlitePool`, but one query passed `&pool`, creating a double reference.

Resolution:

Changed the query executor argument from `&pool` to `pool`.

### 5. Running `desktop.exe` blocked rebuild

Symptom:

```text
failed to remove file ... target\debug\desktop.exe
Access is denied. (os error 5)
```

Cause:

The debug app instance was still running while Cargo tried to rebuild the executable.

Resolution:

Closed the running `desktop.exe` process before rebuilding.

### 6. Release build could not find `pdf_renderer.exe`

Symptom observed in the app:

```text
ERROR: Failed to launch renderer metadata process: The system cannot find the file specified. (os error 2)
```

Cause:

The debug workflow had `target/debug/pdf_renderer.exe`, but the release build did not have a release `pdf_renderer.exe` beside `desktop.exe`, and the installer bundle did not include it.

Resolution:

- Added `../target/release/pdf_renderer.exe` as a Tauri bundle resource.
- Updated `desktop/src-frontend/package.json` so the frontend/Tauri build also builds the release renderer:

```json
"build": "tsc && vite build && cargo build --manifest-path ../../Cargo.toml --package core --bin pdf_renderer --release"
```

- Updated `desktop/src/lib.rs` renderer path resolution:
  - use sibling `pdf_renderer.exe` when present
  - otherwise use bundled resource `pdf_renderer.exe`

This preserved the architectural requirement that PDFium must not run inside `desktop.exe`.

### 7. Command windows flashed during drawing navigation

Symptom:

When navigating drawings/pages, command windows briefly opened and closed.

Cause:

The app spawns `pdf_renderer.exe` for metadata, preview, and tile rendering. The renderer was a console subsystem executable and child processes were being launched without hidden-window flags.

Resolution:

- Added Windows GUI subsystem attribute to `core/src/bin/pdf_renderer.rs` for release builds:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

- Added `CREATE_NO_WINDOW` launch flags in:
  - `desktop/src/lib.rs`
  - `core/src/render/worker.rs`

User confirmed the command-window flash no longer occurs.

## Spec Changes and Implementation Adjustments

The following changes were made relative to the original Phase 1.6 handover spec.

### RecentProject gained `file_exists`

Original spec:

```rust
pub struct RecentProject {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub file_path: String,
    pub last_opened_at: String,
}
```

Implemented:

```rust
pub struct RecentProject {
    pub name: String,
    pub client: String,
    pub contract_number: String,
    pub file_path: String,
    pub last_opened_at: String,
    pub file_exists: bool,
}
```

Reason:

The start screen needed to grey out missing recent-project files without adding frontend filesystem dependencies. The user explicitly directed that `get_recent_projects` should compute this in Rust using:

```rust
std::path::Path::new(&project.file_path).exists()
```

### `fs:allow-create-dir` changed to `fs:allow-mkdir`

Original spec listed:

```json
"fs:allow-create-dir"
```

Implemented:

```json
"fs:allow-mkdir"
```

Reason:

The installed Tauri v2 FS plugin did not expose `fs:allow-create-dir`; the valid equivalent permission was `fs:allow-mkdir`.

### Release renderer bundling added

The original spec required that PDFium never run inside `desktop.exe`, but it did not explicitly define release packaging for `pdf_renderer.exe`.

Implemented:

- `pdf_renderer.exe` is built in release mode before Tauri packaging.
- `pdf_renderer.exe` is bundled as a Tauri resource.
- `desktop.exe` resolves the renderer from either:
  - sibling executable path
  - bundled resource path

Reason:

Release testing showed that PDF metadata reads failed without `pdf_renderer.exe` available to the release executable. Bundling it keeps the process separation intact.

### Renderer process windows are hidden

Added:

- Windows GUI subsystem for release `pdf_renderer.exe`.
- `CREATE_NO_WINDOW` flags for renderer child processes.

Reason:

Release testing showed visible command windows during navigation. Hiding the child renderer process is a UX correction and does not change the out-of-process PDFium rule.

## Database Notes

### Project File

Each `.tcop` file is a SQLite database containing:

- `project_meta`
- `tree_nodes`
- `measurements`

New projects start with:

- one `project_meta` row
- empty drawing register
- empty dimension group tree
- no seed data

### Recent Registry

The recent projects registry is a separate SQLite database:

```text
{app_data_dir}/registry.db
```

It contains:

- `recent_projects`

Recent projects are kept to a maximum of 10 rows, sorted newest first.

## Files Created or Modified

Created:

- `desktop/src-frontend/src/components/StartScreen.tsx`
- `desktop/src-frontend/src/components/NewProjectDialog.tsx`
- `docs/phase1-6-completion-handover.md`

Modified:

- `desktop/src/lib.rs`
- `desktop/capabilities/default.json`
- `desktop/tauri.conf.json`
- `desktop/src-frontend/package.json`
- `desktop/src-frontend/src/App.tsx`
- `desktop/src-frontend/src/store/appStore.ts`
- `desktop/src-frontend/src/components/Ribbon.tsx`
- `core/src/bin/pdf_renderer.rs`
- `core/src/render/worker.rs`

## Commands Used for Verification

Core renderer:

```powershell
cargo build --package core --bin pdf_renderer
cargo build --package core --bin pdf_renderer --release
```

Desktop app:

```powershell
cargo build --package desktop
```

Frontend:

```powershell
npm.cmd --prefix desktop/src-frontend run build
```

Installer:

```powershell
cargo tauri build
```

## Definition of Done Status

- Milestone 1: confirmed by user.
- Milestone 2: confirmed by user.
- Milestone 3: confirmed by user.
- Milestone 4 installer build: passed.
- MSI produced: passed.
- NSIS produced: passed.
- Empty drawing register and dimension group tree on new project: confirmed during Milestone 2 and Milestone 3.
- No seed data in production project workflow: satisfied.
- Dark theme including start screen: satisfied.
- Release PDF renderer availability: fixed after testing.
- Renderer command windows: fixed and user confirmed.

Items requiring final manual confirmation outside this handover:

- Installer installation and launch from installed location.
- Full final Milestone 4 user workflow after the renderer-window fix:
  - add real PDF drawing
  - navigate pages
  - pan and zoom
  - add dimension folder and group
  - select group and verify breadcrumb
  - verify overlay canvas remains transparent
  - close and reopen project with all data intact

## Current State for Next Developer

The Phase 1.6 implementation is structurally complete and buildable.

The most important architecture rule remains satisfied:

- `desktop.exe` does not run PDFium.
- PDF operations go through `pdf_renderer.exe`.

The current release and installer artifacts have been rebuilt after fixing:

- missing release renderer
- flashing command windows

If further work continues from here, start by verifying the installed MSI/NSIS app uses the bundled `pdf_renderer.exe` correctly from the installed application directory, not only from the workspace release directory.
