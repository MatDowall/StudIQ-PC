# Phase 4 — UI Polish

Date started: 2026-06-03
Status: In progress
Phase: Phase 4 — UI polishing pass

---

## Summary

A polishing pass over the existing (Phase 1–3 complete) UI. No new features —
visual/layout/interaction refinement of the working app. Each item is treated as
a milestone with a verification gate (visible proof + user confirmation) per the
project's milestone discipline.

---

## Milestones

### Milestone 1 — App fits the window (no border, no scroll)

**Symptom:** The app rendered with a white border around the edges and a
page-level vertical scrollbar; the shell did not fill the window.

**Diagnosis:** There was no global CSS reset. The browser default 8px `body`
margin showed as the white border, and the root container used `100vh`/`100vw`
which stack on top of that body margin, pushing total content past the viewport
and forcing a scrollbar.

**Implemented:**
- Created `desktop/src-frontend/src/index.css` — resets `html`, `body`, `#root`
  to `margin:0; padding:0; height/width:100%`, sets `overflow:hidden` on
  `html`/`body`, and applies `box-sizing:border-box` globally.
- `main.tsx` — imports `./index.css`.
- `App.tsx` — shell container sized `100%` (fills `#root`) instead of
  `100vw`/`100vh`.
- `StartScreen.tsx` — same `100vw`/`100vh` → `100%` swap (keeps its own
  `overflow:auto` so the start screen still scrolls internally if needed).

**Verification:**
- `npm run build` succeeded — `tsc` clean, CSS bundled
  (`dist/assets/index-404sE-VQ.css`).
- Launched `cargo tauri dev`; user confirmed the app "looks far better" — no
  white border, no page-level scrollbar, shell fills the window edge-to-edge.

**Result:** Pass

---

### Milestone 2 — Remove legacy "Open PDF" button and "No document open" text

**Rationale:** The viewer toolbar's "Open PDF" button and the "No document open"
status placeholder were leftovers from initial Phase-1 testing. Document ingest
now flows through the drawing register, so both are dead UI.

**Implemented (`desktop/src-frontend/src/components/Viewer.tsx`):**
- Removed the "Open PDF" `<button>` and its `handleOpen` handler.
- Removed the now-unused `invoke` (`@tauri-apps/api/core`) and `open`
  (`@tauri-apps/plugin-dialog`) imports.
- Changed the `status` initial value and the no-document reset from
  `"No document open"` to `""`, so the status area is blank until a document is
  loaded via the register (`currentDocument`).

**Verification:**
- `npx tsc --noEmit` clean (confirms no unused-import errors after removal).
- Vite HMR applied the change live (`hmr update /src/components/Viewer.tsx`);
  gate is the button and text being absent from the running UI.

**Result:** Pass (pending user visual confirmation of the gate)

### Milestone 3 — Wire ribbon "Dimension Group" group (Add / Properties / Copy)

**Goal:** Make the ribbon's previously-static "Dimension Group" buttons functional, and
remove the now-redundant sidebar "Add Group" button.

**Gates (defined with the user):**
- **Add** — ribbon "Add" opens the *Add dimension group* dialog (same behaviour as the old
  sidebar button); the sidebar "Add Group" button is gone; creating through it adds the group.
- **Properties** — with a group selected, ribbon "Properties" opens that group's properties
  dialog; with none selected the button is visibly greyed and inert.
- **Copy** — with a group selected, ribbon "Copy" opens a *Copy dimension group to* dialog
  (Name prefilled `<name> - Copy`, Folder dropdown of **all** folders, "Copy Dimensions"
  checkbox); confirming creates a copy in the chosen folder, with dimensions when ticked.
  Greyed when no group selected.

**Implemented:**
- Backend (`desktop/src/lib.rs`):
  - `FolderOptionDto { id, path }`.
  - `list_dimension_folders` — returns every dimensions-tree folder with its full `/`-joined
    path (built in Rust by walking parents), so the copy picker shows all folders regardless
    of tree expansion state.
  - `copy_dimension_group(source_node_id, target_folder_id, name, copy_dimensions)` — inserts
    a new group under the target folder, duplicating the source colour and the
    `dimension_group_props` row; duplicates `measurements` rows only when `copy_dimensions`.
    Verifies node types first (project convention).
  - Both registered in the `invoke_handler`.
