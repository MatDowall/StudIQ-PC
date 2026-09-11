# Workbook CostX re-architecture — handover

Handover for continuing the workbook re-architecture in a new chat. Read this, then the
memory file `workbook_costx_rearchitecture` (loaded automatically) for the blow-by-blow.
Full roadmap: `C:\Users\Admin\.claude\plans\i-want-to-build-modular-crescent.md` (M0–M9).

## What this is

Re-architecting StudIQ's in-app Workbook from **baked-literal rollups** (the old `drillUp`
wrote numbers into parent cells) to a **CostX-style declarative model** (parent cells hold live
formulas that read child sheets). It now behaves like CostX: recursive cost sheets, live
rollups, user-definable columns whose formulae live in the template, and clean CostX formula
syntax in the UI.

## Where we are

- **Branch:** `workbook-costx-engine` (off `main`). **Nothing pushed** — all local.
- **Working tree:** clean. **280 frontend tests pass**; `tsc`, `vite build`, `cargo check` clean.
- **Done & committed (M0 → M5 + template-owned formulae):**

| commit | what |
|---|---|
| `42a8d00` | M0 safety net + M1 multi-sheet engine core |
| `1b3a018` · `7f0c851` | M2 columns-as-data + rename UI |
| `4c02267` | M3 `XSUM*` function family |
| `80614be` | M4 upgrade transform + equivalence gate (unused now — see below) |
| `c81e67c` | Cutover step 1: multi-sheet engine + switchSheet nav |
| `16ac447` | Cutover step 2: declarative rollups + clean CostX syntax |
| `24c9d69` | M5: unlimited drill depth (recursive cost sheets) |
| `9deb578` | Template-owned user-column formulae (no more hardcoding) |

The estimating engine is **feature-complete against CostX's model** and the user has verified
each step in-app. The user's acceptance test is to re-enter their one real tender and chase the
same total.

## Architecture (as built)

- **One multi-sheet HyperFormula engine** drives the grid. The Handsontable formulas plugin owns
  the engine; we drive it multi-sheet via `plugin.addSheet` / `plugin.switchSheet`. Every sheet
  path is its own engine sheet; `pathToSheetName` (`lib/workbookSheetNames.ts`) maps
  `L1/S3/R2` ↔ a `/`-free HF name (`L1_sS3_sR2`). The whole revision is eager-loaded on open
  (`load_workbook_all_sheets`, Rust).
