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

> **Bugfix (2026-06-09): lintel `C:Quantity` cells were drillable, causing their values to
> be overwritten on drill-up.**
>
> A lintel row placed by `insertLintelRowsBelow` has a flat quantity — there is no
> sub-breakdown to build up, and the value placed is already the final figure. But because
> `C:Quantity` at Level 2 is a drill column (`isDrillColumn` returns true for
> `col === COL_QTY` at level 2), double-clicking a lintel row's quantity would create a
> new `/Q<row>` Quantity Build-up sub-sheet. Drilling back up from that (empty) sub-sheet
> wrote `SUM(child H)` = `0` into the parent's `C:Quantity`, silently zeroing the lintel
> total.
>
> **Fix:** `insertLintelRowsBelow` now calls `setCellExcluded(path, r, COL_QTY, true)` for
> each placed lintel row immediately after writing its data cells. The existing Sub-milestone
> 3.9 guard in `beforeOnCellMouseDown` (`if (isDrill && isCellExcluded(...)) return`) then
> blocks the double-click before it can fire `drillDown`. The cell renderer shows the
> quantity in black (not drill-blue), matching the convention for excluded drill columns.
> Exclusions are persisted to `workbook_sheet_exclusions` and travel with the row if a
> subsequent drop forces `shiftStandardRowsDown` to relocate it (the existing
> `shiftRowKeyedSet` call inside that helper already handles this).

---

#### Sub-milestone 3.8 — Named Cells (Excel-style names) ✅ (2026-06-08)

> **Bugfix (2026-06-08):** workbooks created *from a template* that contained named cells
> showed `#NAME?` everywhere those names were referenced, and the Name Manager listed
> nothing — but only after an app restart (within the same session, the template's prior
> load had already pushed its named expressions into HyperFormula's shared registry,
> masking the gap). Root cause: `create_workbook_revision_from_template` in `lib.rs`
> copied `workbook_sheet_data` / `workbook_sheet_styles` / `workbook_sheet_exclusions`
> for the seed sheets but never copied the template revision's `workbook_named_cells`
> rows — that table is revision-scoped, not sheet-scoped, so it sat outside the per-sheet
> seeding loop and was simply missed. Fixed by copying every `(name, sheet_path, row, col)`
> row from `template_revision_id` to the new `revision_id` right after the sheet-seeding
> loop, before the function returns its `WorkbookRevisionDto`.

> **Bugfix (2026-06-09): named-cell formulas showed stale values on first open** — e.g. a
> cell `=1+margin/100` displaying `1.00` instead of `1.10` even though the `margin` named
> cell held `10`. Re-entering the named cell value in the grid fixed it, but the value was
> wrong immediately after opening the workbook.
>
> **Root cause — two interacting issues in `WorkbookView.tsx`:**
>
> 1. `loadLevelDataExcl` is internally async: it calls `ensureSheetExclusionsLoaded(...).then(()
>    => loadLevelData(...))`, so it returns *immediately* — before HyperFormula has actually seen
>    the sheet data. All six call sites then called `refreshNamedCellsForPath` in the very next
>    line, which ran before `loadLevelData` and therefore read `hot.getDataAtCell(...)` = null.
>    `namedExprFromValue(null)` → `"=0"`, so every named cell got registered as `0` into
>    HyperFormula. When `loadLevelData` finally fired, HyperFormula evaluated
>    `=1+margin/100` with `margin=0` → `1.00`.
>
> 2. `invoke("load_workbook_sheet")` and `invoke("load_workbook_named_cells")` are parallel
>    fire-and-forget promises. If named cells resolved *before* the sheet, `readCellValue`
>    returned null (hot held no data yet) → `margin=0` registered. If named cells resolved
>    *after* the sheet finished (including `loadLevelData`), `addNamedExpression("margin","=10")`
>    was called correctly but Handsontable did not automatically re-render — the update happened
>    outside its normal edit-cycle so the `valuesUpdated` event from HyperFormula did not
>    trigger a visible repaint.
>
> **Fix (both issues must be addressed):**
>
> - Moved `refreshNamedCellsForPath(path)` *inside* `loadLevelDataExcl`'s async callback,
>   immediately after `loadLevelData` completes. At that point `hot.getDataAtCell` returns the
>   actual cell values, so named expressions are registered with correct literals. Added
>   `if (namedCellMap.current.size > 0) hot.render()` right after to force Handsontable to
>   repaint any formula cells that now display different values.
> - Removed the six premature `refreshNamedCellsForPath` calls from every call site
>   (`load_workbook_sheet` `.then`/`.catch`, `drillDown`, `drillUp`, `jumpToSheet`,
>   `resetToRootSheet`) — they were all executing before `loadLevelData` and reading stale/null
>   values.
> - Added `if (entries.length > 0) hotRef.current?.hotInstance?.render()` at the end of the
>   `load_workbook_named_cells` `.then()` callback, to handle the race where named cells
>   resolve *after* the sheet is already displayed. HyperFormula recalculates synchronously
>   when `addNamedExpression` is called; the explicit `render()` ensures Handsontable
>   repaints cells that depend on the newly-registered names.

