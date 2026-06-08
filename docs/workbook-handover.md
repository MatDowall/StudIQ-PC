# Workbook Feature — Handover Document

This document tracks the architecture, milestones, and implementation state of the
**Workbook** feature in StudIQ. Update it as each milestone is completed.

---

## Overview

The Workbook is a CostX-style cost-estimate view. Dimension groups (with their measured
quantities) are dragged from the Dimension Groups pane into a Workbook spreadsheet, where
they become priced line-items. Multiple workbooks can exist per project (under named
revisions), enabling alternative estimates or scope variations.

The Workbook lives behind its own tab ("Workbook") next to the existing "Dimensions" tab.
The two workflows share the same left-sidebar Dimension Groups pane (bottom half) so
dimension groups can be dragged into the active workbook at any time.

---

## Architecture

### Tab switching (`activeTab` in Zustand store)

`appStore.ts` holds `activeTab: "dimensions" | "workbook"`. Any component that needs to
know the active context reads this field; none receive it as a prop.

### Lazy-mount performance strategy

`App.tsx` tracks `workbookEverVisited` via a `useRef` (not state, so it never triggers a
re-render). The first time the user switches to the Workbook tab the flag flips to `true`
and `WorkbookView` is mounted. After that it remains mounted but is hidden with
`display: none` while the Dimensions tab is active.

The `Viewer` (canvas, tile cache, pan/zoom state) is similarly always mounted once a project
is open and hidden with `display: none` while in Workbook mode. This means:

- Switching tabs is instantaneous — no re-mount, no tile reload.
- Workbook data fetching (future Tauri invoke calls) happens only while in the Workbook tab.
- There is no concurrent rendering pressure from both views at once.

### Left-column switching

`LeftColumn.tsx` reads `activeTab` and renders:

| Tab | Top pane | Bottom pane |
|---|---|---|
| Dimensions | `DrawingRegisterPane` | `DimensionGroupPane` |
| Workbook | `WorkbookSidebarPane` | `DimensionGroupPane` |

The bottom pane (`DimensionGroupPane`) always stays so dimension groups are drag-accessible
from either workflow.

### Ribbon switching

`Ribbon.tsx` reads `activeTab` and swaps the button-group area between the full
Dimensions ribbon (Add, Properties, Copy, Type, Drawing, Snap) and `WorkbookRibbon`
(dummy buttons). The project-info bar on the right always persists.

---

## Component map

| File | Purpose |
|---|---|
| `components/WorkbookRibbon.tsx` | Workbook-specific ribbon buttons (all dummy for now) |
| `components/WorkbookSidebarPane.tsx` | Revision/workbook tree in the left sidebar (top half) |
| `components/WorkbookView.tsx` | Main spreadsheet content area (placeholder) |
| `store/appStore.ts` | `activeTab` + `setActiveTab` |
| `App.tsx` | Tab bar UI, lazy-mount logic, `display:none` switching |
| `LeftColumn.tsx` | Tab-aware top-pane rendering |
| `Ribbon.tsx` | Tab-aware ribbon button groups |

---

## Milestones

### Milestone 1 — Tab shell & environment ✅ COMPLETE (2026-06-06)

**Goal:** Split the app into Dimensions and Workbook workflows without breaking
existing functionality. No real workbook data yet.

**Delivered:**
- Tab bar above ribbon (28 px, spans full width, accent-underline on active tab)
- `activeTab` field in Zustand store
- `WorkbookRibbon` with six groups of disabled dummy buttons
- `WorkbookSidebarPane` — CostX-style revision tree with dummy data
  (Estimate → Revision 1 → Trade Estimate)
- `WorkbookView` — spreadsheet skeleton with column headers (expand / Name / Total)
  and a single dummy "Trade Estimate" row
- Viewer kept alive (display:none) behind Workbook tab — no canvas/tile state lost
- WorkbookView lazily mounted on first Workbook visit

**Gate:** App builds and runs; switching tabs changes ribbon, left-pane top half, and main
area without errors or performance regression in the Dimensions workflow. ✅ Passed.

**Post-ship fix — Viewer canvas height regression:**
Wrapping `<Viewer />` inside `position: absolute; inset: 0; display: block` caused the
canvas to collapse to ~1px because Viewer's root `flex` div has no explicit height — it
relied on the browser stretching it as a grid item. Fix: added `height: "100%"` to
Viewer's root div (`Viewer.tsx:96`). This chains the height back up through the inset
wrapper to the grid row and is robust regardless of what display context holds the Viewer.

---

### Milestone 2 — Workbook DB schema & revision CRUD ✅ COMPLETE (2026-06-06)

**Goal:** Persist workbook revisions in the project `.tcop` SQLite file.

**Delivered:**
- Tables `workbooks`, `workbook_revisions`, `workbook_items` created in `run_migrations()`
- Idempotent seed: new and existing projects get a default "Estimate" workbook with
  "Revision 1" on first open (via `INSERT … WHERE NOT EXISTS`)
- Tauri commands: `list_workbooks`, `create_workbook_revision`,
  `delete_workbook_revision`, `rename_workbook_revision` — all registered in `invoke_handler`
- `WorkbookSidebarPane` wired to live store data: real revision tree with inline
  double-click rename and per-row delete; "New Revision" header button enabled
- `WorkbookRibbon` "New Revision" button enabled and wired to `createWorkbookRevision`
- `appStore.ts`: `WorkbookDto` / `WorkbookRevisionDto` interfaces; `workbooks` +
  `activeRevisionId` state; `loadWorkbooks` called on project open/create/close
- Deleting the last revision is blocked in the UI (guard in `RevisionRow`)