- Store (`appStore.ts`): `FolderOption`/`DgPaneCommand` types; `dgPaneCommand` bridge state +
  `requestDgPaneCommand`; `listDimensionFolders` and `copyDimensionGroup` actions.
- Ribbon (`Ribbon.tsx`): the first group's Add/Properties/Copy are wired via
  `requestDgPaneCommand`; Properties/Copy enable only when `activeDimensionGroupId !== null`
  (greyed + not-allowed otherwise). Other groups remain static decoration.
- Pane (`DimensionGroupPane.tsx`): removed the "Add Group" button; added a `dgPaneCommand`
  watcher (seq-guarded) that opens the matching dialog for the active group (building a
  lightweight node from the active id + breadcrumb name, since `childCache` may be cleared
  after tree refreshes); added `openCopyDialog`/`confirmCopy` and the copy-dialog render.
- New component `DimensionGroupCopyDialog.tsx` — matches the supplied mockup (Name, Folder
  dropdown, Copy Dimensions checkbox, OK/Cancel; Enter confirms, Esc cancels).

**Verification:**
- `npx tsc --noEmit` clean; `cargo build --package desktop` finished clean (new commands
  compile); dev watcher rebuilt and relaunched with the new backend.
- Live-app gate confirmation pending user.

**Result:** Pass (pending user visual confirmation of the three gates)

### Milestone 4 — Remove unused ribbon groups

**Goal:** Drop the ribbon groups that aren't part of the workflow: BIM, Dimension, Zones, Mode.

**Implemented (`Ribbon.tsx`):** Removed those four entries from the `groups` array. The ribbon
now shows only Dimension Group, Type, Snap, Show. The wired group is still index 0, so the
Add/Properties/Copy wiring is unaffected.

**Gate:** The BIM, Dimension, Zones, and Mode groups are absent from the ribbon; the remaining
groups and the wired Dimension Group buttons still work.

**Verification:** HMR applied; gate confirmed by user.

**Result:** Pass

### Milestone 5 — Rebrand to "StudIQ" + splash logo placeholder

**Goal:** Replace the two "Take-it-Off" titles on the start screen with a project-logo
placeholder, and rename the window/app from "PDF CAD" to "StudIQ" (including the compiled exe).

**Implemented:**
- `desktop/tauri.conf.json` — `productName` and the window `title` set to `StudIQ`.
  `productName` drives the bundled binary name, so `cargo tauri build` now produces
  `StudIQ.exe` (and `StudIQ_<ver>_x64` installers). The dev binary remains `desktop.exe`
  (cargo package name) — only the bundle is renamed.
- `desktop/src-frontend/index.html` — `<title>` → `StudIQ`.
- `desktop/src-frontend/src/components/StartScreen.tsx` — removed both "Take-it-Off" titles
  (the small label and the `<h1>`); added a dashed-border 220×72 "LOGO" placeholder to be
  swapped for an `<img>` once the logo asset exists.

**Gate:** Start screen shows the logo placeholder and no "Take-it-Off" text; the window
title bar reads "StudIQ"; a bundle build emits `StudIQ.exe`.

**Verification:** `npx tsc --noEmit` clean; dev watcher recompiled tauri.conf.json change and
relaunched (window title applies on restart). Splash + HTML title via HMR. Exe-name change
takes effect on `cargo tauri build` (not run here — heavy bundle step).

**Result:** Pass — splash placeholder + window title confirmed by user. Exe rename to
`StudIQ.exe` is configured but deferred: to be confirmed on the next full `cargo tauri build`.

---

## Files Created or Modified

**Created:**
- `desktop/src-frontend/src/index.css` — global reset (Milestone 1).
- `desktop/src-frontend/src/components/DimensionGroupCopyDialog.tsx` — copy dialog (M3).