> **Bugfix (2026-06-09): named-cell references didn't update live when the bound cell changed**
> — the literal-snapshot model above was the root cause. A named cell registered as `=10`
> (a literal) sits *outside* HyperFormula's dependency graph, so editing the bound cell only
> updated the snapshot if some other code path happened to re-register it. Dependent formulas
> therefore went stale and only "caught up" on a sheet/tab change or app reopen (which reloads
> + re-derives the sheet) — and sometimes not at all. The earlier `syncNamedCellsForChanges`
> hack (re-register + manual `hot.render()` from `afterChange`) was unreliable because it
> mutated the engine mid-edit-cycle, outside Handsontable's repaint flow.
>
> **Fix — hybrid live-reference model (`namedExprFormula`):** a named cell is now registered as
> a **live HyperFormula reference** (`=Sheet1!$C$5`) *whenever its bound cell is on the
> currently-active sheet*. HyperFormula then tracks the dependency natively, so editing the
> bound cell recomputes **and repaints** every dependent formula instantly — exactly Excel's
> named-range behaviour, with zero manual sync. Only when the bound cell is on a *different*
> sheet (HyperFormula reuses one internal `"Sheet1"` across drill levels, so a live ref would
> resolve against the wrong sheet) do we fall back to a **literal snapshot** of its last-known
> evaluated value — and that case needs no live update anyway, since the bound cell isn't
> visible to edit. `refreshNamedCellsForPath` now re-registers *every* named cell after each
> sheet load (not just those on the loaded path): names entering the active sheet flip to live
> references, names leaving it flip back to fresh literals (read from `sheetComputedMap`).
> `syncNamedCellsForChanges` and its `afterChange` call were removed entirely as the live
> reference makes them redundant.