**Gate:** App builds; switching to Workbook tab shows the live revision tree; "New
Revision" adds a revision persisted to SQLite; double-click renames in-place; delete
removes the revision (disabled when only one remains).

---

### Milestone 3 — Workbook spreadsheet (row model) ✅ COMPLETE (2026-06-06)

**Goal:** A real spreadsheet inside `WorkbookView` — Handsontable library, A–P columns,
toolbar, drill-down navigation, SQLite persistence.

#### Sub-milestone 3.1 — Spreadsheet library ✅

**Delivered:**
- `handsontable` v17.1.0 + `@handsontable/react-wrapper` v17.1.0 installed
- `WorkbookView.tsx` rewritten with `HotTable` — columns A:Code through P:Sum-Total
- Row headers (1, 2, 3…), column headers ("A:Code", "B:Description", …)
- Arrow-key navigation, scroll wheel (vertical + horizontal), column/row drag-resize
- `manualColumnResize`, `manualRowResize` enabled; 100 empty rows
- F:Subtotal (col 5) and H:Total (col 7) highlighted light yellow in headers and cells
- `ht-theme-classic` applied via `themeName` + CSS imports
  (`handsontable/styles/handsontable.css` + `handsontable/styles/ht-theme-classic.css`)
- **SQLite persistence** via new `workbook_sheet_data` table (one row per revision × path):
  - `save_workbook_sheet(revision_id, sheet_path, data_json)` — upsert
  - `load_workbook_sheet(revision_id, sheet_path)` — returns JSON or `"[]"`
  - Auto-save: 500 ms debounce on `afterChange`; immediate save before each drill navigation
  - Load: root sheet `"L1"` reloaded from SQLite whenever `activeRevisionId` changes
  - Sub-sheets loaded on demand (SQLite if not yet cached, else in-memory `sheetDataMap`)
- **Height stability fix**: `HotTable` isolated in `React.memo GridCore` component so
  parent state changes (active cell, formula bar) never reach Handsontable and trigger
  a height reset back to the initial `400` default.
- `rowHeaderWidth: 50` set explicitly so breadcrumb column boxes align with grid columns.

**Gate:** ✅ Confirmed by user.

#### Sub-milestone 3.2 — Page layout ✅

**Delivered:**
- **Toolbar row 1** (all levels): active-cell ref box | "Cell =" label | formula bar
  (bidirectional — editing the bar updates the active grid cell) | ··· | "Total = 0"
  (placeholder; future milestone: named cell)
- **Toolbar row 2** (Level 2+): breadcrumb of the Level-1 row drilled into — ← back
  arrow (width = `ROW_HDR_W` so column A aligns), code, description, quantity, unit,
  rate, F:Subtotal (yellow), G:Factor = **1.1000** (fixed dummy per spec), H:Total =
  subtotal × 1.1000
- **Toolbar row 3** (Level 3): breadcrumb of the Level-2 row drilled into — same layout
  without the separate code box (description spans A+B width)
- Breadcrumb boxes use initial `COL_WIDTHS` for alignment; they do not dynamically
  track user column-resize (acceptable — future refinement)

**Known limitation (future milestone):** The breadcrumb Sub-Total currently shows the
value from the F:Subtotal cell of the clicked row at the parent level. The spec intends
it to be the live sum of all H:Total values in the sub-sheet currently displayed. This
requires wiring `afterChange` to recompute and push an update into the breadcrumb state.
Factor (1.1000) and Total (ST × 1.1000) are correct dummies per spec.

**Gate:** ✅ Confirmed by user.

#### Sub-milestone 3.3 — Drill-down mechanics ✅

**Delivered:**
- **Level 1 → Level 2**: double-click on F:Subtotal column — `beforeOnCellMouseDown`
  intercepts (`event.detail >= 2` + `stopImmediatePropagation`), saves current sheet to
  SQLite, reads row context (A–H) into breadcrumb, loads Level-2 sheet from SQLite or
  starts empty; toolbar row 2 appears with the Level-1 row context
- **Level 2 → Level 3**: same mechanism on E:Rate column; toolbar row 3 appears
- **Back navigation**: ← on any breadcrumb row → `drillUp()`: saves current sheet to
  SQLite, pops path stack, restores parent sheet from in-memory cache, removes last
  breadcrumb row
- **Data isolation per path**: `sheetDataMap` keyed by path string (e.g. `"L1/R3/R7"`)
  ensures each sub-sheet retains its own data across navigation

**Gate:** ✅ Confirmed by user.

#### Sub-milestone 3.4 — Formulae ✅ COMPLETE (2026-06-07)

**Goal:** Excel-style formula evaluation in cells, with autocomplete and syntax hints in
the formula bar.

**Delivered:**
- `hyperformula` v3.3.0 installed; wired into Handsontable via `formulas: { engine: HyperFormula, sheetName: "Sheet1" }` in `hotSettings`
- **Operators**: `=` (formula prefix), `+ - * / ^ %`, comparison (`= > < >= <= <>`), string concatenation `&`, brackets, range colon, double-quoted strings — all handled natively by HyperFormula
- **Functions** (13): `SUM`, `PRODUCT`, `CEILING`, `FLOOR`, `PI`, `ROUNDUP`, `ROUNDDOWN`, `COS`, `COUNTIF`, `AVERAGE`, `COUNT`, `MIN`, `MAX`
- **Error values**: `#VALUE!` (bad args or overflow), `#DIV/0!` (division by zero), `#REF!` (non-existent cell) — rendered automatically by HyperFormula / Handsontable
- **Formula bar** shows formula string (`getSourceDataAtCell`) not the computed value, so the user can read and edit the formula
- **Autocomplete dropdown** — appears below the formula bar as the user types a function name after `=`; lists up to 8 matches; arrow-key navigation, Enter/Tab to accept, Escape to dismiss
- **Syntax hint** — displayed inside the autocomplete panel for the highlighted function (signature + one-line description)
- **Persistence** — changed all `getData()` calls to `captureSourceData()` (wraps `getSourceData()`) so formula strings, not computed values, are stored in SQLite; formulas are re-evaluated by HyperFormula on next load

