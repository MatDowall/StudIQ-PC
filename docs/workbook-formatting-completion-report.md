# Workbook — Cell Formatting & Format Toolbar — Completion Report

Date: 2026-06-07
Feature: Workbook text/number formatting (Format ribbon group)
Status: Complete (session-scoped styles — see Known Limitations)

---

## Summary

Added standard spreadsheet text-formatting to the Workbook grid:

- **Global number display** — every numeric value column now renders to **2 decimal
  places with 1000's separation** (e.g. `1,234.56`), independent of the underlying
  formula/source value.
- **Drill-down column colour** — the column that triggers drill-down at the current level
  (**F:Subtotal** at Level 1, **E:Rate** at Level 2) is shown in **`#0400ff`**.
- **Format toolbar** — a new **Format** group in the workbook ribbon provides the standard
  text-formatting controls (font family, font size, Bold/Italic/Underline, Left/Centre/Right
  alignment, increase/decrease decimal places), applied to the highlighted cell(s).
- **Keyboard shortcuts** — `Ctrl+B` / `Ctrl+U` / `Ctrl+I` toggle bold/underline/italic on the
  current selection, matching the standard convention called out in the spec.

---

## Files Modified

- **`desktop/src-frontend/src/store/appStore.ts`**
  - Added `WorkbookFormatSnapshot` and `WorkbookFormatApi` types and
    `DEFAULT_WORKBOOK_FORMAT` constant.
  - Added `workbookFormat` (the active selection's effective format, read by the ribbon to
    populate the selects and toggle-button "pressed" state) and `workbookFormatApi` (an
    imperative bridge `WorkbookView` registers on mount so the ribbon can apply formatting
    to the grid's current selection — same pattern as `dgPaneCommand`/`openTemplateManager`
    elsewhere in the store) plus their setters.

- **`desktop/src-frontend/src/components/WorkbookView.tsx`**
  - `NUMERIC_COLS` — every column except A:Code, B:Description, D:Unit; these are displayed
    via `formatNumericDisplay()` (2dp + thousands separator, default; adjustable per cell).
  - `isDrillColumn(level, col)` — true for F:Subtotal at Level 1 / E:Rate at Level 2; drives
    the `#0400ff` font colour (`DRILL_FONT_COLOUR`).
  - `CellStyle` — per-cell style record (`bold`, `italic`, `underline`, `align`,
    `fontFamily`, `fontSize`, `decimals`), stored in `cellStyleMap` — a
    `Map<sheetPath, Map<"row,col", CellStyle>>` that mirrors the existing `sheetDataMap`
    keying so styles follow drill navigation within a session.
  - `workbookCellRenderer` — a custom Handsontable cell renderer (wraps the stock
    `textRenderer` from `handsontable/renderers`) that applies, in order: the numeric
    display format, the stored `CellStyle` (font/size/weight/style/decoration/alignment),
    and the drill-down font colour. Wired in via `cells()` for every column (replacing the
    old "Subtotal/Total → yellow className only" cells callback, which is preserved
    alongside it).
  - `getSelectedCells()` / `applyToSelection()` / `syncFormatSnapshot()` — selection→style
    plumbing: reads the live Handsontable selection range(s) (falling back to the
    last-known cell), mutates `cellStyleMap`, re-renders, and republishes
    `workbookFormat` to the store so the ribbon reflects the active cell's format.
  - `formatApiRef` — the stable `WorkbookFormatApi` implementation
    (`setFontFamily`/`setFontSize`/`toggleBold`/`toggleItalic`/`toggleUnderline`/
    `setAlign`/`adjustDecimals`), registered with the store via `setWorkbookFormatApi` in a
    mount effect.
  - `afterSelection` now also calls `syncFormatSnapshot()`.
  - New `beforeKeyDown` hook: `Ctrl+B` / `Ctrl+U` / `Ctrl+I` → toggle bold/underline/italic.

- **`desktop/src-frontend/src/components/WorkbookRibbon.tsx`**
  - Replaced the placeholder **Format** button with a `FormatToolbar` component: font-family
    select, font-size select, Bold/Italic/Underline toggle buttons (`format_bold` /
    `format_italic` / `format_underlined`), Left/Centre/Right alignment toggles
    (`format_align_left/center/right`), and increase/decrease decimal-place buttons.
  - Decimal buttons use the **`add`** / **`remove`** icons (with tooltips "Increase/Decrease
    decimal places") rather than `exposure_plus_1`/`exposure_minus_1` — those names render as
    literal fallback text (not glyphs) in the Material Symbols Outlined set loaded by this
    app, which produced a visible text-overflow glitch ("…MINUS…" bleeding into the adjacent
    Output group). `add`/`remove` are guaranteed-present standard glyphs.
  - All controls read/write through `useAppStore(s => s.workbookFormat)` /
    `useAppStore(s => s.workbookFormatApi)`; they are disabled (and toggle buttons show no
    "pressed" state) when no cell is selected.

---

## Known Limitations / Follow-ups

- **Styles are session-scoped, not persisted.** `cellStyleMap` lives only in a React ref —
  it is not written to `workbook_sheet_data.data_json` (which still serialises a plain
  `(string|null)[][]`) and is lost on reload / switching workbook revisions. Persisting it
  would mean either (a) changing the saved JSON shape to `{ data, styles }` — feasible
  without a backend change since `data_json` is an opaque TEXT blob, but it touches every
  one of the ~30 places that treat `sheetDataMap` entries as raw 2-D arrays — or (b) a new
  sibling table/column. Out of scope for this pass; flagged here for whoever picks up
  persistence.
- Number formatting and the drill-down colour are pure display concerns (computed in the
  renderer from existing data/level), so they need no persistence and have no such
  limitation.