> **Bugfix (2026-06-09): named cells couldn't be used from a *different* sheet than their
> bound cell** — referencing `=margin*2` on a child/other sheet showed `#VALUE!` (or a stale
> value that only sometimes corrected itself on re-edit/reopen). Root cause was an *ordering*
> bug in `loadLevelData`, which ran `clearSheet → loadData → deriveLevelFormulas` and only
> re-pointed the named expressions to the new active sheet *afterwards*. So when `loadData`
> first evaluated the new sheet's formulas, the cross-sheet name was still a **live reference**
> (`=Sheet1!$A$1`) aimed at the cell that `clearSheet` had just emptied → it resolved to
> `null` → `#VALUE!`, and the Handsontable Formulas plugin painted that error. Re-pointing the
> name to its literal afterwards recomputed the HyperFormula engine but did not reliably
> repaint the grid (the change came in *outside* the plugin's edit cycle), so the error stuck.
>
> **Fix:** `loadLevelData` takes a new optional `reRegisterNamed?: () => void` callback and
> invokes it **between `clearSheet` and `loadData`** — `loadLevelDataExcl` passes
> `() => refreshNamedCellsForPath(path)`. Because `pathStack` is updated to the target path
> *before* any sheet load on every navigation route (`drillDown`, `drillUp`, `jumpToSheet`,
> `resetToRootSheet`, the initial L1 effect), `namedExprFormula` already sees the correct
> active sheet: names bound to it become live references, names bound elsewhere become fresh
> literals — *before* the new sheet's formulas are ever evaluated. The very first evaluation
> therefore sees the correct value and no transient `#VALUE!` is ever painted. (Verified
> against HyperFormula 3.3.0 by replaying the exact `clearSheet → reRegister → loadData`
> sequence: cross-sheet `=margin*2` resolves to `20` on first eval, and the live reference is
> correctly restored — including live propagation — on navigating back to the bound sheet.)
>
> Caveat: a literal snapshot reads the bound cell's last *evaluated* value from
> `sheetComputedMap` (captured on `drillDown`/`drillUp`). `jumpToSheet`/`resetToRootSheet`
> reset that map, so a name bound to a sheet not visited since such a jump falls back to its
> raw stored source — acceptable for those rarer entry points; ordinary drill navigation keeps
> the snapshots intact.


**Goal:** Let the user bind a workbook-wide name to a single cell (Excel's "Define Name"),
usable in formulas at any drill level, plus a Name Manager dialog to view / jump to / rename
/ delete those bindings (Excel's "Name Manager").

**Where:** all logic lives in `WorkbookView.tsx`, with a new presentational dialog component
`NamedCellsManagerDialog.tsx`.

##### Data model & persistence

- New type `NamedCell { name, path, row, col }` — a workbook-wide name bound to one cell
  (sheet path + row/col), unique per revision.
- New SQLite table `workbook_named_cells(id PK, revision_id FK CASCADE, name, sheet_path,
  row, col, UNIQUE(revision_id, name))` and three Tauri commands in `lib.rs`:
  `save_workbook_named_cell` (upsert via `ON CONFLICT(revision_id, name) DO UPDATE`),
  `delete_workbook_named_cell`, `load_workbook_named_cells` (returns the full set as JSON).
- Frontend keeps two pieces of bookkeeping: `namedCellMap` (`Map<name, NamedCell>` — the
  source of truth for the app) and `registeredNamedExprRef` (`Set<name>` — tracks which
  names already exist in the live HyperFormula engine, since it needs `addNamedExpression`
  the first time and `changeNamedExpression` thereafter). Both are `useRef`s, loaded once per
  active revision in the same effect that loads sheet data, and reset on revision switch.

##### Why values are embedded as literals, not live references

`registerNamedExpression(nc, value)` builds the named expression as `=<literal>`
(`namedExprFromValue` renders numbers bare and quotes text) rather than `=Sheet1!A1` —
because HyperFormula reuses a single internal `"Sheet1"` across every drill level, a live
cell reference would resolve against whatever sheet happens to be loaded, not the sheet the
name was actually bound to. `readCellValue(path, row, col)` resolves the bound cell's
*evaluated* value regardless of which sheet currently has the grid (active sheet via
Handsontable, an ancestor via its rollup snapshot in `sheetComputedMap`, or the raw stored
string as a last resort), and `refreshNamedCellsForPath` / `syncNamedCellsForChanges` keep
the cached literal in sync on navigation and live edits respectively.

##### Creating a name

Right-clicking any cell always offers **"New Named Cell…"** in the grid context menu, which
opens a `TextInputDialog` (state `namedCellDialog: { row, col } | null`). The entered name is
checked against `isValidNamedCellName` (Excel-style identifier rules — must start with a
letter/underscore, contain only letters/digits/underscores/periods, and must *not* look like
a cell reference such as `A1`, since HyperFormula rejects those names anyway) before
`defineNamedCell(name, path, row, col)` persists it, updates `namedCellMap`, and registers it
with HyperFormula.

##### Name Manager dialog

A new toolbar button **"Named Cells"** (icon `sell`, alongside the workbook-maintenance
buttons) opens `NamedCellsManagerDialog` — a list+detail dialog modelled directly on
`TemplateManagerDialog`'s layout/styling (`theme.*` tokens throughout):

- **List** (left column) — every bound name with its sheet path and `"A1"`-style cell
  reference (via the existing `cellRefLabel` helper), built fresh from `namedCellMap` each
  time the dialog opens (it's a plain prop — `Array.from(namedCellMap.current.values())…`,
  not separately-tracked reactive state, since the dialog is short-lived and the map is the
  source of truth).
- **Go to** — `goToNamedCell(name)` either selects/scrolls within the current sheet
  (`hot.selectCell` + `hot.scrollViewportTo`) or, for a different sheet, calls `jumpToSheet`
  with a new optional third parameter `selectAfter?: { row, col }` that performs the same
  select-and-scroll once the target sheet's data has loaded and rendered. The target level is
  derived purely from path depth via a new helper `levelForPath` (`"L1"` → 1, `"L1/R3"` → 2,
  `"L1/R3/R2"` / `"L1/R3/Q5"` → 3) since the manager only has the bound cell's path to work from.
- **Rename** — `renameNamedCell(oldName, newName)`, implemented as delete-then-redefine
  (`removeNamedCell` followed by `defineNamedCell`) because `workbook_named_cells` is unique
  on `name`, so there's no in-place rename at the DB layer. The dialog itself guards against
  invalid names and collisions with existing names before calling it.
- **Delete** — `removeNamedCell(name)`, gated behind a `ConfirmDialog` (consistent with every
  other destructive action in the workbook), tears down all three layers: the persisted row
  (`delete_workbook_named_cell`), the live HyperFormula named expression
  (`hf.removeNamedExpression`, wrapped in try/catch since the engine may not have it
  registered), and local bookkeeping (`namedCellMap`, `registeredNamedExprRef`).

**Verification needed (UI/UX — please check in `cargo tauri dev`):**
1. Right-click a cell, create a named cell, then reference it by name in a formula on a
   different sheet/level — confirm it resolves to the bound cell's value.
2. Open **Named Cells** from the toolbar — confirm the list shows the name, sheet path and
   cell reference correctly, and that **Go to** jumps to (and highlights/scrolls to) the right
   cell whether it's on the current sheet or a different one (including a different drill level).
3. **Rename** a named cell to a new valid name — confirm formulas referencing the old name now
   show `#NAME?`-style errors and formulas updated to the new name resolve correctly; confirm
   renaming to an existing name or an invalid identifier (e.g. `A1`, `1abc`) is rejected with
   an explanatory message.
4. **Delete** a named cell (with the confirm dialog) — confirm it disappears from the list,
   any formula referencing it now errors, and it does not reappear after closing/reopening the
   workbook (i.e. it's actually gone from `workbook_named_cells`, not just the in-memory map).

---

#### Sub-milestone 3.9 — Exclude cells from auto-calculation ✅ (2026-06-08)

**Goal:** Let the user "switch off" the F:Subtotal/G:Factor/H:Total auto-derivation for a
range of cells, per sheet. Needed for templates with a hand-built summary block at the
bottom of the page (e.g. SUBTOTAL/MARGIN/TENDER TOTAL rows) whose F/G/H cells carry their
own formulas — without exclusion, the drill-up rollup, the factor default-to-1, and the
`H = F×G` formula injection would all clobber that block on every sheet load/edit/navigation.

##### Data model & persistence

- New SQLite table `workbook_sheet_exclusions(id PK, revision_id FK CASCADE, sheet_path,
  exclusions_json, UNIQUE(revision_id, sheet_path))` — `exclusions_json` is a flat JSON object
  keyed by `"row,col"` → `true`, mirroring `workbook_sheet_links`/`workbook_sheet_styles`.
- Two Tauri commands in `lib.rs`: `save_workbook_sheet_exclusions` (upsert),
  `load_workbook_sheet_exclusions` (returns `"{}"` when none saved). Cleaned up alongside
  links/styles in `delete_workbook_sheet_subtree` and `clear_workbook_revision_data`, and
  carried along with the rest of a sheet's persisted state when a project is created from a
  template (the `["L1", "TEMPLATE_MASTER_L2", "TEMPLATE_MASTER_L3", "TEMPLATE_MASTER_LQ"]`
  copy loop in `create_workbook_revision`) — so a template author's exclusions travel into
  every project created from it.
- Frontend mirrors the existing per-cell maps: `cellExclusionMap` (`Map<path, Set<"row,col">>`)
  + `loadedExclusionPathsRef` (`Set<path>`, once-per-path load guard), both `useRef`s reset on
  revision switch / workbook clear and pruned in `purgeCachedSubtree`. Helpers `isCellExcluded`,
  `setCellExcluded` (mutates + persists immediately via `persistSheetExclusions`), and
  `shiftRowKeyedSet` (row-shift for the Set-based map, alongside `shiftRowKeyedEntries` for the
  link/style `Map`s) follow the same shape as the link/style equivalents. `persistSheet` now
  also calls `persistSheetExclusions`.

##### Avoiding the cold-load race

Unlike links/styles (cosmetic — safe to apply after the fact), exclusions must be known
*before* the first auto-derivation pass runs, or an excluded cell's hand-built formula gets
overwritten the instant the sheet is first displayed. `loadLevelDataExcl` wraps `loadLevelData`:
it awaits `ensureSheetExclusionsLoaded(revId, path)` and only then calls `loadLevelData(...,
cellExclusionMap.current.get(path))` — guaranteeing the exclusion set is populated before
`deriveLevelFormulas` ever touches that sheet. All six `loadLevelData` call sites (initial
load, drill down/up, jump-to-sheet, workbook-clear reset) go through this wrapper.

##### Guarding the three auto-derivation paths

`deriveLevelFormulas` takes an optional `excluded?: Set<string>` and checks
`isExcluded(r, c)` before pushing each `[row, col, value]` write to its batch — for both the
"qty" leaf-sheet pass (Factor auto-1 + `H = PRODUCT(...)`) and the standard three-pass
derivation (F = E×C, Factor auto-1 + H = F×G, J/L/N/P pull-through). The same guard pattern
is duplicated (by necessity — it's a different code path) in three more places:
- The `afterChange` hook's live auto-derivation (reads `cellExclusionMap.current.get(curSheetPath())`
  fresh on every batch of changes).
- `propagateLiveRollup` — the live breadcrumb preview; skips overwriting `liveRow[col]` for any
  excluded `(parentPath, rowInParent, col)` so the breadcrumb shows the hand-built value, not a
  rolled-up one.
- `drillUp`'s actual persisted rollup write into `parentData[rowInParent][col]` — the real
  data mutation that previously unconditionally overwrote F (L2→L1), C (Qty buildup→L2), or
  E/I/K/M/O/J/L/N/P (L3→L2).
- The row-move helper also shifts the exclusion set (`shiftRowKeyedSet`) so exclusions follow
  their cells when rows are moved, then re-derives with the shifted set.

##### UI — toggling exclusion

Right-click on the grid now offers **"Exclude from auto-calculation"** / **"Re-enable
auto-calculation"** (label flips based on whether every cell in the live selection — or the
right-clicked cell, if nothing is selected — is currently excluded). `toggleExclusionForSelection`
applies `setCellExcluded` to every selected cell, re-renders, and immediately calls
`deriveLevelFormulas` with the updated set so the effect (formulas appearing/disappearing in
F/G/H) is visible without navigating away and back. Excluded cells are marked with a faint
dashed amber top border (`EXCLUDED_BORDER_COLOUR`) drawn in `workbookCellRenderer` — a
discoverable visual cue, in the same spirit as the green link-font colour for dimension-group
imports and the blue drill-column font colour.

##### Excluding a drill column also switches off its drill-down

A drill column (L1 F:Subtotal, L2 E:Rate/C:Quantity — see `isDrillColumn`) that's been
excluded no longer drills down: `beforeOnCellMouseDown` checks `isCellExcluded` and bails out
before the double-click → `drillDownRef.current(row, col)` dispatch, since drilling into it
would create/seed a sub-sheet whose rollup the exclusion is specifically meant to suppress.
`workbookCellRenderer` reflects this by reverting the cell's font from drill-blue
(`DRILL_FONT_COLOUR`) to plain black — the same blue→black shift is the user-facing cue that
the cell no longer drills, alongside the dashed amber exclusion border.

**Verification needed (UI/UX — please check in `cargo tauri dev`):**
1. Select a range of cells in F/G/H (e.g. a summary block), right-click → **"Exclude from
   auto-calculation"** — confirm any existing auto-injected formulas in that range disappear
   and typing a hand-built formula into those cells survives navigation away/back, edits to
   C/E elsewhere on the sheet, and drill up/down.
2. Confirm the dashed amber border appears on excluded cells and disappears when you select
   the same range and choose **"Re-enable auto-calculation"** (and that auto-derivation resumes
   for those cells immediately).
3. Create a project from a template that has an excluded summary block — confirm the
   exclusions (and the block's hand-built content) carry over into the new project's L1 sheet.
4. Confirm exclusions persist across closing/reopening the project (i.e. they're actually in
   `workbook_sheet_exclusions`, not just the in-memory map), and that they're removed when the
   sheet/subtree is deleted or the workbook is cleared.

---

#### Sub-milestone 3.10 — Ribbon tools wired up ✅ (2026-06-09)

**Goal:** Make the previously-inert workbook ribbon buttons functional: Delete, Add Row,
Insert Above, Insert Below, Export, and Print. Remove the non-functional View group
(Expand All / Collapse All). Start the app maximized.

##### Features delivered

- **Delete revision** — `WorkbookRibbon` "Delete" triggers a `ConfirmDialog`; on confirm
  calls `deleteWorkbookRevision(activeRevisionId)`. Enabled only when a revision is active.
- **Add Row** — appends a blank row after the last occupied line-item row at the current
  sheet level. Scrolls to the new row.
- **Insert Above / Insert Below** — insert a blank row immediately above/below the
  currently-selected row, shifting all occupied rows below it down by one within the
  fixed 100-row grid. Implemented via the new `insertBlankRowAt` helper (see bugs below).
- **Export** — saves the active sheet as CSV; uses `@tauri-apps/plugin-dialog`'s `save`
  dialog with a `.csv` filter; writes via a new `write_text_file` Rust command (registered
  in `invoke_handler` in `lib.rs`).
- **Print** — generates an HTML table of all occupied rows in the current sheet,
  injects it into a hidden zero-size `<iframe>`, and calls `iframe.contentWindow.print()`.
  The iframe is removed from the DOM after 1 second. Note: `window.open()` is blocked in
  Tauri WebView2 — the hidden-iframe approach is the correct solution.
- **View group removed** — the "Expand All / Collapse All" group was permanently removed
  from `WorkbookRibbon` (no behaviour was wired; re-adding dummy buttons to the ribbon is
  against the ribbon layout rules in CLAUDE.md).
- **App starts maximized** — `"maximized": true` added to the window config in
  `desktop/tauri.conf.json`.

##### API bridge pattern (`WorkbookGridApi`)

All five imperative grid operations are exposed to the ribbon via the same stable-ref
delegate pattern used by `WorkbookFormatApi`:

1. A `gridApiImplRef` holds the current-render closure implementations.
2. A stable `gridApiRef` delegates each method to `gridApiImplRef.current.*`.
3. A mount effect calls `setWorkbookGridApi(gridApiRef.current)` once; the store holds `workbookGridApi: WorkbookGridApi | null`.
4. `WorkbookRibbon` reads `workbookGridApi` from the store and calls methods directly.

This avoids prop-drilling through `GridCore` (which is `React.memo`'d to prevent Handsontable
height resets) while keeping the closure fresh every render.

##### New backend commands

- `write_text_file(path: String, content: String)` — `std::fs::write` wrapper; used by
  the Export CSV path. Registered in `invoke_handler`.
- `rename_workbook_sheet_subtree(revision_id, old_path, new_path)` — bulk-renames all
  `workbook_sheet_data`, `workbook_sheet_links`, `workbook_sheet_styles`, and
  `workbook_sheet_exclusions` rows whose `sheet_path` equals `old_path` or starts with
  `old_path/`. Used by `insertBlankRowAt` to keep sub-sheet paths in sync when rows shift
  (see Bug 2 below).

##### Bugs encountered & fixes

**Bug 1 — Insert Above/Below wiped all values at Level 1 (data-loss)**

| | Detail |
|---|---|
| **Symptom** | After inserting a row at Level 1, all F:Subtotal and J/L/N/P-Total values in the sheet disappeared and the blank state was auto-saved (permanent data loss). Creating a new workbook from template also produced a blank sheet. |
| **Root cause** | The initial implementation reused `shiftStandardRowsDown`, which was written solely for the `insertLintelRowsBelow` path (always called at Level 2+). That helper copies only the *input* columns (A/B/C/D/E/G/I/K/M/O), blanks the "formula columns" (F/H/J/L/N/P), and then calls `deriveLevelFormulas` to regenerate them. At Level 2/3 this is correct — those columns hold row-relative formulas (`=E{r}*C{r}`, `=F{r}*G{r}`, `=I{r}*C{r}`, …) that must be rewritten with the new row index. At Level 1, however, F:Subtotal and J/L/N/P-Total are **plain rolled-up numbers** (the `SUM(H)` drill-ups from sub-sheets), not row-relative formulas. Blanking them and running `deriveLevelFormulas` regenerated nothing — there are no sub-sheets currently loaded to sum. The 500 ms debounced auto-save then persisted the blank state. |
| **Fix** | Wrote `insertBlankRowAt(hot, path, insertAt)`, a level-agnostic helper that: (1) copies **all** columns verbatim (not just input columns) using `hot.setDataAtCell` inside an `isAutoUpdatingRef` guard; (2) calls `deriveLevelFormulas` once after the copy to regenerate only the row-relative formula cells at the current level. At Level 1, `deriveLevelFormulas` writes nothing to F/J/L/N/P (those are not formula cells at that level), so rolled-up numbers survive the shift untouched. `insertBlankRowAt` is the canonical insert-row implementation for all levels; `shiftStandardRowsDown` remains for the lintel-insertion path only (Level 2+). |

**Bug 2 — Drilling into a Level 2 row after an insert showed a blank sub-sheet**

| | Detail |
|---|---|
| **Symptom** | After Bug 1 was fixed, inserting a row at Level 1 and then double-clicking into a previously-populated Level 2 row showed a blank sub-sheet — even though the breadcrumb toolbar still showed correct totals for that row. |
| **Root cause** | Sub-sheet paths are keyed by row index: `"L1/R0"`, `"L1/R1"`, etc. When a row is inserted above row `N`, all rows `N…last` shift to `N+1…last+1` in the grid data — but their associated sub-sheet paths (and all in-memory caches keyed by those paths) did not move with them. Drilling into the moved row `N+1` loaded from path `"L1/R<N+1>"` (empty), not `"L1/R<N>"` where the data still lived. The breadcrumb was correct because it was populated from the Level 1 cell value captured before drill-down, not from the sub-sheet path. |
| **Fix** | `insertBlankRowAt` now performs a bottom-up path remap for all rows from `lastOccupied` down to `insertAt`, renaming `${path}/${prefix}${r}` → `${path}/${prefix}${r+1}` for each applicable sub-prefix (`"R"` at Level 1; `"R"` and `"Q"` at Level 2). The remap covers six in-memory structures: `sheetDataMap`, `sheetComputedMap`, `cellLinkMap`, `cellStyleMap`, `cellExclusionMap`, and the three loaded-path Sets. It also calls `rename_workbook_sheet_subtree` via `invoke` for each renamed path to update SQLite. The remap must be done bottom-up (highest row index first) to prevent a rename at row `N+1` clobbering the path about to be renamed from row `N` in the next iteration. |

**Gate:** Both bug fixes confirmed working by the user in `cargo tauri dev`.

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