**How to add more functions (future expansion):**
1. HyperFormula already supports 400+ functions — no code needed to enable them in the engine.
2. To surface a new function in the autocomplete/hint UI, add one entry to the `FORMULA_FUNCTIONS` object in `WorkbookView.tsx`:
   ```ts
   IF: { syntax: "IF(condition, value_if_true, value_if_false)", desc: "Returns one value if condition is true, another if false" },
   ```
   That is the only change required; the `FUNCTION_NAMES` array is derived from the keys automatically.

**Gate:** ✅ Build clean; app runs.

---

#### Sub-milestone 3.5 — Derivation rules, live breadcrumb rollup & maintenance tools ✅ COMPLETE (2026-06-07)

**Goal:** Wire up the cross-column / cross-level derivation rules implied by the column
model (Subtotal, Factor, Total, Rate roll-ups), make the breadcrumb toolbars reflect
live totals as the user edits, and add tools to clean up stale persisted data.

This sub-milestone was delivered as a sequence of small, user-confirmed increments
(each verified in `cargo tauri dev` before moving on) — keep that discipline for any
follow-on work here.

##### Features added

1. **Level 1 rollup** — `F:Subtotal` for each line = `SUM(H:Total)` of all rows in that
   row's Level 2 sub-sheet; `J/L/N/P` (Lab/Mat/Sub/Sum -Total) = column-wise `SUM` of the
   matching `J/L/N/P` columns in that Level 2 sheet (pulled through, unchanged).
   Implemented without breaking double-click drill-down (the drill handler keys off
   column index, not cell content, so a populated F cell still drills).
2. **Level 2 rollup** — `E:Rate` = `SUM(H:Total)` of the Level 3 rate-build-up sheet for
   that row; `I/K/M/O` (Lab/Mat/Sub/Sum) = column-wise `SUM` of the matching `I/K/M/O`
   columns in that Level 3 sheet (pulled through, unchanged); `J/L/N/P` (…-Total) =
   formula `<col>×C` — the pulled-through rate multiplied by that row's `C:Quantity`.
3. **Level 3 derivation** (and later mirrored to Levels 1 & 2):
   - `F:Subtotal = E:Rate × C:Quantity`
   - `H:Total = F:Subtotal × G:Factor`
   - `G:Factor` auto-populates to `1` the first time `F:Subtotal > 0` and `G` is empty
     (does not overwrite a user-entered factor).
4. **Live breadcrumb rollup** — the Level 2/3 breadcrumb toolbar rows (showing the
   parent/grandparent line item's Subtotal/Rate/Total) now recompute live as the
   *currently displayed* sheet is edited, instead of showing a static snapshot taken at
   drill-down time. Editing a Level 3 build-up sheet immediately updates the Level 2
   breadcrumb (and the Level 1 breadcrumb shown while at Level 3, if applicable) without
   requiring the user to drill back up first.
5. **Workbook maintenance tools** (toolbar row 1, far right):
   - **"Clean orphaned sheets"** — recursively scans the sheet tree from `L1`; for any
     row whose `Code`+`Description` are now empty (i.e. the line item was cleared after
     a sub-sheet had already been created for it), deletes that row's persisted
     sub-sheet *and everything beneath it*. This directly fixes the "orphaned Level 3
     build-up sheet still contributing to the total after its Level 2 line item is
     deleted" problem.
   - **"Clear workbook"** — wipes all persisted sheet data for the active revision and
     resets the view to a single blank Level 1 sheet.
   - Both run through the shared `ConfirmDialog` (destructive-action pattern used
     elsewhere in the app — see `DrawingRegisterPane`/`StartScreen`), show a transient
     status message (e.g. "Removed 2 orphaned build-up sheets"), and are guarded by a
     `cleanupBusy` flag so they can't be triggered concurrently or while the previous
     run is still in flight.

##### New backend (Tauri) commands

- `delete_workbook_sheet_subtree(revision_id, sheet_path)` — `DELETE … WHERE sheet_path
  = ? OR sheet_path LIKE '<path>/%'`; returns rows-affected (0 = no-op, safe to call
  speculatively for paths that were never saved).
- `clear_workbook_revision_data(revision_id)` — `DELETE FROM workbook_sheet_data WHERE
  revision_id = ?`; returns rows-affected.

Both registered in `invoke_handler` alongside the existing `save_workbook_sheet` /
`load_workbook_sheet`.

##### New frontend constants/helpers (`WorkbookView.tsx`)

- `COL_QTY = 2`, `COL_FACTOR = 6`, `COL_CODE = 0`, `COL_DESC = 1` — added alongside the
  existing `COL_SUBTOTAL` / `COL_RATE` / `COL_TOTAL`.
- `deriveLevelFormulas(hot, level, guardRef)` — runs the two-pass F→G→H derivation across
  an *entire* sheet; needed because `hot.loadData()` does not fire `afterChange`.
- `loadLevelData(hot, data, level, guardRef)` — wraps `clearSheet` + `loadData` +
  `deriveLevelFormulas`; replaced the old bare `loadData` at all 6 call sites (initial
  load ×2, `drillDown` ×4, `drillUp` ×1).
- `toNum(v)` — tolerant string/number → number coercion used by the live-rollup math.
- `sheetComputedMap` — a `Map<path, unknown[][]>` parallel to `sheetDataMap`, caching
  *evaluated* (`hot.getData()`) snapshots at the same moments `sheetDataMap` is updated
  (on drill-down/drill-up, when leaving a sheet). Required because `sheetDataMap` holds
  raw formula strings (e.g. `"=E5*C5"`) which sum to `NaN` — only evaluated values can be
  aggregated for rollups.
- `propagateLiveRollup()` — walks up `pathStack` from the current level to Level 1,
  recomputing each ancestor row's aggregate columns from a "merged" view (cached
  evaluated snapshot for sibling rows, freshly-recomputed values for the row being
  drilled through), and pushes the result into `breadcrumb` state via `readRowCtx`.
  Wired into `afterChange`, run after the per-sheet F/G/H derivation has settled.