- **Drill model (M5), suffix by column:** F:Subtotal → `/S` (recursive COST sheet), E:Rate →
  `/R` (rate build-up leaf), C:Quantity → `/Q` (qty build-up leaf). `isCostSheetPath` = `L1` or
  `/S<n>`; `isDrillColumn` is path-based (F/E/C drill only on a cost sheet; leaves don't).
  `Level` is an unbounded number.
- **Rollups are declarative:** `drillDown` writes the drilled A–H cell as an `XSUM*` referencing
  the child (e.g. `=XSUMTOT(L1_sS3!H1:H1000)`); `drillUp` just navigates; nothing is baked. The
  `XSUM*` functions (`lib/workbookFunctions.ts`) are **range-based, non-volatile** — the explicit
  child range is the dependency edge, which is REQUIRED (a positional/edgeless function reads a
  child's own formula cells blank; proven, see memory "HARD HF FINDING").
- **Clean CostX syntax:** cells STORE the reference form; the formula bar + in-cell editor SHOW
  and ACCEPT the positional form (`=XSUMRATE(2)`, `=XSUMRATEUSER(1,2)`) via
  `lib/workbookXsumDisplay.ts` (`toDisplay`/`toStored`). `XSUM*` are in the autocomplete
  catalogue (tooltips).
- **Columns are data (M2) and now own their formulae:** `lib/workbookLayout.ts` — A–H fixed by
  role; user columns (I onward) carry `label`, `width`, and `rowFormula` (with `{r}` row
  placeholder). Persisted per revision as `workbook_revisions.layout_json` (NULL = shipped
  default). The default reproduces the LPMS split as formulae
  (`I==XSUMRATEUSER(1)`, `J==I{r}*C{r}`, …). Edited via Workbook menu → **Column Layout**.
- **Derivation is one generic engine:** `deriveLevelFormulas` (in `WorkbookView.tsx`) is the
  SINGLE source of truth for both display and edit paths. A–H (`F=E*C`, `G=1`, `H=F*G`, qty
  `PRODUCT`) are app-fixed; user columns apply their template `rowFormula` generically (cost
  sheets only), expanding positional `XSUM*` via `xsumToStored`, preserving typed literals,
  clearing lingering formulae when a column has no template formula. **The app hardcodes no
  user-column behaviour.**
- **Breadcrumb** is a scrollable trail of all ancestors, auto-scrolled to the bottom; each row's
  back arrow jumps to that level (`drillUpTo(index)`).

## Key files

- `desktop/src-frontend/src/components/WorkbookView.tsx` — the grid (huge, single component).
- `desktop/src-frontend/src/lib/`: `workbookSheetNames.ts`, `workbookEngine.ts` (headless engine
  wrapper + tests; the LIVE grid uses the plugin's engine, but the wrapper backs the upgrade
  module + tests), `workbookFunctions.ts`, `workbookXsumDisplay.ts`, `workbookLayout.ts`,
  `workbookCalc.ts` (pure arithmetic + the golden `workbook.test.ts`), `workbookUpgrade.ts`.
- `desktop/src/lib.rs` — `load_workbook_all_sheets`, `save_workbook_layout`,
  `save_workbook_engine_version`, workbook schema/commands.
- `desktop/src-frontend/src/components/ColumnLayoutDialog.tsx` — column name + formula editor.

## Working agreement (important)

- **No back-compat needed.** Only one real tender exists (exported to Excel); the user re-enters
  it. Workbooks built before a suffix/model change are inconsistent — always test M5+ with a
  FRESH workbook. Because of this, the M4 opt-in upgrade / `engine_version` dual-path is built but
  UNUSED — the declarative engine is the only path.
- **Small steps, test each in `cargo tauri dev` before the next.** UI correctness is only ever
  confirmed by the user's own in-app check — build/tsc/tests passing is necessary, not
  sufficient (see memory `feedback_dont_claim_ui_verified`). I cannot run the app (no GUI; the
  browser-pane preview can't exercise it either — `invoke` needs the Rust backend).
- **Commit after the user confirms a step works.** One commit per verified milestone.
- **Verify commands** (in `desktop/src-frontend`): `npx tsc --noEmit`, `npx vitest run`,
  `npx vite build`; Rust: `cargo check --package desktop` from repo root.
- **Env gotchas** (memory): SMB share — Vite HMR goes stale (restart before doubting a change);
  Tauri watcher can kill/relaunch the app; cargo target is off-share (`C:/cargo-target`).

## Remaining roadmap

- **M6 — templates v2:** multiple named templates, each owning its column set + depth; per-depth
  master seed sheets (currently the cost/rate/qty seeds are shared, `TEMPLATE_MASTER_L2/L3/LQ`).
  The "templates own formulae" half is already done (this session).
- **M7 — `XGET*`:** dimension-group functions (`XGETAREA`, `XGETLENGTH`, `XGETCOUNT`,
  `XGETVOLUME`, `XGETWALLAREA`, `XGETRATE`, `XGETCONSTANT`, `XGETNAMEDCELL`) reaching takeoff
  geometry. Reuse `lib/groupImport.ts` + `lib/quantity.ts` (never re-derive); converge with the
  existing `STUDIQ.*` Excel bridge (`lib/bridge.ts`). Synchronous-function constraint → needs a
  pre-warmed cache (pattern: the `framingSyncInFlight` coalescing guard). `XGETGFA`/`XGETWEIGHT`
  have no backing data — scope out. Reference-by-group-name needs new plumbing (names aren't
  unique); ship numeric-id first.
- **M8 — export/print:** full recursive Excel export (currently shallow; `exportExcel` walks only
  `L1` → `L1/S{row}` as a stopgap), layout-driven columns (user columns currently dropped),
  print alignment. Also fold in the two deferred hardcoded/edge spots:
  `maybeCloneRateBuildupSheet` still writes the old I/K/M/O pull-through (copy-paste of
  sub-sheets), and copy-paste sub-sheet cloning only clones `/R` (not `/S`).
- **`XSUMUSER` vs `XSUMRATEUSER`** are now genuinely distinct (read `/S` vs `/R`).

## M6 — Template model v2 (planned, in progress)

**Decisions taken (this session):** **no `max_depth`** — drill depth stays unlimited/emergent
from M5, templates own only their column layout + per-kind master seeds. The built-in
"Standard Trade Estimate" template is **seeded per project and fully editable** (no protection
flag).

**What's already true (not in scope):** templates *are* full workbook revisions in the hidden
"Templates" workbook, so each already has a `layout_json` column, and authoring a template's
column layout already works (ColumnLayoutDialog saves to the template's revision). The gap is
purely **propagation** — nothing copies that layout into workbooks made from the template. M5's
recursive role-based drill means only per-*kind* masters (cost/rate/qty) are needed, not per-level.

**Core defects M6 fixes:**
1. `create_workbook_revision_from_template` (lib.rs:3261) returns `layout_json: None` and never
   copies the template's `layout_json`/`engine_version` → a custom-column template produces a
   default-layout, v1 workbook.
2. `copy_workbook_revision` (lib.rs:3350) inserts only `(workbook_id, name, sort_order)` →
   copying a v2 custom-layout workbook silently downgrades it to v1/default.
3. `TemplateExportFile` (lib.rs:3704) carries no `layout_json` and no `links_json` → exported
   templates lose their column set and their cell links.
4. Master seeds are hardwired to the 3-level shape (`TEMPLATE_MASTER_L2/L3/LQ`); a deep `/S`
   cost sheet at level ≥4 seeds from the L2 master by luck, not by design.
5. Pre-existing bugs: `rename_workbook_sheet_subtree` doesn't rewrite
   `workbook_named_cells.sheet_path`; `clear_workbook_revision_data` leaves named cells dangling.

**Sequenced steps (each ends in a `cargo tauri dev` gate the user verifies):**

- **Step 1 — Rust: one shared copy helper + the two named-cell bug fixes.** No behaviour change
  intended. Extract `copy_revision_sheets(&mut tx, src_rev, dst_rev)` batch-copying
  `workbook_sheet_data`/`_styles`/`_exclusions`/`_links`/`workbook_named_cells` in ONE
  transaction; use it from `create_workbook_revision_from_template`, `copy_workbook_revision`,
  and the import side (collapses three drifted near-copies + closes the "import drops
  `links_json`" drift). Fix `rename_workbook_sheet_subtree` to rewrite named-cell `sheet_path`;
  fix `clear_workbook_revision_data` to clear named cells. Gate: create-from-template/copy/
  export→import reproduce faithfully; row-insert keeps a named cell pointed correctly.
- **Step 2 — carry `layout_json` + `engine_version` end to end.** Shared INSERT + helper copy
  both columns; DTOs return real values. Add `layout_json` + per-sheet `links` to
  `TemplateExportFile`, bump `TEMPLATE_EXPORT_VERSION` to 2 (read v1 as `layout_json: None`).
  Gate: custom-column template → workbook carries header + rowFormula; copy of a v2 workbook
  stays v2; export→import round-trips layout + links.
- **Step 3 — generalize master seeds to per-kind canonical paths + refit the template editor.**
  A template now has **four** master sheets: the literal `L1` top sheet (authored directly,
  copied verbatim into new workbooks — the estimator's L1 autonomy) plus three per-*kind* seeds
  `TEMPLATE_MASTER_COST` / `_RATE` / `_QTY`. `drillDown` picks the seed by kind (`/S`→COST at any
  depth, `/R`→RATE, `/Q`→QTY), falling back to legacy `_L2`/`_L3`/`_LQ` when the canonical path
  has no data (so templates authored today still seed correctly). **One shared Master Cost seeds
  every `/S` cost drill at any depth** — no per-level cost seeds (user decision; keeps unlimited
  depth). Relabel the template-edit banner buttons (WorkbookView.tsx:4569+) from
  L1/L2/L3/LQ to **Level 1 (top sheet) / Master Cost Build-up / Master Rate Build-up / Master
  Quantity Build-up**, and add a **"Column Layout…"** button to that banner (reuses
  `ColumnLayoutDialog`, editing the template revision's `layout_json`) so column setup is part of
  authoring a template. Keep the Workbook-menu Column Layout item for per-workbook overrides.
  Gate: distinct masters seed the right sheet at every depth/kind; editing a template's columns
  from the banner persists and flows into new workbooks (Step 2).
- **Step 4 — ship the built-in "Standard Trade Estimate" template, seeded per project
  (editable).** On DB init, if no template of that name exists, create the Templates workbook +
  a revision (layout_json NULL ⇒ shipped default; empty per-kind masters ⇒ today's experience) +
  the `templates` row. Fully editable/deletable like any user template (no protection flag).
  Gate: fresh project offers it in *New from Template* and it reproduces the current default shape.

**Standing rationale (user decisions this session):** master quantity/rate "standard formulas
per template" = per-kind master seed *content* (rows + formulas authored once) **plus** the
column layout's per-column `rowFormula`s — both persist on the template revision. The estimator
wanted distinct control over the top summary (`L1`) and the cost build-up shape (`Master Cost`);
that's the two-cost-template model above.

**Out of scope (deferred):** `max_depth`, per-level cost seeds
(`TEMPLATE_MASTER_COST_L2`), and recursive/layout-driven Excel export (stays M8).

## Immediate next step

Ask the user which of M6 / M7 / M8 to take next. M7 (`XGET*`) is the highest-value — it wires
measured quantities straight into the workbook.