**Modified:**
- `desktop/src-frontend/src/main.tsx` — import global stylesheet (M1).
- `desktop/src-frontend/src/App.tsx` — shell sizes to 100% not viewport units (M1).
- `desktop/src-frontend/src/components/StartScreen.tsx` — 100% not viewport units (M1).
- `desktop/src-frontend/src/components/Viewer.tsx` — removed legacy Open PDF
  button + "No document open" placeholder (M2).
- `desktop/src/lib.rs` — `FolderOptionDto`, `list_dimension_folders`,
  `copy_dimension_group` commands + registration (M3).
- `desktop/src-frontend/src/store/appStore.ts` — folder/copy/ribbon-bridge state + actions (M3).
- `desktop/src-frontend/src/components/Ribbon.tsx` — wired Add/Properties/Copy (M3).
- `desktop/src-frontend/src/components/DimensionGroupPane.tsx` — removed Add Group button,
  ribbon-command watcher, copy dialog wiring (M3).

---

## Remaining polish items

### Milestone 6 — Line snap drawing type — **COMPLETE**

See `docs/phase4-line-snap-completion-report.md` for the full report (six diagnostic iterations,
problems and solutions). Summary below kept for context.

**Goal:** Activate the ribbon's Type group (Point / Line buttons) and implement CostX-style
"line mode": hovering near a wall auto-detects the segment, extends it to its bounding
intersections, and a single click commits that two-point measurement.

**Background:** CostX has two drawing input modes in the Type group:
- **Point** (current behaviour) — click-to-place vertices, snap to endpoints/midpoints/intersections.
- **Line** — hover over a vector line (wall), the system detects the segment and extends it
  to where it meets crossing walls on each side; one click commits the result.

**Algorithm — extend-to-intersections:**
1. Nearest-segment search: find the `LineSegment` from `vectorIndex` closest to the cursor
   within the snap radius.
2. Parametric extension: model the detected segment as the infinite line
   `P(t) = P1 + t*(P2 - P1)` (t=0 at P1, t=1 at P2). For every *other* finite segment Q in
   the index, compute the t-value where the infinite line through the detected segment
   intersects Q (null if parallel or intersection lies outside Q's bounds).
3. Left boundary: `max(t : t ≤ t_cursor)` among all intersection t-values and `t=0`
   (the original P1 is a fallback).
4. Right boundary: `min(t : t ≥ t_cursor)` among all intersection t-values and `t=1`
   (the original P2 is a fallback). Here `t_cursor` is the projection of the cursor onto
   the detected segment.
5. The proposed measurement runs from `P(t_left)` to `P(t_right)`.

**Implementation milestones:**

**M6a — Store + Ribbon toggle.** Add `drawingType: "point" | "line"` and
`lineSnapResult: { start, end } | null` to the store. Wire Point/Line buttons in the Type
ribbon group: active button highlighted, Point is default.
*Gate: clicking Point/Line in the ribbon toggles the active highlight correctly.*
**Status: Implemented** — `tsc --noEmit` and `cargo check` both clean.

**M6b — Line snap detection + preview.** In `scheduleSnapResolution`, when
`drawingType === "line"`, call `resolveLineSnap` instead of `resolveSnap`. Draw the
proposed two-point line as a bold coloured overlay when hovering in line mode. Suppress
the normal point-snap indicator in line mode.
*Gate: hovering over a wall in line mode shows the detected segment highlighted between
its bounding intersections.*
**Status: Implemented** — pending visual verification in running app.

**M6c — Click to commit.** In `handlePointerDown` when `measuring` and
`drawingType === "line"`, commit a two-point measurement from `lineSnapResult` on click
(no vertex accumulation). If no line snap is live, the click is a no-op.
*Gate: clicking on a detected wall places a committed measurement rendered in the group's
colour; the quantity is correct.*
**Status: Implemented** — pending visual verification in running app.

**Key files:**
- `desktop/src-frontend/src/store/appStore.ts` — new state + `resolveLineSnap` action.
- `desktop/src-frontend/src/components/Ribbon.tsx` — wire Type buttons.
- `desktop/src-frontend/src/components/ViewerCanvas.tsx` — snap dispatch + preview + click handler.