- `isLineItemRow`, `fetchSheetSourceData`, `pruneOrphansUnder`, `purgeCachedSubtree`,
  `resetToRootSheet` — support functions for the maintenance tools (see Decisions below
  for why orphan-detection needed no new "list sheets" backend command).

##### Bugs encountered & fixes

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | `H:Total` cells that depend on `G:Factor == 1` don't recalculate until the factor is "re-entered", even though the value is already `1` | `hot.loadData()` does **not** fire `afterChange`, so the interactive-edit-driven derivation logic never ran when a sheet was loaded/navigated to — only `H` cells touched by a live edit got derived | Extracted the derivation into `deriveLevelFormulas` and call it explicitly from `loadLevelData` after every `loadData`, threading `level` + the `isAutoUpdatingRef` guard through all 6 call sites |
| 2 | Level 2 breadcrumb toolbar displayed raw formula text (`=E5*C5`) and `NaN` instead of computed values (screenshot-reported) | `readRowCtx` was fed `captureSourceData(hot)` — formula *strings* — and `BreadcrumbRow` did `parseFloat(ctx.subtotal) * 1.1`, producing `NaN` on a formula string | Changed `readRowCtx`'s parameter type from `(string\|null)[][]` to `unknown[][]` and fed it `hot.getData()` (evaluated values) at the `drillDown` call site instead of the cached source data |
| 3 | Level 2/3 breadcrumb toolbars were static snapshots — edits to the displayed sheet didn't propagate live into ancestor totals shown in the toolbar | The breadcrumb context was captured once via `readRowCtx` at drill-down time and never refreshed thereafter | Added `sheetComputedMap` (evaluated-snapshot cache) + `propagateLiveRollup`, invoked from `afterChange` on every edit at level ≥ 2 — see Features #4 above |
| 4 | Orphaned Level 3 (and Level 2) build-up sheets remain in `workbook_sheet_data` and keep contributing to ancestor totals after the owning line item is cleared | Drilling into a row always creates a child sheet keyed by `<parent>/R<row>` regardless of whether the row holds real data; clearing the line item afterwards does not clean up the now-unreachable sub-sheet rows already persisted in SQLite | Added the "Clean orphaned sheets" maintenance tool (recursive scan + `delete_workbook_sheet_subtree`) and "Clear workbook" (`clear_workbook_revision_data`) — see Features #5 above |

##### Decisions made

- **Two parallel per-path caches, not one.** `sheetDataMap` (formula-string source, used
  for persistence/restore) and `sheetComputedMap` (evaluated snapshots, used for summing)
  are kept in sync at the exact same moments (`drillDown`/`drillUp`, when leaving a
  sheet). Reusing a single cache and re-evaluating on demand was rejected — ancestor
  sheets aren't loaded into Handsontable/HyperFormula while not displayed, so there is
  nothing to re-evaluate without a costly hidden-instance round trip.
- **Orphan detection needs no new "list sheets" backend command.** Rather than listing
  every persisted `sheet_path` for a revision and reconciling against the live tree, the
  cleaner walks the *reachable* tree from `L1` (max depth 3) and, for every row that no
  longer looks like a line item (`Code` + `Description` both empty), unconditionally
  calls `delete_workbook_sheet_subtree` for that path. The delete is a no-op (returns
  `0` rows-affected) when nothing was ever saved there, so this is both simpler and
  correct — it also naturally handles multi-level orphaning (a deleted Level 1 row whose
  Level 2 *and* Level 3 sheets both still exist) in one `LIKE '<path>/%'` delete.
  "Orphaned" is defined purely by `Code`/`Description` emptiness — matches how a user
  actually "deletes" a line item in a fixed-row spreadsheet (clearing its content, since
  rows themselves are not removable).
- **Destructive maintenance ops reuse `ConfirmDialog`** (the same component used by
  `DrawingRegisterPane`/`StartScreen` for delete confirmations) rather than introducing a
  new dialog pattern, and report results via a transient inline status message rather
  than `window.alert` (no alert/toast convention exists elsewhere in the app, and a
  blocking native dialog would be inconsistent with the rest of the UI).
- **`cleanupBusy` guard** prevents overlapping runs of either maintenance op (both are
  multi-await async walks over potentially many sheets) and disables both toolbar buttons
  while either is running.

**Gate:** ✅ `npx tsc --noEmit` and `cargo check --package desktop` both clean; each
increment confirmed working by the user in `cargo tauri dev` before proceeding to the
next ("that works" / "that is fixed" for items 1–4; maintenance tools — "Clean orphaned
sheets" and "Clear workbook" — verified and approved by the user in-app, closing the gate).

---

#### Sub-milestone 3.6 — Template Manager ✅ COMPLETE (2026-06-07)

**Goal:** Let users save a workbook layout as a reusable template (with master Level 1/2/3
sheets), manage templates (list/create/rename/delete/describe), and create new workbook
revisions seeded from a chosen template.

**Architecture — templates reuse the workbook/revision/sheet-data infrastructure:**

Rather than building a parallel storage system, a template is backed by a real
`workbook_revisions` row inside a single hidden **"Templates" workbook** (flagged
`workbooks.is_template = 1`, excluded from `list_workbooks` / the sidebar tree via
`WHERE is_template = 0`). A `templates` table maps `(id, name, description, created_at)` →
`revision_id`. This means template editing is just `WorkbookView` pointed at a different
`activeRevisionId` — it reuses 100% of the existing grid load/save/derivation machinery
with zero duplication.

```sql
CREATE TABLE templates (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL,
    description TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    revision_id INTEGER NOT NULL REFERENCES workbook_revisions(id) ON DELETE CASCADE
);
```

`is_template` is added additively (`ALTER TABLE workbooks ADD COLUMN ... DEFAULT 0`,
errors discarded) per the project's migration convention. `ensure_template_workbook()`
finds-or-creates the hidden workbook lazily on first template creation.

**Backend commands** (in `lib.rs`): `list_templates`, `create_template`, `rename_template`,
`update_template_description`, `delete_template` (deletes the `templates` row by deleting
its `workbook_revisions` row, which cascades `workbook_items` / `workbook_sheet_data`), and
`create_workbook_revision_from_template(workbook_id, name, template_id)`.

**UI flow:**
- **Settings** dropdown button added to `WorkbookRibbon` (popover menu, portal-rendered to
  `document.body` — see "Dropdown menus" note below) → **Template Manager**.
- `TemplateManagerDialog`: list + detail panel — select, rename (`TextInputDialog`), delete
  (`ConfirmDialog`), description (autosaves on blur), "New Template" (`NewTemplateDialog`
  prompts name + description), "Edit Template" → `enterTemplateEdit`.
- **Template-edit mode** (`templateEditMode` in the store): `WorkbookView` renders a 5px
  red border, a header bar reading `Editing template "{name}"`, and **Save changes** /
  **Clear changes** buttons. `enterTemplateEdit` swaps `activeRevisionId` to the template's
  revision (stashing the previous one in `preTemplateRevisionId`); `exitTemplateEdit`
  restores it and reopens the Template Manager.
- **"New from Template"** ribbon action (`NewFromTemplateDialog`): pick a template + name
  → `createWorkbookRevisionFromTemplate`.

**Master L1 / L2 / L3 sheets — template-driven seeding:**

While editing a template, three toggle buttons in the red header switch between fixed
sheets via `jumpToSheet(path, level)` (a generalized, ancestry-free sibling of
`resetToRootSheet`):

| Toggle | Sheet path | Seeds |
|---|---|---|
| Master Takeoff (L1) | `"L1"` | the revision's real Level 1 sheet |
| Master Takeoff (L2) | `TEMPLATE_MASTER_L2_PATH` = `"TEMPLATE_MASTER_L2"` | new Level 2 sheets |
| Master Rate Build-up (L3) | `TEMPLATE_MASTER_L3_PATH` = `"TEMPLATE_MASTER_L3"` | new Level 3 (rate, `/R`) sheets |
| Master Quantity Build-up | `TEMPLATE_MASTER_LQ_PATH` = `"TEMPLATE_MASTER_LQ"` | new Quantity Build-up (`/Q`) sheets — see Sub-milestone 3.7 |

These reserved paths (never reachable via normal drill-down — real paths look like
`"L1/R3"`) are stored as ordinary `workbook_sheet_data` rows against the template's
revision. `create_workbook_revision_from_template` copies all four (`"L1"`,
`"TEMPLATE_MASTER_L2"`, `"TEMPLATE_MASTER_L3"`, `"TEMPLATE_MASTER_LQ"`) from the template
revision into the new revision's `workbook_sheet_data` — a **snapshot-at-creation**
model, not a live binding. From then on, `seedNewSheet()` in `drillDown` clones the
kind-appropriate master (`TEMPLATE_MASTER_L2_PATH` for new Level 2 sheets,
`TEMPLATE_MASTER_L3_PATH` for new `/R` Rate Build-up sheets, `TEMPLATE_MASTER_LQ_PATH`
for new `/Q` Quantity Build-up sheets) via `cloneSheetData()` whenever a genuinely-new
build-up sheet is created, falling back to `load_workbook_sheet` then
`createEmptyData()`.

**Gotcha — dropdown menus must be portal-rendered with their own outside-click ref:**
`SettingsDropdown`'s menu is rendered via `createPortal` into `document.body` (its parent
ribbon-group `<div>` has `overflow: hidden`, which would otherwise clip an absolutely
positioned popover). Because the menu lives outside the button's wrapper element in the
DOM, the outside-pointerdown-closes-menu handler must check **both** the wrapper ref *and*
a ref on the portaled menu — otherwise `pointerdown` on a menu item registers as "outside",
closing/unmounting the menu before its `click` handler fires, so clicking menu items
silently does nothing.

**Gate:** ✅ `npx tsc --noEmit` and `cargo check --package desktop` both clean; verified
working end-to-end by the user in `cargo tauri dev` (Settings → Template Manager →
create/rename/delete/describe; template-edit mode with all three master-sheet toggles;
New from Template).

---

#### Sub-milestone 3.7 — Quantity Build-up drill-down ✅ COMPLETE (2026-06-08)

**Goal:** A third drill-down, from `C:Quantity` at Level 2 (Takeoff), into a
**"Quantity Build-up"** sheet that lets the user build up a quantity from its components
(e.g. counting/measuring the individual members of a framing assembly), mirroring the
existing `E:Rate` → Rate Build-up drill-down but feeding back into `C:Quantity` instead
of `E:Rate`.

**Structurally a sibling of Level 3, not a new numeric level** — it sits at the same
*depth* as the Rate Build-up sheet (parent = an L2 row), so a single takeoff row can have
**both** an `E:Rate` child and a `C:Quantity` child concurrently. To support this without
adding new state alongside `pathStack`/`level` (which stays `1 | 2 | 3`), the sheet's
*kind* is derived purely from its path suffix:

```ts
type SheetKind = "standard" | "qty";
function isQtyBuildupPath(path: string): boolean {
  return /\/Q\d+$/.test(path) || path === TEMPLATE_MASTER_LQ_PATH;
}
function sheetKindForPath(path: string): SheetKind {
  return isQtyBuildupPath(path) ? "qty" : "standard";
}
```

Child paths use `/Q<row>` (vs. the existing `/R<row>`) — e.g. `"L1/R3/Q7"` — so the two
relationships can never collide on the same row. `pathLastRow`'s regex was generalized
from `/\/R(\d+)$/` to `/\/[RQ](\d+)$/` to stay kind-agnostic for row-index extraction.

**Column layout** (A–H differ; I–P unchanged from the standard layout):

| Col | A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|---|
| Label | Code | Description | Count | Length | Width | Height | Factor | Quantity |
| Role | identity | identity | input | input | input | input | factor (auto = 1) | `=C×D×E×F×G` |

`QTY_COLUMNS` / `QTY_COL_HEADERS` / `QTY_COL_WIDTHS` mirror the standard `COLUMNS` arrays
with this A–H swap; `COL_COUNT`/`COL_LENGTH`/`COL_WIDTH`/`COL_HEIGHT` alias the existing
column indices 2–5 (Factor/Quantity reuse `COL_FACTOR`/`COL_TOTAL`). `loadLevelData` now
takes the target `path`, derives `kind` via `sheetKindForPath`, and calls
`hot.updateSettings({ colHeaders, colWidths })` choosing the `QTY_*` or standard arrays
before `clearSheet`/`loadData` — centralizing the header swap for every sheet-display
call site (initial load, `drillDown`, `drillUp`, `jumpToSheet`).

**Derivation** — `deriveLevelFormulas` and the inline `afterChange` derivation block both
take a `kind` parameter and branch on it. The `"qty"` pass is simpler than the standard
Level 3 pass: there is no `F = E×C` step (here `F` is a plain "Height" input), and `I–P`
(cols 8–15) are left untouched (this sheet doesn't drill further, so nothing pulls
through into it). For each row with any of C/D/E/F populated: `G` auto-populates to `1`
the first time it's blank (same threshold pattern as the existing Factor columns), and
`H` is written as the formula `=PRODUCT(C{r},D{r},E{r},F{r},G{r})` — see "Bugs encountered & fixes" below for why `PRODUCT` was used instead of `*`.

**Drill trigger** — `isDrillColumn` now also returns true for `(level === 2, col ===
COL_QTY)`; `beforeOnCellMouseDown` passes the clicked column through to `drillDownRef`
(signature changed from `(row) => void` to `(row, col) => void`) so `drillDown` can
choose the child path suffix (`/Q` vs `/R`) and master-template path
(`TEMPLATE_MASTER_LQ_PATH` vs the L2/L3 choice) based on which column was
double-clicked. Drilling is allowed regardless of whether the cell is populated or
linked from a dimension-group import — those are not mutually exclusive (a future
milestone may populate Quantity Build-up rows directly from a dragged-in dimension
group's component breakdown).

**Rollup** — on `drillUp` from a `/Q` sheet, `parentData[row][COL_QTY] = SUM(child
H:Quantity)` (via the existing `sumComputedCol(computed, COL_TOTAL)` — same column
index, different meaning). Nothing else needs writing: redisplaying the L2 parent runs
`deriveLevelFormulas` (level 2, `"standard"` kind), which recomputes `F = E×C`, `G`, `H`,
and the `J/L/N/P = I/K/M/O × C` pull-through formulas from the new `C` value — exactly as
already happens after an `E:Rate` rollup from a Rate Build-up sheet. `propagateLiveRollup`
gained a parallel branch for live (pre-drill-up) breadcrumb updates: it sums the
displayed `/Q` sheet's `H` column into a live `C`, then re-derives that row's
`F`/`G`/`H`/`J`/`L`/`N`/`P` in-memory the same way.

**Orphan pruning** — `pruneOrphansUnder` now also probes `${path}/Q${r}` alongside
`${path}/R${r}` for Level 2 rows whose line item has been cleared, deleting both
subtrees via `delete_workbook_sheet_subtree`.

**Template Manager** — a fourth master-sheet toggle, **"Master Quantity Build-up"**
(`TEMPLATE_MASTER_LQ_PATH = "TEMPLATE_MASTER_LQ"`), was added alongside the existing
three (see Sub-milestone 3.6's table, now with a fourth row); `masterView` extended to
`"L1" | "L2" | "L3" | "LQ"`. `create_workbook_revision_from_template` (`lib.rs`) seeds
`"TEMPLATE_MASTER_LQ"` from the template revision into new revisions alongside the other
three reserved paths.

##### Bugs encountered & fixes

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | After entering a value, drilling up and re-entering the *same* Quantity Build-up sub-sheet sometimes deposited a stale value (e.g. an `8` typed elsewhere, or even the parent row's `C:Quantity`) into an unrelated cell of the freshly-loaded sheet — and sometimes left that cell sitting open in edit mode (screenshot-reported) | The first click of the double-click that triggers a drill already selects (and, on an already-selected cell, begins editing) the source cell before `beforeOnCellMouseDown` intercepts the second click. The resulting open editor — still showing the *old* cell's pending value — stayed positioned at the same screen coordinates while `drillDown`/`drillUp` swapped in the new sheet's data underneath it, and committed its stale value into whatever cell of the *new* sheet ended up there | Added `closeActiveEditor(hot)` (cancels any pending edit, closes the editor, deselects) and call it: immediately in `beforeOnCellMouseDown` when a drill is detected (closing the editor the click itself opened, before the deferred `drillDown` fires), and again at the top of `drillDown`, `drillUp`, and `jumpToSheet` as a second line of defence for any other sheet-swap path |
| 2 | `H:Quantity` came out `0` whenever any of Count/Length/Width/Height was left blank — e.g. a row that only needed Count×Length (leaving Width/Height unused) zeroed out instead of producing a sensible product (user-reported) | The original formula `=C{r}*D{r}*E{r}*F{r}*G{r}` multiplies a blank cell as `0`, not `1` — unlike `G:Factor`, which has an explicit auto-populate-to-1 pass, the other input columns have no such treatment and a bare `*` has no "ignore blanks" semantics | Switched the formula to `=PRODUCT(C{r},D{r},E{r},F{r},G{r})` — `PRODUCT` ignores blank cells (the same convention `SUM`/`AVERAGE` use) rather than coercing them to `0`, so an unused dimension contributes a neutral `1`. (An earlier draft wrapped each operand in `IF({col}{r}="",1,{col}{r})`, functionally identical but far noisier — `PRODUCT` is the simpler idiom, and HyperFormula already supports it.) |

**Gate:** `npx tsc --noEmit` and `npm run build` (Vite + `cargo build --release`) both
clean. Both bug fixes confirmed working by the user in `cargo tauri dev`.

---

#### Sub-milestone 3.7.1 — Auto-populate framing Quantity Build-up on drop ✅ (2026-06-08)

**Goal:** Dropping a **timber framing** dimension group onto `C:Quantity` shouldn't just
import the group's `matchingTotalM` (existing `handleGroupDrop` behaviour, see Sub-milestone
3.7's parent context) — it should also auto-build the row's Quantity Build-up sub-sheet from
the group's component breakdown, and surface any different-sized lintels as their own takeoff
line items, so the user never has to manually re-type the framing makeup.

**Where:** all new logic lives in `WorkbookView.tsx`, triggered from the existing
`timber_framing` branch of `handleGroupDrop` (which still does the `applyImport` of
`matchingTotalM` into C/D as before) via a new `populateFramingRollup(row, breakdown)`:

- **Matching-size components → Quantity Build-up sub-sheet.** For every
  `FramingComponentTotal` in `breakdown.components` *without* a `sizeOverride` (plates,
  studs, dwangs, kings, trimmers, jacks, sills, sill-jacks, and same-size lintels),
  `populateFramingRollup` writes one row into a freshly-built `<path>/Q<row>` sheet array —
  `B:Description = component.label`, `D:Length = totalM.toFixed(3)` — and seeds it directly
  via `sheetDataMap.current.set` + `persistSheet`, *without* navigating into it. Because
  `drillDown` checks `sheetDataMap.current.has(newPath)` before falling back to
  loading/seeding from `TEMPLATE_MASTER_LQ_PATH`, double-clicking into `C:Quantity`
  immediately shows the pre-built makeup — `G:Factor`/`H:Quantity` are filled in by the
  normal `deriveLevelFormulas("qty")` pass that already runs on display, exactly as if the
  user had typed the rows themselves.
- **Different-sized lintels → independent takeoff-level line items.** Per CLAUDE.md
  ("Timber framing: one quantity per framing size"), a lintel whose size differs from the
  group's `framingSize` must **not** roll into `matchingTotalM` or appear in the Quantity
  Build-up makeup (that would silently mix two different timber sizes into one quantity).
  `aggregateFramingGroup` already keeps these separate — they're the `FramingComponentTotal`
  entries *with* a `sizeOverride`, one per distinct override size (its `framingComponentKey`
  includes the size). For each, `populateFramingRollup` calls `insertLintelRowsBelow` to drop
  a plain line item directly under the group's row: `B:Description = "<size> Lintel to last"`
  (e.g. `"140x45 Lintel to last"`), `C:Quantity = totalM.toFixed(3)`, `D:Unit = "m"` — set via
  `hot.setDataAtCell` so the normal `afterChange` derivation wires up `F`/`H`/etc. exactly as
  for a manually-entered row. No Quantity Build-up drilldown is created for these (there's
  nothing to break down — the value *is* the lineal-metre total) and no dimension-group link
  is recorded (it's a derived-but-static value, not a live import).

**Edge case — rows already occupied directly below.** If the group is dropped on a row whose
following row(s) already hold real line items (per the existing `isLineItemRow` check —
non-empty Code or Description), simply writing the lintel rows there would silently overwrite
that data. `insertLintelRowsBelow` first scans down from `afterRow+1` for the last occupied
row, and if it finds one, calls `shiftStandardRowsDown` to relocate that whole occupied block
(and everything between) down by the number of lintel rows being inserted — freeing a clean
gap — before writing the new rows into it.

**Edge case — formula columns can't be copied verbatim when shifting.** `F`/`H`/`J`/`L`/`N`/`P`
hold row-relative formula strings (`=E{r}*C{r}`, `=F{r}*G{r}`, `=I{r}*C{r}`, …). A naive
row-by-row copy would carry the *old* row's formula text to the *new* row position, leaving
every shifted formula pointing at the wrong cells. `shiftStandardRowsDown` instead copies only
the genuinely-input/pulled-through columns (`A`/`B`/`C`/`D`/`E`/`G`/`I`/`K`/`M`/`O`) verbatim,
blanks the formula columns at the destination, and then calls the existing
`deriveLevelFormulas(hot, level, guardRef, "standard")` once over the whole sheet — which
regenerates `F`/`H`/`J`/`L`/`N`/`P` for the moved rows (and is a harmless no-op everywhere
else) using the correct new row indices, exactly as if those rows had just been freshly typed.
Cell links (`cellLinkMap`) and per-cell formatting (`cellStyleMap`) are similarly relocated by
a small generic `shiftRowKeyedEntries` helper (both maps are keyed `"row,col"` via the same
`styleKey`), so a shifted row keeps its dimension-group link / bold / colour / etc.

**Edge case — grid is a fixed `NUM_ROWS` (100-row) array, not a dynamically-growable sheet.**
There's no `alter('insert_row', …)` here (would change persisted row counts and break the
whole-grid snapshot model `captureSourceData`/`persistSheet` rely on); "inserting" a row
really means shifting everything below it down within the fixed array. Both
`shiftStandardRowsDown` and `shiftRowKeyedEntries` therefore drop (rather than wrap or error
on) any row/entry that would land past index 99 — sheets essentially never fill all 100 rows,
so silently losing a far-distant trailing blank row is the right trade-off over crashing or
corrupting the grid.

**Verification needed (UI/UX — please check in `cargo tauri dev`):**
1. Drag a timber-framing dimension group onto an empty `C:Quantity` cell at Level 2 — confirm
   `C`/`D` import as before (`matchingTotalM`, green-linked), **and** that double-clicking
   into `C:Quantity` opens a Quantity Build-up sheet already populated with one row per
   matching-size component (Description + Length, e.g. "Studs (26)" / `60.060`), with
   `G:Factor` = 1 and `H:Quantity` correctly computed.
2. Drop a framing group whose breakdown includes a different-sized lintel (e.g. the
   140×45 group with 90×45 lintels from the screenshot) — confirm a line item appears
   directly below reading `B = "90x45 Lintel to last"`, `C = 3.780`, `D = "m"`, with
   `F`/`H` computing normally once a rate is entered.
3. Drop the same kind of group onto a row that already has real line items immediately below
   it — confirm those rows are pushed down intact (values, formulas once a rate is present,
   any cell colours/links) rather than overwritten, and the lintel row(s) land in the freed
   gap directly under the dropped group.
4. Drop a framing group with **two** different override lintel sizes present — confirm two
   separate "`<size> Lintel to last`" rows appear, each with its own total.

---

### Milestone 4 — Drag dimension groups into workbook

**Goal:** Drag a dimension group from the left-sidebar pane onto the workbook, creating
a priced row with the group's live quantity.

**Planned work:**
- HTML drag-and-drop from `DimensionGroupPane` rows
- Drop target in `WorkbookView` grid
- On drop: insert a `workbook_item` row linked to the dimension group
- Live quantity sync: workbook row quantity updates when the group's measurements change

**CLAUDE.md note (to add when done):** Each distinct framing size in a framing group must
produce its own row (see "Workbook implication" section of CLAUDE.md).

---

### Milestone 5 — Rate entry & totalling

**Goal:** Enter unit rates; compute row amounts and folder/workbook totals.

**Planned work:**
- Inline rate cell editing
- Amount = quantity × rate
- Folder subtotals roll up to workbook total
- Workbook total shown in `WorkbookSidebarPane` beside the revision name

---

### Milestone 6 — Multiple workbooks & revision management

**Goal:** Create, rename, delete, and duplicate workbook revisions; compare totals
between revisions.

---

### Milestone 7 — Export

**Goal:** Export the active workbook to Excel (.xlsx) and/or PDF.

---

## Data model (target schema — subject to change)

```sql
CREATE TABLE workbooks (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL,  -- always 1 in single-project files
    name        TEXT NOT NULL DEFAULT 'Estimate'
);

CREATE TABLE workbook_revisions (
    id          INTEGER PRIMARY KEY,
    workbook_id INTEGER NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workbook_items (
    id              INTEGER PRIMARY KEY,
    revision_id     INTEGER NOT NULL REFERENCES workbook_revisions(id) ON DELETE CASCADE,
    parent_id       INTEGER REFERENCES workbook_items(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    item_type       TEXT NOT NULL CHECK(item_type IN ('folder', 'line')),
    name            TEXT NOT NULL,
    -- link to dimension group (null for manually-entered rows)
    dimension_group_id INTEGER REFERENCES tree_nodes(id) ON DELETE SET NULL,
    -- for framing groups, the specific framing size this row tracks (null = all / non-framing)
    framing_size    TEXT,
    unit            TEXT,
    quantity        REAL,
    rate            REAL,
    notes           TEXT
);
```

---

## Notes & decisions

- `workbookEverVisited` is a `useRef` (not state) in `App.tsx` so it never triggers an
  extra render cycle when the user first clicks Workbook.
- `display: none` (not `visibility: hidden`) is used for inactive views — this is important
  because `visibility: hidden` still participates in layout and can cause the Viewer canvas
  to report incorrect dimensions.
- The DimensionGroupPane remains visible in both tabs — this is intentional (CostX model).
- Future workbook-specific Tauri commands should be namespaced `workbook_*` to avoid
  collision with dimension/drawing commands.
