import React, { useRef, useState, useCallback, useMemo, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { HotTable } from "@handsontable/react-wrapper";
import type { HotTableRef } from "@handsontable/react-wrapper";
import { registerAllModules } from "handsontable/registry";
import { textRenderer } from "handsontable/renderers";
import "handsontable/styles/handsontable.css";
import "handsontable/styles/ht-theme-classic.css";
import type Handsontable from "handsontable";
import { HyperFormula } from "hyperformula";
import { useAppStore, DEFAULT_WORKBOOK_FORMAT } from "../store/appStore";
import type { WorkbookFormatApi, WorkbookGridApi, FlattenExportLevels } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { TemplateManagerDialog } from "./TemplateManagerDialog";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { TextInputDialog } from "./TextInputDialog";
import { NamedCellsManagerDialog, type NamedCellEntry } from "./NamedCellsManagerDialog";
import { ColumnLayoutDialog } from "./ColumnLayoutDialog";
import { ImportDimensionDialog, type ImportDisplayOption } from "./ImportDimensionDialog";
import { theme } from "../theme";
import { quantityValueText, type Quantity } from "../lib/quantity";
import type { ArrayGroupBreakdown, FramingGroupBreakdown } from "../lib/framing";
import {
  loadGroupImportContext,
  buildImportOptions,
  deriveLinkedQuantity,
  type GroupImportContext,
} from "../lib/groupImport";
import {
  COL_CODE, COL_DESC, COL_QTY, COL_UNIT, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL,
  COL_LAB, COL_LAB_TOTAL, COL_MAT, COL_MAT_TOTAL, COL_SUB, COL_SUB_TOTAL, COL_SUM, COL_SUM_TOTAL,
  COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT,
  qtyTotalFormula, toNum, numOrUndefined, textOrBlank, sumComputedCol,
  deriveFactorTotal, legacyColLetter, autoFormulaFor, isAutoOwnedCell, trimSheetForStorage,
} from "../lib/workbookCalc";
import { pathToSheetName, sheetNameToPath, retargetSheetRefs } from "../lib/workbookSheetNames";
import { wbInvoke, wbRead, wbWrite, flushWorkbookWrites, setWorkbookDbErrorHandler, setWorkbookFlushHook } from "../lib/workbookDb";
import { registerWorkbookFunctions } from "../lib/workbookFunctions";
import { toDisplay as xsumToDisplay, toStored as xsumToStored, rollupRangeRef, normalizeLegacyRollups } from "../lib/workbookXsumDisplay";
import {
  DEFAULT_WORKBOOK_LAYOUT, standardColumns, qtyColumns, parseLayout, serializeLayout,
  isDefaultLayout, FIRST_USER_COL, type WorkbookLayout,
} from "../lib/workbookLayout";

// Register the CostX XSUM* family globally before any engine (incl. the Handsontable formulas
// plugin's) is built — the registration is static, so it reaches every engine.
registerWorkbookFunctions();

registerAllModules();

// ─── Column definitions A–Z ───────────────────────────────────────────────
// Q–Z are plain freeform data columns (no fixed meaning, blank label — header
// shows just the letter). Beyond Z the sheet grows into double letters (AA,
// AB, …) exactly as rows grow past the bottom — see `growColsTo` / `colLetterForIndex`.

const EXTRA_COLUMN_WIDTH = 90;

// The column layouts are now sourced from the layout model (lib/workbookLayout.ts) rather than
// hardcoded literals, so the same shape drives both the grid and a future per-workbook custom
// layout. These two module-scope constants are the DEFAULT layout (byte-identical to the arrays
// StudIQ shipped with — pinned by workbookLayout.test.ts). Per-revision custom layouts are
// resolved from the active revision's layout_json inside the component; A–H stay fixed by role,
// only columns I onward vary. `role` rides along on each entry (ignored by existing consumers).
const COLUMNS = standardColumns(DEFAULT_WORKBOOK_LAYOUT);
const QTY_COLUMNS = qtyColumns(DEFAULT_WORKBOOK_LAYOUT);

// Number of columns is dynamic *per sheet* — every sheet starts with columns A–Z
// (26) and grows into double-letter columns (AA, AB, …) independently, as the user
// fills that particular sheet's rightmost columns (see `growColsTo` / hotSettings'
// afterChange) or as that sheet's own previously-grown data loads back in (see
// `padData`, which never truncates real saved data). Unlike `NUM_ROWS` below (a
// single bound shared by every sheet), column count is deliberately NOT a shared
// global — widening one sheet (e.g. a Level 1 trade summary) must never widen any
// other sheet or a different workbook revision. `BASE_NUM_COLS` is just the
// starting point for a brand-new sheet; each sheet's actual width is always derived
// from its own data array (see `loadLevelData`, `growColsTo`).
const BASE_NUM_COLS = COLUMNS.length;   // 26 (A–Z)
const COL_GROWTH_CHUNK     = 1;
const COL_GROWTH_THRESHOLD = 2;  // grow once an edit lands within this many columns of the right edge
// Row count is dynamic, not fixed — every sheet starts at 100 rows and grows in
// chunks as the user fills the bottom of the grid (see `growRowsTo` / hotSettings'
// afterChange) or as a previously-grown sheet loads back in (see `padData`, which
// never truncates real saved data). `NUM_ROWS` is the single shared bound every
// sheet's array is padded/iterated to — it only ever grows, never shrinks.
let NUM_ROWS = 100;

// Active column layout (M2), shared like NUM_ROWS across the single WorkbookView instance so the
// module-scope `loadLevelData` / `growColsTo` can read it without threading a param through every
// caller. Set from the active revision's `layout_json` whenever the revision changes (see the
// effect in the component). A–H are fixed; only the user columns (I onward) vary.
let activeLayout: WorkbookLayout = DEFAULT_WORKBOOK_LAYOUT;
/** Columns for a sheet kind under the active layout — replaces the module-const COLUMNS/QTY_COLUMNS
 *  in the display paths (headers/widths), so a renamed user column shows through. */
function layoutColumnsFor(kind: SheetKind) {
  return kind === "qty" ? qtyColumns(activeLayout) : standardColumns(activeLayout);
}

const ROW_GROWTH_CHUNK     = 50;
const ROW_GROWTH_THRESHOLD = 5;  // grow once an edit lands within this many rows of the bottom
// Column indices (COL_*), the pure rollup arithmetic, and the numeric-coercion helpers all
// live in lib/workbookCalc.ts so they can be unit-tested apart from this component — imported
// at the top of this file. Keep referencing them by the same names here.
// Reserved named-cell name: the single L1/H:Total cell a workbook author
// designates as the project grand total (its resolved value is cached on the
// revision via setWorkbookRevisionProjectTotal for the workbook sidebar).
const PROJECT_TOTAL_NAME = "PROJECT_TOTAL";
// Must match hotSettings.rowHeaderWidth so breadcrumb boxes align with grid columns.
const ROW_HDR_W = 50;

/** "AA"-style Excel column letter for a 0-based index beyond the predefined
 *  `COLUMNS`/`QTY_COLUMNS` arrays — used once the sheet has grown past Z. */
function colLetterForIndex(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Column letter for any column index — predefined letter for A–Z, computed
 *  double-letter (AA, AB, …) beyond that. Use this instead of `COLUMNS[col]?.letter`
 *  wherever `col` may point past the end of the predefined column arrays. */
function colLetter(col: number): string {
  return col < COLUMNS.length ? COLUMNS[col].letter : colLetterForIndex(col);
}

function columnHeaderLabel(c: { letter: string; label: string }): string {
  return c.label ? `${c.letter}:${c.label}` : c.letter;
}

/** Builds the full colHeaders array for `numCols` columns (that specific sheet's
 *  own width — never a shared global), extending past `base` with computed
 *  double-letter headers once the sheet has grown beyond Z. */
function buildColHeaders(base: readonly { letter: string; label: string }[], numCols: number): string[] {
  const headers = base.map(columnHeaderLabel);
  for (let i = base.length; i < numCols; i++) headers.push(colLetterForIndex(i));
  return headers;
}

/** Builds the full colWidths array for `numCols` columns (that specific sheet's
 *  own width), extending past `base` with `EXTRA_COLUMN_WIDTH` once the sheet has
 *  grown beyond Z. */
function buildColWidths(base: readonly { width: number }[], numCols: number): number[] {
  const widths = base.map(c => c.width);
  for (let i = base.length; i < numCols; i++) widths.push(EXTRA_COLUMN_WIDTH);
  return widths;
}


// Numeric value columns — everything except Code/Description/Unit, which hold
// text. These are displayed to a fixed number of decimal places with 1000's
// separation (default 2dp; adjustable per cell via the Format toolbar). Q–Z (and
// any further grown columns) are freeform — not included, so they stay plain text.
const BASE_NUMERIC_COL_COUNT = 16;  // A–P
const NUMERIC_COLS = new Set<number>(
  Array.from({ length: BASE_NUMERIC_COL_COUNT }, (_, i) => i)
    .filter(i => i !== COL_CODE && i !== COL_DESC && i !== COL_UNIT)
);

// Drill-down colour: F:Subtotal is the drill column at Level 1; E:Rate and C:Quantity
// are the drill columns at Level 2 (opening a Rate Build-up / Quantity Build-up sheet
// respectively). Level 3 sheets (Rate Build-up or Quantity Build-up) are leaves — no
// drill columns there.
const DRILL_FONT_COLOUR = "#0400ff";

// Faint dashed top border marking a cell that's excluded from auto-calculation
// (see cellExclusionMap) — a visual cue that its content is hand-built and won't
// be overwritten by the drill-down rollup, factor default, or total formula.
const EXCLUDED_BORDER_COLOUR = "#c08a00";
// A drill column is drillable only ON A COST SHEET (M5): F:Subtotal (→ recursive cost sheet),
// E:Rate (→ rate build-up leaf), C:Quantity (→ qty build-up leaf). Rate/qty leaves don't drill.
function isDrillColumn(path: string, col: number): boolean {
  return isCostSheetPath(path) && (col === COL_SUBTOTAL || col === COL_RATE || col === COL_QTY);
}

// Pale-yellow highlight applied to the "result" columns of a sheet — the figures
// the estimator reads off rather than types in. Which columns those are depends on
// both the sheet's depth and its kind:
//   L1 / L2 / L3 Rate Build-up  C:Quantity, F:Sub-Total, H:Total
//   L3 Quantity Build-up        H:Quantity only — C–F are Count/Length/Width/Height
//                               inputs there, so F carries no result to highlight.
const HIGHLIGHT_BG = "#fef9c6";
function isHighlightColumn(_level: Level, kind: SheetKind, col: number): boolean {
  if (kind === "qty") return col === COL_TOTAL;
  return col === COL_QTY || col === COL_SUBTOTAL || col === COL_TOTAL;
}

// ─── Per-cell text formatting (Format toolbar) ────────────────────────────

interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  fontFamily?: string;
  fontSize?: number;
  decimals?: number;
}

function styleKey(row: number, col: number) {
  return `${row},${col}`;
}

// ─── CostX-style dimension-group import links (drag-and-drop from Dimensions) ─

/** Marks a C:Quantity cell as a live import of a dimension group's derived quantity.
 *  `display` is the chosen derivation ("count" | "length" | "area" | "wall_area" | "volume")
 *  — for timber framing it is always "length" (matchingTotalM, lineal metres only). */
interface CellLink {
  groupId: number;
  display: string;
  /** Set only on a framing group's auto-inserted "<size> Lintel to last" line-item
   *  rows: the lintel's own framing size (e.g. "140x45"). Marks the cell as tracking
   *  that specific lintel size's live total rather than the group's matchingTotalM, so
   *  refreshLinkedCells keeps it in step with the group (see reconcileFramingLintels). */
  lintelSize?: string;
  /** The joist/rafter analogue of `lintelSize`: set only on the auto-inserted
   *  "<size> Blocking" row for blocking whose timber size differs from its group's, and
   *  tracks that blocking's live total rather than the group's own quantity
   *  (see reconcileArrayBlocking). */
  blockingSize?: string;
}

/** True for a link that tracks one differently-sized sub-quantity of its group (a framing lintel
 *  size, a joist/rafter blocking size) rather than the group's own headline quantity. */
function isSubQuantityLink(link: CellLink): boolean {
  return link.lintelSize != null || link.blockingSize != null;
}

// ─── Named cells (Excel-style "New Named Cell") ───────────────────────────────

/** A workbook-wide name bound to one cell (sheet path + row/col). Unique per
 *  revision — defined once, then usable in formulas at any level. Persisted
 *  alongside the revision and gone when it (or the workbook) is deleted. */
interface NamedCell {
  name: string;
  path: string;
  row: number;
  col: number;
}

/** Excel-style identifier rules: starts with a letter/underscore, then
 *  letters/digits/underscores/periods — and must not look like a cell reference
 *  (HyperFormula rejects those as named-expression names anyway). */
const NAMED_CELL_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const CELL_REF_PATTERN = /^[A-Za-z]{1,3}[0-9]+$/;

function isValidNamedCellName(name: string): boolean {
  return NAMED_CELL_PATTERN.test(name) && !CELL_REF_PATTERN.test(name);
}

/** "A1"-style label for a grid cell — used in the New Named Cell dialog prompt. */
function cellRefLabel(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/** Renders a cell value as a HyperFormula named-expression formula — numbers and
 *  text are embedded as literals (quoting text) so the name keeps working from
 *  any sheet, since HyperFormula reuses a single "Sheet1" across drill levels. */
function namedExprFromValue(value: unknown): string {
  if (value == null || value === "") return "=0";
  if (typeof value === "number") return Number.isFinite(value) ? `=${value}` : "=0";
  const text = String(value);
  const num = Number(text);
  if (text.trim() !== "" && !Number.isNaN(num)) return `=${num}`;
  return `="${text.replace(/"/g, '""')}"`;
}

const LINK_FONT_COLOUR = "#489c35";
const DIMENSION_DRAG_MIME = "application/x-studiq-dimension-group";
const RATE_ITEM_DRAG_MIME = "application/x-studiq-rate-item";

// Dimension-group import/derivation helpers (loadGroupImportContext,
// buildImportOptions, deriveLinkedQuantity, possibleImportDisplays,
// IMPORT_DISPLAY_LABELS) live in lib/groupImport.ts so the Excel bridge derives
// quantities through the same code path. Imported at the top of this file.

function formatNumericDisplay(raw: unknown, decimals: number): string | null {
  if (typeof raw === "string" && raw.trim().startsWith("=")) return null;
  const num = typeof raw === "number" ? raw : (raw != null && raw !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(num)) return null;
  return num.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ─── Formula function catalogue ────────────────────────────────────────────

interface FnInfo { syntax: string; desc: string }

const FORMULA_FUNCTIONS: Record<string, FnInfo> = {
  SUM:       { syntax: "SUM(number1, [number2], ...)",       desc: "Adds all numbers in a range" },
  PRODUCT:   { syntax: "PRODUCT(number1, [number2], ...)",   desc: "Multiplies all numbers in a range" },
  CEILING:   { syntax: "CEILING(number, significance)",      desc: "Rounds up to nearest multiple of significance" },
  FLOOR:     { syntax: "FLOOR(number, significance)",        desc: "Rounds down to nearest multiple of significance" },
  PI:        { syntax: "PI()",                               desc: "Returns π (3.14159…)" },
  ROUNDUP:   { syntax: "ROUNDUP(number, num_digits)",        desc: "Rounds a number up, away from zero" },
  ROUNDDOWN: { syntax: "ROUNDDOWN(number, num_digits)",      desc: "Rounds a number down, toward zero" },
  COS:       { syntax: "COS(number)",                        desc: "Returns the cosine of a number (in radians)" },
  COUNTIF:   { syntax: "COUNTIF(range, criteria)",           desc: "Counts cells that meet criteria" },
  AVERAGE:   { syntax: "AVERAGE(number1, [number2], ...)",   desc: "Returns the arithmetic mean" },
  COUNT:     { syntax: "COUNT(value1, [value2], ...)",       desc: "Counts the number of numeric values" },
  MIN:       { syntax: "MIN(number1, [number2], ...)",       desc: "Returns the minimum value" },
  MAX:       { syntax: "MAX(number1, [number2], ...)",       desc: "Returns the maximum value" },
  // CostX-style rollup functions (positional syntax — the child sheet is taken from the cell's
  // own position). [dp] is optional decimal places.
  XSUMTOT:      { syntax: "XSUMTOT([dp])",              desc: "Sum of the drilled Sub-Total sheet's Total (H) column" },
  XSUMTOTQTY:   { syntax: "XSUMTOTQTY([dp])",           desc: "Sum of the drilled Sub-Total sheet's Quantity (C) column" },
  XSUMUSER:     { syntax: "XSUMUSER(user_col, [dp])",   desc: "Sum of user column n of the drilled Sub-Total sheet" },
  XSUMRATE:     { syntax: "XSUMRATE([dp])",             desc: "Sum of the Rate build-up's Total (H) column" },
  XSUMRATEUSER: { syntax: "XSUMRATEUSER(user_col, [dp])", desc: "Sum of user column n of the Rate build-up" },
  XSUMQTY:      { syntax: "XSUMQTY([dp])",              desc: "Sum of the Quantity build-up's Quantity (H) column" },
  XSUMQTYUSER:  { syntax: "XSUMQTYUSER(user_col, [dp])",  desc: "Sum of user column n of the Quantity build-up" },
};

const FUNCTION_NAMES = Object.keys(FORMULA_FUNCTIONS);

// ─── Types ────────────────────────────────────────────────────────────────

// A sheet's drill depth — now unbounded (M5): 1 for "L1", 2 for "L1/S3", 3 for "L1/S3/R2", …
type Level = number;

// A sheet's "kind" determines its A–H column meaning and derivation/rollup formulas. "qty" sheets
// are Quantity Build-up sheets (/Q); everything else ("standard") uses the Code/Description/
// Quantity/Unit/Rate/Subtotal/Factor/Total layout — that covers both recursive COST sheets (/S)
// and RATE build-ups (/R). Derived purely from the sheet's path.
type SheetKind = "standard" | "qty";
function sheetKindForPath(path: string): SheetKind {
  return isQtyBuildupPath(path) ? "qty" : "standard";
}

// M5 drill model: a COST sheet (the top "L1" and every "/S<row>" descendant) is where you drill —
// F:Subtotal → a deeper cost sheet (/S, recursive), E:Rate → a rate build-up leaf (/R), C:Quantity
// → a qty build-up leaf (/Q). Rate and qty build-ups are LEAVES: nothing drills inside them.
function isCostSheetPath(path: string): boolean {
  return path === "L1" || /\/S\d+$/.test(path);
}

// Real Quantity Build-up sheet paths look like "L1/R3/Q5" — the "/Q<row>" suffix
// (vs. "/R<row>" for Rate Build-up / standard takeoff sheets) is what identifies a
// sheet's "kind" purely from its path, with no extra state needed alongside pathStack.
function isQtyBuildupPath(path: string): boolean {
  return /\/Q\d+$/.test(path);
}

/** Derives a sheet's drill level purely from its path depth — "L1" is level 1,
 *  "L1/R3" is level 2, "L1/R3/R2" or "L1/R3/Q5" is level 3. Used by the Named
 *  Cells manager's "Go to" action, which only has the bound cell's path to work from. */
function levelForPath(path: string): Level {
  return Math.max(1, path.split("/").length); // uncapped depth (M5)
}

interface BreadcrumbCtx {
  code:        string;
  description: string;
  quantity:    string;
  unit:        string;
  rate:        string;
  subtotal:    string;
  factor:      string;
  total:       string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function createEmptyData(cols: number = BASE_NUM_COLS): (string | null)[][] {
  return Array.from({ length: NUM_ROWS }, () => Array<string | null>(cols).fill(null));
}

/** Deep-clone a sheet's source data so each new sheet gets independent rows/cells. */
function cloneSheetData(data: (string | null)[][]): (string | null)[][] {
  return data.map((row) => [...row]);
}

function cloneStyleMap(map: Map<string, CellStyle> | undefined): Map<string, CellStyle> | undefined {
  if (!map || map.size === 0) return undefined;
  return new Map(Array.from(map.entries(), ([key, style]) => [key, { ...style }]));
}

/** Ensure loaded JSON has at least NUM_ROWS rows and `BASE_NUM_COLS` columns,
 *  padding with nulls as needed. Never truncates — a sheet saved with more rows
 *  than the current NUM_ROWS (grown in an earlier session, before this one's bound
 *  reset to its initial value) grows the shared row bound to fit instead of
 *  silently dropping its bottom rows. Column width, by contrast, is derived purely
 *  from `raw` itself (this specific sheet's own stored width) — never from a shared
 *  global — so one sheet's earlier growth never bleeds into another. */
function padData(raw: (string | null)[][]): (string | null)[][] {
  if (raw.length > NUM_ROWS) NUM_ROWS = raw.length;
  const cols = Math.max(BASE_NUM_COLS, raw.reduce((m, row) => Math.max(m, row?.length ?? 0), 0));
  const result = createEmptyData(cols);
  for (let r = 0; r < Math.min(raw.length, NUM_ROWS); r++) {
    const row = raw[r] ?? [];
    for (let c = 0; c < Math.min(row.length, cols); c++) {
      const v = row[c];
      // Legacy rollups stored a row-bounded child range (H1:H1000); upgrade to whole-column on load.
      result[r][c] = (v != null && v !== "") ? normalizeLegacyRollups(String(v)) : null;
    }
  }
  return result;
}

/** Pads `data` up to `rows` rows (appending blank rows, each matching `data`'s own
 *  current column width) without touching existing content — used to keep an
 *  already-cached sheet in sync when the shared `NUM_ROWS` grows elsewhere, so
 *  `0..NUM_ROWS` loops never index past a stale-sized cached array. */
function padRowsTo(data: (string | null)[][], rows: number): (string | null)[][] {
  if (data.length >= rows) return data;
  const cols = data[0]?.length ?? BASE_NUM_COLS;
  const grown = data.slice();
  while (grown.length < rows) grown.push(Array<string | null>(cols).fill(null));
  return grown;
}

/** Pads every row of `data` up to `cols` columns (appending blank cells) without
 *  touching existing content — the column-axis counterpart to `padRowsTo`, used by
 *  `growColsTo` to widen one specific sheet's cached data in place. */
function padColsTo(data: (string | null)[][], cols: number): (string | null)[][] {
  if ((data[0]?.length ?? 0) >= cols) return data;
  return data.map(row => {
    if (row.length >= cols) return row;
    const grown = row.slice();
    while (grown.length < cols) grown.push(null);
    return grown;
  });
}

/**
 * Convert stored data (null = empty) to a form safe for Handsontable + HyperFormula.
 * HyperFormula does NOT clear existing formula cells when a null is loaded — only an
 * explicit empty string tells it to clear the cell. This prevents stale formulas from
 * one level leaking into another when the same sheet is reused across drill levels.
 */
function dataForHot(data: (string | null)[][]): string[][] {
  return data.map(row => row.map(cell => cell ?? ""));
}

/** Canonical line-item description for a framing lintel of the given size. Shared by the
 *  drop (`populateFramingRollup`) and the live re-sync (`reconcileFramingLintels`) so a
 *  lintel row is always matched/backfilled by the exact text it was written with. */
function lintelRowDesc(size: string): string {
  return `${size} Lintel to last`;
}

/** Matches a lintel line-item description, capturing the framing size (group 1).
 *  Mirrors `lintelRowDesc` — keep the two in sync. */
const LINTEL_DESC_RE = /^(.+?) Lintel to last$/;

/** The current lineal-metre total for one lintel size within a framing breakdown, or
 *  `null` if that size is no longer present (its row's quantity should then go to 0). */
function liveLintelTotal(breakdown: FramingGroupBreakdown | null, size: string): number | null {
  if (!breakdown) return null;
  const c = breakdown.components.find(x => x.sizeOverride === size);
  return c ? c.totalM : null;
}

/** Canonical line-item description for a joist/rafter group's blocking of a timber size that
 *  differs from the group's own — the array analogue of `lintelRowDesc`. Shared by the drop
 *  (`populateArrayRollup`) and the live re-sync (`reconcileArrayBlocking`) so a blocking row is
 *  always matched/backfilled by the exact text it was written with. */
function blockingRowDesc(size: string): string {
  return `${size} Blocking`;
}

/** Matches a blocking line-item description, capturing the timber size (group 1).
 *  Mirrors `blockingRowDesc` — keep the two in sync. */
const BLOCKING_DESC_RE = /^(.+?) Blocking$/;

/** The current lineal-metre total for one blocking size within a joist/rafter breakdown, or `null`
 *  if the group no longer carries blocking of that size (its row's quantity should then go to 0).
 *  Only ever differing-size blocking gets a row — same-size blocking rolls into the group's own
 *  `matchingTotalM` (see CLAUDE.md), so it must never resolve here. */
function liveBlockingTotal(breakdown: ArrayGroupBreakdown | null, size: string): number | null {
  if (!breakdown || breakdown.blockingMatchesSize || breakdown.blockingSize !== size) return null;
  return breakdown.blockingTotalM;
}

/** Builds the Quantity Build-up sheet for a framing group's non-lintel component
 *  breakdown: one Description/Length row per component (Plates, Studs, Dwangs, …), with
 *  Factor=1 and the standard H=PRODUCT(...) total so the sheet is immediately valid
 *  (identical to what deriveLevelFormulas' qty pass would produce). Lintels are excluded
 *  — they are always separate line items (see CLAUDE.md framing-multi-size-model).
 *
 *  Shared by the initial drop (`populateFramingRollup`) and the live re-sync
 *  (`refreshLinkedCells`) so a framing row's breakdown always reflects the group's
 *  current geometry and never drifts from the linked C:Quantity cell. */
function buildFramingQtyData(breakdown: FramingGroupBreakdown): (string | null)[][] {
  const nonLintels = breakdown.components.filter(c => !c.sizeOverride);
  const qtyData = createEmptyData();
  nonLintels.forEach((c, i) => {
    if (i >= NUM_ROWS) return;
    qtyData[i][COL_DESC]   = c.label;
    qtyData[i][COL_LENGTH] = c.totalM.toFixed(3);
    qtyData[i][COL_FACTOR] = "1";
    qtyData[i][COL_TOTAL]  = qtyTotalFormula(i);
  });
  return qtyData;
}

/** True when two sheets carry the same non-empty content (ignoring trailing blank
 *  rows/cells) — used to skip a redundant persist when a re-derived framing breakdown
 *  is identical to what's already stored. */
function sameSheetContent(a: (string | null)[][], b: (string | null)[][]): boolean {
  const rows = Math.max(a.length, b.length);
  for (let r = 0; r < rows; r++) {
    const ra = a[r] ?? [];
    const rb = b[r] ?? [];
    const cols = Math.max(ra.length, rb.length);
    for (let c = 0; c < cols; c++) {
      if ((ra[c] ?? "") !== (rb[c] ?? "")) return false;
    }
  }
  return true;
}

/**
 * Cancel and close any in-progress cell edit, then deselect, before swapping a
 * Handsontable instance's data to a different sheet (drill up/down, jump to a master
 * sheet, etc.). Without this, a still-open editor's pending value (e.g. the cell the
 * user double-clicked to drill from, which selects-then-edits on the second click) is
 * left positioned over whatever screen coordinates it occupied — and on commit, writes
 * its stale value into whatever cell of the *newly loaded* sheet now sits there.
 */
function closeActiveEditor(hot: Handsontable): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editor = (hot as any).getActiveEditor?.();
  if (editor) {
    try { editor.cancelChanges(); } catch { /* no pending edit to cancel */ }
    try { editor.close(); } catch { /* already closed */ }
  }
  hot.deselectCell();
}

/**
 * Re-establish the F/G/H auto-derivations (F=E×C, G auto-populate=1, H=F×G) across
 * every row of the sheet currently loaded into `hot`.
 *
 * `hot.loadData()` does NOT fire `afterChange`, so the interactive-edit-driven
 * derivation in `hotSettings.afterChange` never runs when a sheet is freshly
 * displayed (initial load, drill up/down). Without this pass, a row whose factor
 * was already populated would show a stale H:Total until the user re-entered the
 * factor (which fires `afterChange` and triggers the rewrite). Running the same
 * two-pass logic here keeps formulas correct the moment a sheet becomes visible.
 *
 * Guarded by `guardRef` so the `setDataAtCell` writes below don't recurse back into
 * `afterChange`'s own derivation block.
 */
function deriveLevelFormulas(
  hot: Handsontable,
  level: Level,
  guardRef: React.MutableRefObject<boolean>,
  kind: SheetKind = "standard",
  path = "",
  excluded?: Set<string>,
  // Inclusive row band to (re)derive; defaults to the whole sheet. Every row's F/G/H is a pure
  // function of that row's OWN C/E (or C/D/E/F/G for a qty sheet) — no cross-row dependency — so
  // a caller that knows only certain rows changed (insertBlankRowAt/deleteRowAt's row-shift) can
  // narrow this instead of paying an O(NUM_ROWS) rescan on every insert/delete regardless of how
  // small the actual shift was.
  rowRange?: { from: number; to: number },
): void {
  if (guardRef.current) return;
  guardRef.current = true;
  try {
    const rFrom = rowRange?.from ?? 0;
    const rTo = rowRange?.to ?? NUM_ROWS - 1;
    const isExcluded = (r: number, c: number) => excluded != null && excluded.has(styleKey(r, c));
    // The app only writes its auto formula into a cell that is blank or still holds that auto
    // formula (isAutoOwnedCell). A typed lump sum, a hand-built formula or a drilled =XSUMTOT(...)
    // rollup belongs to the estimator and is left alone — and a cell already holding the right
    // formula isn't rewritten, so merely displaying a sheet doesn't dirty it.
    const src = (r: number, c: number): unknown =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (hot as any).getSourceDataAtCell(r, c);
    const deriveInto = (out: Array<[number, number, string]>, r: number, c: number) => {
      if (isExcluded(r, c)) return;
      const cur = src(r, c);
      const formula = autoFormulaFor(kind, c, r);
      if (formula == null || cur === formula || !isAutoOwnedCell(cur, kind, c)) return;
      out.push([r, c, formula]);
    };

    if (kind === "qty") {
      // Quantity Build-up sheets: H = C×D×E×F×G (Count×Length×Width×Height×Factor).
      // G auto-populates to 1 the first time a row has a computable product and Factor
      // is blank — same threshold pattern as the standard G/H derivation. I–P are left
      // untouched: nothing pulls through into a leaf sheet that doesn't drill further.
      const pass: Array<[number, number, string]> = [];
      for (let r = rFrom; r <= rTo; r++) {
        const vals = [COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT].map(c => hot.getDataAtCell(r, c));
        const hasInput = vals.some(v => v != null && v !== "");
        if (!hasInput) continue;

        if (!isExcluded(r, COL_FACTOR)) {
          const gSrc = src(r, COL_FACTOR);
          if (gSrc == null || String(gSrc) === "") {
            pass.push([r, COL_FACTOR, "1"]);
          }
        }
        deriveInto(pass, r, COL_TOTAL);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (pass.length) hot.setDataAtCell(pass as any);
      return;
    }

    // Pass 1: F = E×C for every row with a Quantity or Rate value — at ANY depth now (M5: every
    // cost sheet, including L1, computes its own subtotals) — unless F holds the estimator's own
    // content (a typed subtotal, or a drilled =XSUMTOT rollup from a child cost sheet).
    const pass1: Array<[number, number, string]> = [];
    for (let r = rFrom; r <= rTo; r++) {
      const cVal = hot.getDataAtCell(r, COL_QTY);
      const eVal = hot.getDataAtCell(r, COL_RATE);
      if ((cVal != null && cVal !== "") || (eVal != null && eVal !== "")) deriveInto(pass1, r, COL_SUBTOTAL);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (pass1.length) hot.setDataAtCell(pass1 as any);

    // Pass 2: for every row with an F value, auto-populate G=1 if blank and write H=F×G.
    const pass2: Array<[number, number, string]> = [];
    for (let r = rFrom; r <= rTo; r++) {
      const fRaw = hot.getDataAtCell(r, COL_SUBTOTAL);
      if (fRaw == null || fRaw === "") continue;
      const f = toNum(fRaw);

      if (!isExcluded(r, COL_FACTOR)) {
        const gSrc = src(r, COL_FACTOR);
        if (f > 0 && (gSrc == null || String(gSrc) === "")) {
          pass2.push([r, COL_FACTOR, "1"]);
        }
      }
      deriveInto(pass2, r, COL_TOTAL);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (pass2.length) hot.setDataAtCell(pass2 as any);

    // User columns (I onward) are never auto-filled by the app — a formula only ever gets
    // into a cell because a human typed it there, or it arrived via a row copy/paste that
    // carries the source row's own formulas along (see afterPaste's clone-on-paste, which
    // retargets an EXISTING formula's row reference rather than writing a new one). There
    // used to be a "pass 3" here that filled an empty user-column cell from a per-column
    // template whenever the row looked active — removed: it could not tell a genuinely
    // blank cell from one the estimator had just deliberately cleared, and resurrected
    // stale/orphaned child-sheet references on the "stacking" bug this pass 3 caused.
  } finally {
    guardRef.current = false;
  }
}

/**
 * Load level data into Handsontable, explicitly clearing HyperFormula's sheet first.
 *
 * hot.loadData() alone does not reliably clear formula cells when the incoming data
 * has null/empty values at those positions — HyperFormula can retain stale formulas.
 * Calling clearSheet() via the Formulas plugin before loadData() guarantees a clean
 * slate in HyperFormula before the new level's data is populated.
 *
 * After loading, runs `deriveLevelFormulas` so F/G/H are correct immediately —
 * `loadData` itself does not trigger the `afterChange`-driven derivation.
 *
 * Also swaps `colHeaders`/`colWidths` to match the target sheet's `kind` (derived from
 * `path` via `sheetKindForPath`) — Quantity Build-up sheets have a different A–H column
 * layout (Count/Length/Width/Height/Factor/Quantity) to standard takeoff/rate-build-up
 * sheets, so the grid's headers must follow whichever sheet is being displayed. Column
 * *count* is likewise derived from `data`'s own width (this sheet's own, possibly
 * grown-past-Z, width) — never a shared global — so a sheet that's been widened never
 * widens any other sheet or a different workbook revision.
 */
function loadLevelData(
  hot: Handsontable,
  data: (string | null)[][],
  level: Level,
  guardRef: React.MutableRefObject<boolean>,
  path: string,
  excluded?: Set<string>,
  reRegisterNamed?: () => void,
): void {
  const kind = sheetKindForPath(path);
  const base = layoutColumnsFor(kind);
  const cols = Math.max(BASE_NUM_COLS, data.reduce((m, row) => Math.max(m, row?.length ?? 0), 0));
  hot.updateSettings({
    colHeaders: buildColHeaders(base, cols),
    colWidths:  buildColWidths(base, cols),
  });
  // Multi-sheet engine: every sheet path is its own HyperFormula sheet (name = pathToSheetName),
  // so navigating is switchSheet — not clear+reload of a single reused sheet. Ensure the target
  // sheet exists in the engine with the given source content, then switch the grid to it (which
  // repaints from the engine). Named expressions are re-registered first so cross-sheet references
  // resolve on the first evaluation. Falls back to plain loadData if the plugin/engine is absent.
  reRegisterNamed?.();
  const plugin = getFormulasPlugin(hot);
  const engine = plugin?.engine;
  if (plugin && engine) {
    const name = pathToSheetName(path);
    const rows = dataForHot(data);
    if (engine.doesSheetExist(name)) {
      engine.setSheetContent(engine.getSheetId(name), rows);
    } else {
      plugin.addSheet(name, rows);
    }
    plugin.switchSheet(name);
  } else {
    hot.loadData(dataForHot(data));
  }
  deriveLevelFormulas(hot, level, guardRef, kind, path, excluded);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The Handsontable Formulas plugin, typed loosely (its addSheet/switchSheet/engine members
 *  aren't in the exported types we use). */
function getFormulasPlugin(hot: Handsontable | null | undefined): any {
  let plugin: any = null;
  try { plugin = hot ? (hot.getPlugin("formulas") as any) : null; } catch { return null; }
  if (plugin?.engine) detachSheetChurnRebuild(plugin.engine);
  return plugin;
}

const churnDetached = new WeakSet<object>();
/** Handsontable registers a FULL `rebuildAndRecalculate()` on every engine sheetAdded/sheetRemoved
 *  ("hooks needed for cross-referencing sheets") — a workaround for older HyperFormula. HF 3.x
 *  resolves a reference to a sheet by itself the moment that sheet is added, removed or re-added
 *  (verified), so those rebuilds are pure cost: loading a revision paid one full rebuild per sheet,
 *  and every drill into a new row or sub-sheet move paid another. Removed once per engine. The only
 *  other listeners on those events are the plugin's afterSheetAdded/Removed hook relays, which
 *  nothing here uses. */
function detachSheetChurnRebuild(engine: { off: (e: string) => void }): void {
  if (churnDetached.has(engine)) return;
  churnDetached.add(engine);
  try { engine.off("sheetAdded"); engine.off("sheetRemoved"); } catch { /* older API */ }
}

/** Ensure the engine has a sheet for `path` (empty if new). Lets a parent's positional XSUM*
 *  read real child data the instant it is written. */
function ensureEngineSheet(hot: Handsontable, path: string): void {
  const plugin = getFormulasPlugin(hot);
  const engine = plugin?.engine;
  if (!plugin || !engine) return;
  const name = pathToSheetName(path);
  try { if (!engine.doesSheetExist(name)) plugin.addSheet(name, dataForHot(createEmptyData())); } catch { /* ignore */ }
}

/**
 * Finds every entry in `names` that lives under `${ownerPath}/{prefix}{row}` for one of
 * `prefixes`, with `row` in `[loRow, hiRow]`, and returns its rename pair shifting that row by
 * `rowDelta` (a nested descendant, e.g. "L1/S3/R5", moves as a unit — only the outer row shifts).
 *
 * This is called ONCE per insert/delete over the full set of names/keys, rather than once per
 * shifted row — insertBlankRowAt/deleteRowAt used to call a per-subtree mover inside a loop over
 * every row being displaced, and that mover (plus the cache remaps alongside it) each did a full
 * scan of the whole engine/map to find the one row's descendants. Shifting N rows below the edit
 * point on a workbook with M live sheets/cache entries cost O(N × M) instead of O(M) — on a large
 * cost sheet, inserting/deleting near the top (N close to the row count) got dramatically slower
 * as the workbook grew, which read as "exponential" even though it's really quadratic in N.
 */
interface SubtreeRename {
  oldPath: string;
  newPath: string;
  row: number;
  /** The moved row's own sub-sheet before/after the move ("L1/S3" → "L1/S4") — `oldPath` is
   *  either this or one of its descendants. */
  rootOld: string;
  rootNew: string;
}

function planSubtreeRenames(
  names: Iterable<string>, ownerPath: string, prefixes: string[],
  loRow: number, hiRow: number, rowDelta: number,
): SubtreeRename[] {
  const renames: SubtreeRename[] = [];
  const base = `${ownerPath}/`;
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const tail = name.slice(base.length);
    for (const prefix of prefixes) {
      if (!tail.startsWith(prefix)) continue;
      const m = /^(\d+)((?:\/.*)?)$/.exec(tail.slice(prefix.length));
      if (!m) continue;
      const row = Number(m[1]);
      if (row < loRow || row > hiRow) continue;
      const rootOld = `${ownerPath}/${prefix}${row}`;
      const rootNew = `${ownerPath}/${prefix}${row + rowDelta}`;
      renames.push({ oldPath: name, newPath: `${rootNew}${m[2]}`, row, rootOld, rootNew });
      break;
    }
  }
  return renames;
}

/** A moved sheet's cells can reference its OWN drilled children by name; re-point them at the
 *  children's new names (which moved with it). */
function retargetSheetData(data: (string | null)[][], rename: SubtreeRename): (string | null)[][] {
  return data.map(row => row.map(cell => retargetSheetRefs(cell, rename.rootOld, rename.rootNew)));
}

/** Applies a rename plan to a path-keyed cache map. Reads every old value before deleting any
 *  old key, so — unlike the live engine below — this needs no particular row order: a
 *  destination that is itself a source elsewhere in the plan is never clobbered mid-pass.
 *  `transform`, if given, rewrites each moved value (used to retarget cached sheet data). */
function applySubtreeRenamesToMap<V>(
  map: Map<string, V> | undefined, renames: SubtreeRename[],
  transform?: (value: V, rename: SubtreeRename) => V,
): void {
  if (!map || map.size === 0 || renames.length === 0) return;
  const moves: Array<[string, V]> = [];
  for (const r of renames) {
    const v = map.get(r.oldPath);
    if (v !== undefined) moves.push([r.newPath, transform ? transform(v, r) : v]);
  }
  for (const { oldPath } of renames) map.delete(oldPath);
  for (const [newPath, v] of moves) map.set(newPath, v);
}

/**
 * A named cell bound directly to a sub-sheet that a subtree rename just relocated (e.g. a name
 * defined inside a Rate Build-up sheet, not the parent row that owns it) keeps its own row/col
 * but must follow its sheet to the new path — otherwise its live HyperFormula expression keeps
 * pointing at the sheet name that was just renamed away, breaking it for the rest of the session.
 * The DB side of this is already handled by `rename_workbook_sheet_subtree` (it rewrites
 * `workbook_named_cells.sheet_path` in the same transaction as the sheet-data tables), so this
 * only needs to fix the in-memory map and re-register the live expression — no extra persist.
 */
function applySubtreeRenamesToNamedCells(
  namedCellMap: Map<string, NamedCell>,
  renames: Array<{ oldPath: string; newPath: string }>,
  reregister: (nc: NamedCell) => void,
): void {
  if (namedCellMap.size === 0 || renames.length === 0) return;
  const byOldPath = new Map(renames.map(r => [r.oldPath, r.newPath]));
  for (const nc of namedCellMap.values()) {
    const newPath = byOldPath.get(nc.path);
    if (newPath == null) continue;
    nc.path = newPath;
    reregister(nc);
  }
}

/** Same as `applySubtreeRenamesToMap`, for the membership-only Set caches. */
function applySubtreeRenamesToSet(
  set: Set<string> | undefined, renames: Array<{ oldPath: string; newPath: string }>,
): void {
  if (!set || set.size === 0 || renames.length === 0) return;
  const adds: string[] = [];
  for (const { oldPath, newPath } of renames) if (set.has(oldPath)) adds.push(newPath);
  for (const { oldPath } of renames) set.delete(oldPath);
  for (const p of adds) set.add(p);
}

/**
 * Applies a rename plan to the live HyperFormula engine's sheets. Unlike the cache maps above,
 * this mutates one shared engine sequentially, so a destination row that is ALSO a source
 * elsewhere in the plan must not be overwritten before it's been read — callers must order
 * `renames` by `row` descending for a down-shift (insert) and ascending for an up-shift
 * (delete), i.e. always move into an already-vacated slot first.
 *
 * Moves by COPYING content to the target name and removing the source, rather than
 * `HyperFormula.renameSheet`: other cells' formulas are bound to a sheet by id at parse time, and
 * renaming in place showed up as spurious #CYCLE! errors and cross-row corruption in testing. The
 * copied content has references to the moved row's own descendants retargeted (retargetSheetRefs),
 * so a cost sheet that drills further keeps reading its own children after the move.
 */
function applySubtreeRenamesToEngine(hot: Handsontable, renames: SubtreeRename[]): void {
  const plugin = getFormulasPlugin(hot);
  const engine = plugin?.engine;
  if (!plugin || !engine || renames.length === 0) return;
  for (const rename of renames) {
    const { oldPath, newPath } = rename;
    try {
      const oldName = pathToSheetName(oldPath);
      if (!engine.doesSheetExist(oldName)) continue;
      const oldId = engine.getSheetId(oldName);
      if (oldId == null) continue;
      // Re-point the moved sheet's own references to its (also moving) children.
      const content = (engine.getSheetSerialized(oldId) as unknown[][]).map(row =>
        row.map(cell => (typeof cell === "string" ? retargetSheetRefs(cell, rename.rootOld, rename.rootNew) : cell)));
      const newName = pathToSheetName(newPath);
      if (engine.doesSheetExist(newName)) engine.setSheetContent(engine.getSheetId(newName), content);
      else plugin.addSheet(newName, content);
      engine.removeSheet(oldId);
    } catch { /* non-fatal — the cache/DB rename above still keeps it consistent on reload */ }
  }
}

/**
 * A bare cell reference, or a whole XSUM* call matched as one token so `shiftFormulaRowRefs` can
 * skip it (that family is retargeted by cell position via beforeChange's toStored round-trip)
 * while still shifting any bare reference elsewhere in the same formula.
 */
const CELL_REF_OR_XSUM_CALL_RE = /XSUM[A-Z]+\s*\([^()]*\)|(?<![!\w])([A-Za-z]{1,2})(\d+)\b/gi;

/**
 * Shifts EVERY bare cell reference in a formula by `rowDelta` rows — the ordinary Excel/CostX
 * relative-reference behaviour on a plain cell copy/paste: `=M1*C1` copied from row 1 and pasted
 * onto row 3 becomes `=M3*C3`, whether or not the reference happens to match the row it was
 * copied FROM. (Row insert/delete doesn't use this — it is a native grid operation, so
 * HyperFormula adjusts references itself.) Any XSUM* call, whole-cell or nested inside a wrapper
 * (e.g. `=IF(H5>0,XSUMRATEUSER(2),0)`), is skipped as one token via `CELL_REF_OR_XSUM_CALL_RE` —
 * that family is retargeted separately, by cell position, via beforeChange's toStored round-trip —
 * while a bare reference elsewhere in the same formula (that IF's `H5`) still gets shifted here.
 */
function shiftFormulaRowRefs(formula: string, rowDelta: number): string {
  if (typeof formula !== "string" || formula.charAt(0) !== "=" || rowDelta === 0) return formula;
  return formula.replace(CELL_REF_OR_XSUM_CALL_RE, (m: string, col?: string, num?: string) => {
    if (col == null) return m; // matched a whole XSUM* call — leave untouched
    return `${col}${Number(num) + rowDelta}`;
  });
}

/** Force a full engine recompute. The XSUM* rollups reference their child as an explicit range, so
 *  HyperFormula's dependency graph settles a multi-level chain in one pass — no iteration needed. */
function recomputeEngine(hot: Handsontable | null | undefined): void {
  const engine = getFormulasPlugin(hot)?.engine;
  try { engine?.rebuildAndRecalculate?.(); } catch { /* older API — a re-render still repaints */ }
}

/** Runs `fn` with the footer's Excel-style status line ("Ready" when idle) showing `label` —
 *  for a grid operation that does real synchronous work behind a single click (row/column
 *  insert/delete, paste's clone-on-paste + reference-shift pass) and can visibly freeze the UI
 *  for a moment on a large sheet. Yields one animation frame before running `fn` so React
 *  actually paints the label first — otherwise the label and the freeze it describes would
 *  commit to the DOM in the same synchronous stretch and the browser would never get to show it
 *  (the same trick `resetEngineSheets` uses for its load-progress bar). Clears the status in a
 *  `finally` so a thrown error or early return never leaves the footer stuck mid-sentence. */
async function withWorkbookActivity<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  useAppStore.getState().setWorkbookActivity(label);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  try {
    return await fn();
  } finally {
    useAppStore.getState().setWorkbookActivity("");
  }
}

/** Replace the plugin engine's sheets with exactly `sheets` (the whole revision), so cross-sheet
 *  rollup formulas and named-cell references resolve. Adds/replaces every wanted sheet, binds the
 *  grid to L1, then drops any sheet left over from a previous revision. Idempotent.
 *
 *  Yields back to the browser every `PROGRESS_CHUNK` sheets (a plain `setTimeout(0)`, not a
 *  microtask) so the loading overlay's progress bar can actually repaint mid-loop instead of
 *  freezing at 0% for the whole load of a large revision — this is what makes a determinate
 *  progress bar meaningfully different from the spinner it replaces. `shouldAbort` is checked after
 *  every yield: a newer revision switch can now start while this one is mid-loop (impossible when
 *  the loop ran fully synchronously), so without this check a superseded switch would keep mutating
 *  the shared engine underneath the switch that replaced it — exactly the stale-switch corruption
 *  fixed elsewhere in this file.
 *
 *  No rebuild is needed after the loop: HyperFormula resolves a reference to a sheet as soon as that
 *  sheet is added (see detachSheetChurnRebuild). */
const PROGRESS_CHUNK = 3;
async function resetEngineSheets(
  hot: Handsontable,
  sheets: Array<{ path: string; data: (string | null)[][] }>,
  onProgress?: (done: number, total: number) => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  const plugin = getFormulasPlugin(hot);
  const engine = plugin?.engine;
  if (!plugin || !engine) return;
  const l1Name = pathToSheetName("L1");
  const wanted = new Map<string, (string | null)[][]>();
  for (const s of sheets) wanted.set(pathToSheetName(s.path), s.data);
  if (!wanted.has(l1Name)) wanted.set(l1Name, createEmptyData());
  const entries = [...wanted];
  const total = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const [name, data] = entries[i];
    const rows = dataForHot(data);
    if (engine.doesSheetExist(name)) engine.setSheetContent(engine.getSheetId(name), rows);
    else plugin.addSheet(name, rows);
    if ((i + 1) % PROGRESS_CHUNK === 0 || i === entries.length - 1) {
      onProgress?.(i + 1, total);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (shouldAbort?.()) return;
    }
  }
  plugin.switchSheet(l1Name); // bind to a kept sheet before removing any stale ones
  for (const name of engine.getSheetNames() as string[]) {
    if (!wanted.has(name)) {
      try { engine.removeSheet(engine.getSheetId(name)); } catch { /* ignore */ }
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Build breadcrumb display context from a row of *evaluated* data (e.g. a computed
 * snapshot array). Using evaluated values — rather than source/formula strings —
 * ensures formula cells (e.g. F holding `=E5*C5`) display their computed numeric
 * result, not the formula text, so BreadcrumbRow can render Subtotal/Total as plain
 * formatted numbers.
 */
function readRowCtx(rowIndex: number, data: unknown[][]): BreadcrumbCtx {
  const r = (data[rowIndex] ?? []) as unknown[];
  const v = (i: number): string => (r[i] != null && r[i] !== "" ? String(r[i]) : "");
  return { code: v(0), description: v(1), quantity: v(2), unit: v(3), rate: v(4), subtotal: v(5), factor: v(6), total: v(7) };
}

/**
 * Same as `readRowCtx`, but reads directly from the live grid via `hot.getDataAtCell`
 * — the same accessor used elsewhere for evaluated formula results (see readCellValue
 * / selection stats) — instead of a bulk `hot.getData()` snapshot. `getData()` was
 * found to hand back the raw formula string instead of its computed value for cells
 * whose formula references a named expression bound elsewhere (e.g.
 * `=1+margin_pct/100`), even though the cell renders correctly on screen and
 * `getDataAtCell` resolves it fine.
 */
function readRowCtxFromGrid(hot: Handsontable, rowIndex: number): BreadcrumbCtx {
  const plugin = getFormulasPlugin(hot);
  const engine = plugin?.engine;
  const sheetId: number | null = plugin?.sheetId ?? null;
  const v = (col: number): string => {
    let val = hot.getDataAtCell(rowIndex, col);
    // A cell whose rollup formula was just written can hand back its raw source here (not yet
    // re-cached) — read the engine's evaluated value instead so the breadcrumb shows the number,
    // not "…!H:H)". Last resort: display the clean positional form rather than the raw ref.
    if (typeof val === "string" && val.charAt(0) === "=") {
      if (engine && sheetId != null) {
        try { const e = engine.getCellValue({ sheet: sheetId, row: rowIndex, col }); if (e != null && typeof e !== "object") val = e; } catch { /* fall through */ }
      }
      if (typeof val === "string" && val.charAt(0) === "=") val = xsumToDisplay(val);
    }
    return val != null && val !== "" ? String(val) : "";
  };
  return { code: v(0), description: v(1), quantity: v(2), unit: v(3), rate: v(4), subtotal: v(5), factor: v(6), total: v(7) };
}

/**
 * Snapshot the whole displayed sheet as *evaluated* values, cell by cell via
 * `hot.getDataAtCell` — see `readRowCtxFromGrid` for why bulk `hot.getData()` can't
 * be trusted here: it hands back raw formula text (not the computed value) for
 * cells whose formula references a named expression bound elsewhere. Used anywhere
 * an evaluated snapshot of the current sheet is cached/exported (drillDown/drillUp's
 * `sheetComputedMap`, print), so downstream rollups and displays never see a formula
 * string where a number is expected.
 */
function getEvaluatedGridData(hot: Handsontable): unknown[][] {
  const rows = hot.countRows();
  const cols = hot.countCols();
  const out: unknown[][] = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row: unknown[] = new Array(cols);
    for (let c = 0; c < cols; c++) row[c] = hot.getDataAtCell(r, c);
    out[r] = row;
  }
  return out;
}

/** Read `col` of `row` from an evaluated snapshot, falling back to `rawFallback`
 *  (e.g. a cloned live row's own raw value) if the snapshot has nothing for that
 *  cell yet — see propagateLiveRollup's Factor handling. */
function evaluatedOrRaw(computed: unknown[][], row: number, col: number, rawFallback: string | null): string | null {
  const val = computed[row]?.[col];
  return val != null && val !== "" ? String(val) : rawFallback;
}

/**
 * Reads the system clipboard via the Tauri clipboard-manager plugin, retrying
 * a few times on failure or an empty result. The read crosses a process
 * boundary (WebView2's own Cut/Copy write happens in the renderer process;
 * this read happens in the Rust host process via `arboard`/Win32 clipboard
 * APIs) — right after a Copy, the OS clipboard can transiently report empty
 * or throw "access denied" until that write has fully propagated. A short
 * retry loop absorbs that instead of the caller silently getting nothing.
 */
async function readClipboardWithRetry(attempts = 6, delayMs = 40): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      const text = await readClipboardText();
      if (text) return text;
    } catch {
      // transient cross-process clipboard lock — retry below
    }
    if (i < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return "";
}

/**
 * Copies the SOURCE (formula) text of the current selection to the system clipboard
 * as a TSV block — the counterpart to Handsontable's default value-copy. For a formula
 * cell `getSourceDataAtCell` returns its "=…" string; for a plain cell it returns the
 * stored value, so mixed selections copy sensibly. Spans every selected range's
 * bounding box, blanking cells outside the actual ranges (matching how Handsontable
 * lays out a multi-range copy). Written via the Tauri clipboard plugin so it crosses
 * the WebView2 → host boundary and pastes cleanly into Excel and back into the grid.
 */
/** Union bounding box of every range in the current selection, or null if nothing is
 *  selected — shared by copySelectionFormulas (what gets written to the clipboard) and
 *  the "Copy Formula" menu action (what gets recorded as the clone-on-paste source, so
 *  a subsequent paste's drill-column clone/reference-shift has the right row/col to
 *  measure from — see lastRateCopyRef). */
function selectionBoundingBox(hot: Handsontable): { fromRow: number; toRow: number; fromCol: number; toCol: number } | null {
  const ranges = hot.getSelectedRange();
  if (!ranges || ranges.length === 0) return null;
  let fromRow = Infinity, toRow = -Infinity, fromCol = Infinity, toCol = -Infinity;
  for (const r of ranges) {
    fromRow = Math.min(fromRow, r.from.row, r.to.row);
    toRow   = Math.max(toRow,   r.from.row, r.to.row);
    fromCol = Math.min(fromCol, r.from.col, r.to.col);
    toCol   = Math.max(toCol,   r.from.col, r.to.col);
  }
  return { fromRow, toRow, fromCol, toCol };
}

async function copySelectionFormulas(hot: Handsontable): Promise<void> {
  const ranges = hot.getSelectedRange();
  if (!ranges || ranges.length === 0) return;
  const box = selectionBoundingBox(hot);
  if (!box) return;
  const { fromRow, toRow, fromCol, toCol } = box;
  const inRange = (row: number, col: number) => ranges.some(r => {
    const rt = Math.min(r.from.row, r.to.row), rb = Math.max(r.from.row, r.to.row);
    const cl = Math.min(r.from.col, r.to.col), cr = Math.max(r.from.col, r.to.col);
    return row >= rt && row <= rb && col >= cl && col <= cr;
  });
  const lines: string[] = [];
  for (let row = fromRow; row <= toRow; row++) {
    const cells: string[] = [];
    for (let col = fromCol; col <= toCol; col++) {
      const raw = inRange(row, col) ? (hot as unknown as {
        getSourceDataAtCell: (r: number, c: number) => unknown;
      }).getSourceDataAtCell(row, col) : null;
      cells.push(raw == null ? "" : String(raw));
    }
    lines.push(cells.join("\t"));
  }
  try {
    await writeClipboardText(lines.join("\n"));
  } catch {
    // Fall back to the WebView renderer clipboard if the host write is unavailable.
    try { await navigator.clipboard.writeText(lines.join("\n")); } catch { /* give up quietly */ }
  }
}

/**
 * Stops Handsontable's own shortcut handling (cell navigation, Tab-to-next-cell,
 * etc.) for this keydown from within a `beforeKeyDown` hook callback.
 *
 * The real DOM `event.stopImmediatePropagation()` does NOT do this — Handsontable's
 * shortcut manager doesn't check native propagation state at all; it checks its own
 * bespoke `event.isImmediatePropagationEnabled` property (see
 * `handsontable/helpers/dom/event.js`'s own `stopImmediatePropagation`/
 * `isImmediatePropagationStopped` pair, and `shortcuts/recorder.js`'s `onkeydown`,
 * which reads that same property right after invoking `beforeKeyDown`). Calling
 * only the native method leaves that property untouched, so Handsontable proceeds
 * to run its own arrow-key/Tab/Enter cell-navigation shortcut regardless.
 */
function stopHotShortcut(event: KeyboardEvent): void {
  (event as unknown as { isImmediatePropagationEnabled?: boolean }).isImmediatePropagationEnabled = false;
  event.stopImmediatePropagation();
}

/** Get the trailing alphabetic token the user is currently typing (for autocomplete). */
function currentAlphaToken(value: string, cursorPos: number): string {
  const before = value.slice(0, cursorPos);
  const match = before.match(/([A-Za-z]+)$/);
  return match ? match[1].toUpperCase() : "";
}

/** Given a partial token, return matching function names and named-cell names
 *  (named cells sorted after functions — Excel/Sheets convention). */
function matchingCompletions(token: string, namedCells: Map<string, NamedCell>): string[] {
  if (!token) return [];
  const fnMatches = FUNCTION_NAMES.filter(f => f.startsWith(token) && f !== token);
  const namedMatches = Array.from(namedCells.keys()).filter(n => {
    const upper = n.toUpperCase();
    return upper.startsWith(token) && upper !== token;
  });
  return [...fnMatches, ...namedMatches];
}

/** Syntax/description shown under the autocomplete list for the highlighted
 *  entry — functions show their syntax signature, named cells show what
 *  they're bound to. Returns null for a name that's neither (shouldn't happen
 *  since completions only ever come from matchingCompletions). */
function describeCompletion(name: string, namedCells: Map<string, NamedCell>): { syntax: string; desc: string } | null {
  const fn = FORMULA_FUNCTIONS[name];
  if (fn) return fn;
  const nc = namedCells.get(name);
  if (nc) return { syntax: name, desc: `Named cell → ${nc.path}!${cellRefLabel(nc.row, nc.col)}` };
  return null;
}

/** Extract the 0-based row index from the last path segment, e.g. "L1/R3" → 3,
 *  "L1/S3" → 3, "L1/S3/Q5" → 5. The row index is purely positional — kind-agnostic —
 *  so "/R<n>" (Rate Build-up), "/Q<n>" (Quantity Build-up), and "/S<n>" (recursive
 *  cost sheet, M5) all match: a row drilled via its F:Subtotal column (rather than
 *  E:Rate or C:Quantity) produces an "/S<n>" child, and a caller keying off this
 *  purely to find "which row of the parent does this child belong to" needs that
 *  case too — omitting it previously made `refreshBreadcrumbFromEngine` silently
 *  fall back to row 0 (the parent's own header row) for any S-drilled ancestor. */
function pathLastRow(path: string): number | null {
  const m = path.match(/\/[RQS](\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Evaluated values of one sheet, read from the live engine — which holds every sheet of the
 * revision, so cross-sheet rollups and named cells resolve exactly as they do on screen. A cell
 * error comes back as its Excel text ("#REF!") rather than an error object. Returns [] for a sheet
 * the engine doesn't hold.
 */
function engineSheetValues(hot: Handsontable, path: string): unknown[][] {
  const engine = getFormulasPlugin(hot)?.engine;
  const name = pathToSheetName(path);
  if (!engine || !engine.doesSheetExist(name)) return [];
  const values = engine.getSheetValues(engine.getSheetId(name)) as unknown[][];
  return values.map(row => row.map(v =>
    v != null && typeof v === "object" ? String((v as { value?: unknown }).value ?? "#ERROR!") : v));
}

/** A named cell's live value as a number, matching the name case-insensitively — named cells are
 *  user-created and their casing isn't enforced, but the cost-code export's blended labour rate
 *  needs a reliable match on `lab_rate` however the estimator capitalized it (the same tolerance
 *  HyperFormula's own name resolution gives formulas). */
function engineNamedNumber(hot: Handsontable, name: string): number | undefined {
  const engine = getFormulasPlugin(hot)?.engine;
  if (!engine) return undefined;
  const target = name.toLowerCase();
  const match = (engine.listNamedExpressions?.() as string[] | undefined)?.find(n => n.toLowerCase() === target);
  if (match == null) return undefined;
  try { return numOrUndefined(engine.getNamedExpressionValue(match)); } catch { return undefined; }
}

// The numeric-coercion helpers (toNum / numOrUndefined / textOrBlank) live in lib/workbookCalc.ts
// — imported at the top of this file.

/** One output row of the flattened Excel export — see WorkbookGridApi.exportExcel. */
interface FlatExportRow {
  sectionCode: string;
  sectionDesc: string;
  code: string;
  desc: string;
  qty?: number;
  unit: string;
  rate?: number;
  subtotal?: number;
  factor?: number;
  total?: number;
  lab?: number;
  labTotal?: number;
  mat?: number;
  matTotal?: number;
  sub?: number;
  subTotal?: number;
  sum?: number;
  sumTotal?: number;
  /** Marks a synthetic row inserted around a section's items (see `exportExcel`) — not a real sheet row. */
  rowKind?: "header" | "footer";
}

// deriveFactorTotal lives in lib/workbookCalc.ts — imported at the top of this file.

/** Build one flattened export row from an evaluated sheet row (see `engineSheetValues`). */
function flatExportRowFrom(evaluated: unknown[], sectionCode: string, sectionDesc: string): FlatExportRow {
  const subtotal = numOrUndefined(evaluated[COL_SUBTOTAL]);
  const { factor, total } = deriveFactorTotal(subtotal, numOrUndefined(evaluated[COL_FACTOR]), numOrUndefined(evaluated[COL_TOTAL]));
  return {
    sectionCode, sectionDesc,
    code: textOrBlank(evaluated[COL_CODE]), desc: textOrBlank(evaluated[COL_DESC]),
    qty: numOrUndefined(evaluated[COL_QTY]), unit: textOrBlank(evaluated[COL_UNIT]), rate: numOrUndefined(evaluated[COL_RATE]),
    subtotal, factor, total,
    lab: numOrUndefined(evaluated[COL_LAB]), labTotal: numOrUndefined(evaluated[COL_LAB_TOTAL]),
    mat: numOrUndefined(evaluated[COL_MAT]), matTotal: numOrUndefined(evaluated[COL_MAT_TOTAL]),
    sub: numOrUndefined(evaluated[COL_SUB]), subTotal: numOrUndefined(evaluated[COL_SUB_TOTAL]),
    sum: numOrUndefined(evaluated[COL_SUM]), sumTotal: numOrUndefined(evaluated[COL_SUM_TOTAL]),
  };
}

// ─── Breadcrumb toolbar row ───────────────────────────────────────────────

interface BreadcrumbRowProps {
  ctx:    BreadcrumbCtx;
  onBack: () => void;
}

// CostX renders each breadcrumb field as its own separate bordered/rounded chip
// (including the back-arrow) laid out in a row with a small gap between them,
// rather than one continuous bordered strip with internal divider lines.
const BREADCRUMB_ROW_H = 24;
const BREADCRUMB_CHIP_GAP = 4;

function BreadcrumbChip({
  children,
  width,
  align = "left",
  bold,
  yellow,
  header,
}: {
  children: React.ReactNode;
  width:    number;
  align?:   "left" | "right";
  bold?:    boolean;
  yellow?:  boolean;
  header?:  boolean;
}) {
  return (
    <div
      style={{
        width,
        boxSizing: "border-box",
        height: BREADCRUMB_ROW_H,
        display: "flex",
        alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        padding: "0 6px",
        fontSize: header ? 11 : 12,
        fontWeight: header ? 700 : bold ? 600 : 400,
        color: header ? "#33475b" : "#1f2d3d",
        flexShrink: 0,
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        border: header ? undefined : "1px solid #b9c2cc",
        borderRadius: header ? undefined : 0,
        background: header ? undefined : yellow ? HIGHLIGHT_BG : "#fff",
      }}
    >
      {children}
    </div>
  );
}

/** Column-label header for the breadcrumb pills below — rendered once, not per
 *  level, sized to fit its content rather than stretching the full grid width. */
function BreadcrumbHeaderRow() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: BREADCRUMB_CHIP_GAP, padding: "4px 8px 0", flexShrink: 0 }}>
      <div style={{ width: ROW_HDR_W, flexShrink: 0 }} />
      <BreadcrumbChip header width={COLUMNS[0].width}>Code</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[1].width}>Description</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[2].width} align="right">Quantity</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[3].width}>Unit</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[4].width} align="right">Rate</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[5].width} align="right">Sub-Total</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[6].width} align="right">Factor</BreadcrumbChip>
      <BreadcrumbChip header width={COLUMNS[7].width} align="right">Total</BreadcrumbChip>
    </div>
  );
}

function BreadcrumbRow({ ctx, onBack }: BreadcrumbRowProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: BREADCRUMB_CHIP_GAP, padding: "4px 8px", flexShrink: 0 }}>
      {/* ← back-navigation icon — its own chip, same width as rowHeaderWidth so column A aligns with the grid */}
      <button
        onClick={onBack}
        title="Return to previous level"
        style={{
          width: ROW_HDR_W,
          height: BREADCRUMB_ROW_H,
          boxSizing: "border-box",
          border: "1px solid #b9c2cc",
          background: "#fff",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 15, color: "#7a8794" }}>reply</span>
      </button>

      {/* A: Code */}
      <BreadcrumbChip width={COLUMNS[0].width} bold>{ctx.code}</BreadcrumbChip>

      {/* B: Description */}
      <BreadcrumbChip width={COLUMNS[1].width} bold>{ctx.description}</BreadcrumbChip>

      {/* C: Quantity */}
      <BreadcrumbChip width={COLUMNS[2].width} align="right">{ctx.quantity}</BreadcrumbChip>

      {/* D: Unit */}
      <BreadcrumbChip width={COLUMNS[3].width}>{ctx.unit}</BreadcrumbChip>

      {/* E: Rate */}
      <BreadcrumbChip width={COLUMNS[4].width} align="right">{ctx.rate}</BreadcrumbChip>

      {/* F: Sub-Total – yellow */}
      <BreadcrumbChip width={COLUMNS[5].width} align="right" yellow>
        {formatNumericDisplay(ctx.subtotal, DEFAULT_WORKBOOK_FORMAT.decimals) ?? ctx.subtotal}
      </BreadcrumbChip>

      {/* G: Factor */}
      <BreadcrumbChip width={COLUMNS[6].width} align="right">{ctx.factor}</BreadcrumbChip>

      {/* H: Total – yellow */}
      <BreadcrumbChip width={COLUMNS[7].width} align="right" bold yellow>
        {formatNumericDisplay(ctx.total, DEFAULT_WORKBOOK_FORMAT.decimals) ?? ctx.total}
      </BreadcrumbChip>
    </div>
  );
}

// ─── Formula autocomplete dropdown ────────────────────────────────────────

interface AutocompleteProps {
  completions:    string[];
  selectedIndex:  number;
  onSelect:       (name: string) => void;
  onHover:        (index: number) => void;
  namedCells:     Map<string, NamedCell>;
  /** When provided, the dropdown is fixed-positioned at these viewport
   *  coordinates instead of anchored via `position: absolute; top: 100%`
   *  under a `position: relative` parent — used for the in-cell popup, which
   *  is portaled to document.body since the editor's cell can be anywhere. */
  fixedPosition?: { top: number; left: number };
}

function FormulaAutocomplete({ completions, selectedIndex, onSelect, onHover, namedCells, fixedPosition }: AutocompleteProps) {
  if (completions.length === 0) return null;
  const info = describeCompletion(completions[selectedIndex], namedCells);

  return (
    <div
      style={{
        position: fixedPosition ? "fixed" : "absolute",
        top: fixedPosition ? fixedPosition.top : "100%",
        left: fixedPosition ? fixedPosition.left : 0,
        zIndex: 200,
        background: "#fff",
        border: "1px solid #bbb",
        borderRadius: 4,
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        minWidth: 280,
        fontSize: 12,
        fontFamily: "Segoe UI, Arial, sans-serif",
      }}
      // Prevent the input from losing focus when clicking the dropdown
      onMouseDown={e => e.preventDefault()}
    >
      {/* Function/named-cell list */}
      <div style={{ maxHeight: 160, overflowY: "auto" }}>
        {completions.map((name, i) => (
          <div
            key={name}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(name)}
            style={{
              padding: "3px 8px",
              cursor: "pointer",
              background: i === selectedIndex ? "#e3ecf7" : "transparent",
              fontWeight: i === selectedIndex ? 600 : 400,
              color: "#1a1a1a",
              borderBottom: i < completions.length - 1 ? "1px solid #f0f0f0" : "none",
            }}
          >
            {name}
          </div>
        ))}
      </div>

      {/* Syntax/binding hint for the selected entry */}
      {info && (
        <div style={{ borderTop: "1px solid #ddd", padding: "5px 8px", background: "#f8f8f8", borderRadius: "0 0 4px 4px" }}>
          <div style={{ fontWeight: 600, color: "#1a5fa8", marginBottom: 2 }}>{info.syntax}</div>
          <div style={{ color: "#555" }}>{info.desc}</div>
        </div>
      )}
    </div>
  );
}

// ─── Isolated grid wrapper (React.memo prevents re-renders from parent state) ─

interface GridCoreProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hotRef: React.RefObject<HotTableRef>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any;
}

const GridCore = React.memo(function GridCore({ hotRef, settings }: GridCoreProps) {
  return <HotTable ref={hotRef} {...settings} />;
});

// ─── Main component ───────────────────────────────────────────────────────

export function WorkbookView() {
  const hotRef         = useRef<HotTableRef>(null);
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const formulaBarRef  = useRef<HTMLInputElement>(null);
  const breadcrumbTrailRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(400);
  // True while a revision switch is loading all sheets from the DB — surfaces a visible
  // "Loading workbook…" overlay instead of a multi-second window where the grid just sits
  // there looking frozen (this was mistaken for a crash on large, fully-measured tenders).
  const [workbookLoading, setWorkbookLoading] = useState(false);
  // Determinate progress through resetEngineSheets's sheet-by-sheet loop (the dominant cost on
  // a revision's first-ever load) — null while that phase isn't running, so the overlay falls
  // back to an indeterminate spinner for the network/JSON/named-cell phases around it.
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);

  // Active revision from store (drives data load/save)
  const activeRevisionId = useAppStore(s => s.activeRevisionId);
  const revIdRef = useRef<number | null>(null);
  revIdRef.current = activeRevisionId;
  // The revision whose sheet the grid is actually showing: set once a revision's L1 is on screen,
  // null while a switch is still loading. Autosave targets this, not revIdRef (see flushPendingSave).
  const displayedRevIdRef = useRef<number | null>(null);

  const setWorkbookRevisionProjectTotal = useAppStore(s => s.setWorkbookRevisionProjectTotal);
  const workbooks = useAppStore(s => s.workbooks);
  const activeProjectTotal = workbooks
    .flatMap(wb => wb.revisions)
    .find(rev => rev.id === activeRevisionId)?.project_total ?? null;

  // Format toolbar bridge (ribbon ⇄ grid) — see appStore.ts
  const setWorkbookFormat    = useAppStore(s => s.setWorkbookFormat);
  const setWorkbookFormatApi = useAppStore(s => s.setWorkbookFormatApi);
  const setWorkbookGridApi   = useAppStore(s => s.setWorkbookGridApi);

  // Template manager / template-edit-mode (Settings → Template Manager in the ribbon) —
  // editing a template is just displaying its revision as an ordinary workbook (see
  // enterTemplateEdit in appStore.ts); the banner below only needs to know whether it's
  // active, and for whom.
  const templateManagerOpen = useAppStore(s => s.templateManagerOpen);
  const templateEditMode    = useAppStore(s => s.templateEditMode);
  const exitTemplateEdit    = useAppStore(s => s.exitTemplateEdit);

  // Current drill-down level and breadcrumb context stack
  const [level,      setLevel]      = useState<Level>(1);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbCtx[]>([]);

  // Active cell display / formula bar
  const [activeCell,      setActiveCell]      = useState("A1");
  const [activeCellValue, setActiveCellValue] = useState("");

  // Formula autocomplete (formula bar)
  const [completions,    setCompletions]    = useState<string[]>([]);
  const [completionIdx,  setCompletionIdx]  = useState(0);

  // Formula autocomplete while typing directly in a cell (not just the formula
  // bar) — see afterBeginEditing/beforeKeyDown in hotSettings. `cellCompletions*Ref`
  // mirror the state so the memoised (deps: []) hotSettings' beforeKeyDown can
  // read the latest value without recreating the Handsontable instance — same
  // pattern as scheduleSaveRef/formatApiRef below.
  const [cellCompletions,    setCellCompletions]    = useState<string[]>([]);
  const [cellCompletionIdx,  setCellCompletionIdx]  = useState(0);
  const [cellCompletionPos,  setCellCompletionPos]  = useState<{ top: number; left: number } | null>(null);
  const cellCompletionsRef   = useRef<string[]>([]);
  const cellCompletionIdxRef = useRef(0);
  const cellEditorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { cellCompletionsRef.current = cellCompletions; }, [cellCompletions]);
  useEffect(() => { cellCompletionIdxRef.current = cellCompletionIdx; }, [cellCompletionIdx]);

  // Last grid cell that had selection focus — used to sync formula bar edits
  // back to the cell even after focus moves to the input element.
  const lastSelectedCellRef = useRef<{ row: number; col: number } | null>(null);

  // Most recent Ctrl+C/copy selection — used by afterPaste to detect "a drill column
  // cell was copied" so the paste can clone that row's drilled child sheet onto
  // the destination row (see maybeCloneChildSheet).
  const lastRateCopyRef = useRef<{
    path: string;
    level: Level;
    startRow: number;
    startCol: number;
    rowCount: number;
    colCount: number;
  } | null>(null);

  // System-clipboard text for the right-click menu's Paste item, prefetched as
  // soon as the menu opens (see handleGridContextMenu) so it's normally already
  // resolved by the time the user clicks Paste. `null` means "not resolved
  // yet" — Paste's own click handler falls back to its own read in that case.
  const pendingPasteTextRef = useRef<string | null>(null);

  // Excel-style status bar stats for the current selection
  const [selectionStats, setSelectionStats] = useState<{ count: number; sum: number; average: number } | null>(null);

  // Workbook maintenance: "clean orphaned sheets" / "clear whole workbook".
  // `cleanupBusy` disables the toolbar buttons while a maintenance op runs;
  // `cleanupMessage` is a short transient status shown beside them; `confirmAction`
  // drives the shared ConfirmDialog (clearing the workbook is destructive).
  const [cleanupBusy,    setCleanupBusy]    = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const confirmAction      = useAppStore(s => s.workbookConfirmAction);
  const setConfirmAction   = useAppStore(s => s.setWorkbookConfirmAction);
  const cleanupMessageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCleanupMessage = useCallback((msg: string) => {
    if (cleanupMessageTimerRef.current) clearTimeout(cleanupMessageTimerRef.current);
    setCleanupMessage(msg);
    cleanupMessageTimerRef.current = setTimeout(() => setCleanupMessage(null), 5000);
  }, []);

  useEffect(() => () => {
    if (cleanupMessageTimerRef.current) clearTimeout(cleanupMessageTimerRef.current);
  }, []);

  // Per-path data store: "L1" → root sheet; "L1/R3" → sub-sheet from row 3 of root; etc.
  // Holds *source* data (formula strings) — what gets persisted/restored.
  const sheetDataMap = useRef<Map<string, (string | null)[][]>>(
    new Map([["L1", createEmptyData()]])
  );
  // Parallel cache of *evaluated* snapshots (getEvaluatedGridData(hot)), captured at the same
  // moments as sheetDataMap (when leaving a sheet). Needed so live breadcrumb rollup
  // can sum ancestor sheets' formula columns (F, H, …) without re-loading/evaluating
  // them — sheetDataMap's formula strings would otherwise sum to NaN.
  const sheetComputedMap = useRef<Map<string, unknown[][]>>(new Map());
  const pathStack = useRef<string[]>(["L1"]);

  // Per-sheet, per-cell text formatting applied via the Format toolbar
  // (font/size/bold/italic/underline/alignment/decimal places). Persisted to SQLite
  // alongside sheet data — see persistSheet / ensureSheetStylesLoaded — and keyed
  // the same way as sheetDataMap so it follows drill navigation.
  const cellStyleMap = useRef<Map<string, Map<string, CellStyle>>>(new Map());

  // Per-sheet, per-cell dimension-group import links (CostX-style drag-and-drop from
  // the Dimensions sidebar into a Level 2/3 C:Quantity cell). Persisted to SQLite
  // alongside sheet data — see persistSheet / ensureSheetLinksLoaded.
  const cellLinkMap = useRef<Map<string, Map<string, CellLink>>>(new Map());
  const loadedLinkPathsRef = useRef<Set<string>>(new Set());
  const loadedStylePathsRef = useRef<Set<string>>(new Set());

  // Per-sheet set of cells excluded from auto-derivation — i.e. the F:Subtotal
  // drill-up rollup, the G:Factor default-to-1, and the H:Total = F×G formula
  // injection all skip any cell whose "row,col" key is present here. Lets a
  // template author "switch off" auto-calc for a hand-built summary block that
  // overwrites those columns with its own formulas. Persisted to SQLite alongside
  // sheet data — see persistSheet / ensureSheetExclusionsLoaded — and keyed the
  // same way as cellStyleMap so it follows drill navigation.
  const cellExclusionMap = useRef<Map<string, Set<string>>>(new Map());
  const loadedExclusionPathsRef = useRef<Set<string>>(new Set());

  // Named cells: workbook-wide name → bound cell (sheet path + row/col). Loaded
  // once per active revision and registered with HyperFormula as named expressions
  // (see registerNamedExpression) so they resolve in formulas at any drill level.
  // `registeredNamedExprRef` tracks which names already exist in the engine, since
  // HyperFormula needs `addNamedExpression` the first time and `changeNamedExpression`
  // thereafter.
  const namedCellMap = useRef<Map<string, NamedCell>>(new Map());
  const registeredNamedExprRef = useRef<Set<string>>(new Set());
  const [namedCellDialog, setNamedCellDialog] = useState<{ row: number; col: number } | null>(null);
  const namedCellsManagerOpen    = useAppStore(s => s.namedCellsManagerOpen);
  const closeNamedCellsManager   = useAppStore(s => s.closeNamedCellsManager);
  const columnLayoutManagerOpen  = useAppStore(s => s.columnLayoutManagerOpen);
  const closeColumnLayoutManager = useAppStore(s => s.closeColumnLayoutManager);
  const saveWorkbookLayout       = useAppStore(s => s.saveWorkbookLayout);

  // Drag-and-drop import dialog (shown when more than one derived display is possible)
  // and the "Show dimension group" context menu for already-linked cells.
  const [importPrompt, setImportPrompt] = useState<{
    row: number; groupId: number; groupName: string; options: ImportDisplayOption[]; defaultKey: string;
    /** Carried through the dialog so a Joist/Rafter group's differently-sized blocking row is only
     *  inserted once the user actually confirms the import (cancelling must leave nothing behind). */
    blocking?: ArrayGroupBreakdown | null;
  } | null>(null);
  const [gridContextMenu, setGridContextMenu] = useState<{
    x: number; y: number; items: ContextMenuEntry[];
  } | null>(null);
  // Row/column pending a confirmed delete — set when the target holds real
  // content, so a right-click delete can't silently destroy data.
  const [pendingDelete, setPendingDelete] = useState<{ kind: "row" | "col"; from: number; to: number } | null>(null);
  const goToDimensionGroup = useAppStore(s => s.goToDimensionGroup);

  function curSheetPath(): string {
    return pathStack.current[pathStack.current.length - 1];
  }

  function getCellStyle(row: number, col: number): CellStyle {
    return cellStyleMap.current.get(curSheetPath())?.get(styleKey(row, col)) ?? {};
  }

  function getCellLink(path: string, row: number, col: number): CellLink | undefined {
    return cellLinkMap.current.get(path)?.get(styleKey(row, col));
  }

  function setCellLink(path: string, row: number, col: number, link: CellLink) {
    let map = cellLinkMap.current.get(path);
    if (!map) { map = new Map(); cellLinkMap.current.set(path, map); }
    map.set(styleKey(row, col), link);
  }

  /** True when (row,col) on `path` is excluded from auto-derivation — the
   *  drill-up rollup, factor default-to-1, and total formula injection all skip it. */
  function isCellExcluded(path: string, row: number, col: number): boolean {
    return cellExclusionMap.current.get(path)?.has(styleKey(row, col)) ?? false;
  }

  /** Adds or removes (row,col) on `path` from the exclusion set and persists it. Most callers
   *  are a user-driven toggle on an already-displayed (so already-loaded) sheet, but a few
   *  (auto-excluding a Quantity cell the instant a dimension group links into it) can fire
   *  before this path's exclusions have finished their own initial load. Applying the toggle
   *  straight to cellExclusionMap in that window would build a brand-new, one-entry set and
   *  persist it — overwriting whatever was really on disk, the same shape of bug that wiped a
   *  revision's exclusions via `persistSheet`. Deferring to `ensureSheetExclusionsLoaded` first
   *  is a no-op when the path is already loaded (the common case) and otherwise waits for the
   *  real set before merging the toggle into it. */
  function setCellExcluded(path: string, row: number, col: number, excluded: boolean) {
    const revId = revIdRef.current;
    const apply = () => {
      let set = cellExclusionMap.current.get(path);
      if (excluded) {
        if (!set) { set = new Set(); cellExclusionMap.current.set(path, set); }
        set.add(styleKey(row, col));
      } else if (set) {
        set.delete(styleKey(row, col));
        if (set.size === 0) cellExclusionMap.current.delete(path);
      }
      if (revId != null) persistSheetExclusions(revId, path);
    };
    if (revId != null && !loadedExclusionPathsRef.current.has(path)) {
      ensureSheetExclusionsLoaded(revId, path).then(apply);
    } else {
      apply();
    }
  }

  /** Toggles auto-calc exclusion for every cell in the current selection on the
   *  active sheet, then re-derives so the change takes effect immediately. */
  function toggleExclusionForSelection(exclude: boolean) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const path = curSheetPath();
    for (const { row, col } of getSelectedCells()) {
      setCellExcluded(path, row, col, exclude);
    }
    hot.render();
    deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), path, cellExclusionMap.current.get(path));
  }

  // ── Named cells ─────────────────────────────────────────────────────────

  /** Reads a cell's *evaluated* value regardless of which sheet it lives on:
   *  the active sheet via Handsontable, an ancestor via its rollup snapshot, or
   *  (last resort) its raw stored source string. Used to seed/refresh the named
   *  expression's cached value, since HyperFormula only ever has one sheet loaded. */
  function readCellValue(path: string, row: number, col: number): unknown {
    const hot = hotRef.current?.hotInstance;
    if (path === curSheetPath() && hot) return hot.getDataAtCell(row, col);
    const computed = sheetComputedMap.current.get(path);
    if (computed) return computed[row]?.[col] ?? null;
    return sheetDataMap.current.get(path)?.[row]?.[col] ?? null;
  }

  /** Builds the HyperFormula named-expression formula for `nc`. Now that the whole revision is
   *  loaded into one multi-sheet engine, a named cell is ALWAYS a **live cross-sheet reference**
   *  (`=L1_sR3!$C$5`) — HyperFormula tracks the dependency natively and repaints every formula
   *  using the name the instant the bound cell changes, from any sheet, exactly like an Excel
   *  named range. (The literal-snapshot fallback the single-"Sheet1" design needed is gone.)
   *  Falls back to a literal only if the bound sheet somehow isn't loaded. */
  function namedExprFormula(nc: NamedCell): string {
    const engine = getFormulasPlugin(hotRef.current?.hotInstance as Handsontable | undefined)?.engine;
    const name = pathToSheetName(nc.path);
    if (engine?.doesSheetExist?.(name)) {
      const letter = colLetter(nc.col);
      return `=${name}!$${letter}$${nc.row + 1}`;
    }
    return namedExprFromValue(readCellValue(nc.path, nc.row, nc.col));
  }

  /** Registers (or updates) `nc` as a global HyperFormula named expression, choosing
   *  live-reference vs literal-snapshot form via `namedExprFormula`. */
  function registerNamedExpression(nc: NamedCell) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = (hotRef.current?.hotInstance?.getPlugin('formulas') as any)?.engine;
    if (!hf) return;
    const formula = namedExprFormula(nc);
    // Use the engine itself as the source of truth for whether the name already
    // exists — a separate JS Set can desync (e.g. if the engine drops the name) and
    // then `changeNamedExpression` throws, silently leaving a stale (live-ref) formula.
    const exists = (() => {
      try { return hf.getNamedExpression?.(nc.name) != null; }
      catch { return registeredNamedExprRef.current.has(nc.name); }
    })();
    try {
      if (exists) hf.changeNamedExpression(nc.name, formula);
      else hf.addNamedExpression(nc.name, formula);
      registeredNamedExprRef.current.add(nc.name);
    } catch {
      // Last resort: tear down and re-add so the name never gets stuck on an old formula.
      try { hf.removeNamedExpression(nc.name); } catch { /* wasn't there */ }
      try { hf.addNamedExpression(nc.name, formula); registeredNamedExprRef.current.add(nc.name); }
      catch { /* invalid expression text — leave the name unregistered */ }
    }
    const resolved = (() => { try { return hf.getNamedExpressionValue(nc.name); } catch { return "ERR"; } })();

    // Cache PROJECT_TOTAL's resolved value on the revision so the workbook
    // sidebar can show it without re-evaluating formulas itself.
    if (nc.name === PROJECT_TOTAL_NAME) {
      const revId = revIdRef.current;
      if (revId != null) {
        void setWorkbookRevisionProjectTotal(revId, typeof resolved === "number" ? resolved : null);
      }
    }
  }

  /** Re-registers *every* named cell against the now-active sheet — called after any
   *  sheet load/navigation. Names bound to the new active sheet flip to live
   *  references (auto-updating); names bound elsewhere flip to a fresh literal
   *  snapshot. The `path` arg is the just-loaded sheet (kept for call-site clarity;
   *  all names are re-evaluated regardless since leaving a sheet must demote its
   *  live references back to literals). */
  function refreshNamedCellsForPath(_path: string) {
    if (namedCellMap.current.size === 0) return;
    for (const nc of namedCellMap.current.values()) registerNamedExpression(nc);
  }

  /** Re-reads PROJECT_TOTAL's live value and re-caches it on the revision —
   *  called after edits on L1 so the workbook sidebar total updates as the
   *  user types, not just on load/navigation. */
  function refreshProjectTotal() {
    const pt = namedCellMap.current.get(PROJECT_TOTAL_NAME);
    if (!pt || pt.path !== "L1" || curSheetPath() !== "L1") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = (hotRef.current?.hotInstance?.getPlugin('formulas') as any)?.engine;
    if (!hf) return;
    let value: unknown;
    try { value = hf.getNamedExpressionValue(PROJECT_TOTAL_NAME); } catch { return; }
    const revId = revIdRef.current;
    if (revId != null) {
      void setWorkbookRevisionProjectTotal(revId, typeof value === "number" ? value : null);
    }
  }

  /** Binds `name` to (path,row,col): persists it, replaces any prior binding for
   *  the same name, and (re)registers it with HyperFormula. */
  async function defineNamedCell(name: string, path: string, row: number, col: number) {
    const revId = revIdRef.current;
    if (revId == null) return;
    const nc: NamedCell = { name, path, row, col };
    namedCellMap.current.set(name, nc);
    registerNamedExpression(nc);
    try {
      await wbInvoke("save_workbook_named_cell", {
        revisionId: revId, name, sheetPath: path, row, col,
      });
    } catch { /* non-fatal — local binding still works for this session */ }
    // Re-render so cell renderers that key off namedCellMap (e.g. the
    // PROJECT_TOTAL highlight) pick up the new binding immediately.
    hotRef.current?.hotInstance?.render();
  }

  /** Removes `name`'s binding entirely: persisted row, HyperFormula named expression,
   *  and local bookkeeping. Used by the Named Cells manager's Delete action. */
  async function removeNamedCell(name: string) {
    const revId = revIdRef.current;
    namedCellMap.current.delete(name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = (hotRef.current?.hotInstance?.getPlugin('formulas') as any)?.engine;
    if (hf && registeredNamedExprRef.current.has(name)) {
      try { hf.removeNamedExpression(name); } catch { /* already gone */ }
    }
    registeredNamedExprRef.current.delete(name);
    if (revId == null) return;
    try {
      await wbInvoke("delete_workbook_named_cell", { revisionId: revId, name });
    } catch { /* non-fatal — local removal still took effect for this session */ }
  }

  /** Renames `oldName` to `newName`, keeping its cell binding: implemented as
   *  delete-then-redefine since the persisted table is unique on name. Used by
   *  the Named Cells manager's Rename action. */
  async function renameNamedCell(oldName: string, newName: string) {
    const nc = namedCellMap.current.get(oldName);
    if (!nc) return;
    await removeNamedCell(oldName);
    await defineNamedCell(newName, nc.path, nc.row, nc.col);
  }

  /** Switches to the sheet a named cell is bound to and selects/scrolls to it.
   *  Used by the Named Cells manager's "Go to" action. */
  function goToNamedCell(name: string) {
    const nc = namedCellMap.current.get(name);
    if (!nc) return;
    closeNamedCellsManager();
    if (nc.path === curSheetPath()) {
      const hot = hotRef.current?.hotInstance;
      if (hot) {
        hot.selectCell(nc.row, nc.col);
        hot.scrollViewportTo(nc.row, nc.col, true, true);
      }
      return;
    }
    jumpToSheet(nc.path, levelForPath(nc.path), { row: nc.row, col: nc.col });
  }

  /** Loads a sheet's persisted cell-link map once (cached thereafter; lost links are
   *  re-fetched after a "Clear workbook" since the path is purged from the cache too). */
  // NOTE: this and its two siblings below (ensureSheetStylesLoaded, ensureSheetExclusionsLoaded)
  // mark their path "loaded" only in a `finally` AFTER the fetch settles, not before it starts.
  // Marking it up front let a second concurrent call for the same path (React StrictMode's
  // dev-mode double-invoke of the revision-load effect, or any other double-trigger) see
  // "already loaded" and proceed immediately with an EMPTY map — since the first call's fetch
  // hadn't actually populated it yet. For exclusions that let auto-derivation overwrite a
  // protected cell's hand-built formula; for links it could do the same to a dimension-linked
  // Quantity cell (see `getCellLink` in writeRollupFormulasIntoGrid). A concurrent duplicate
  // fetch is now possible but harmless.
  async function ensureSheetLinksLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedLinkPathsRef.current.has(path)) return;
    try {
      const json = await wbRead<string>("load_workbook_sheet_links", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, CellLink>;
      const entries = Object.entries(obj);
      if (entries.length > 0) cellLinkMap.current.set(path, new Map(entries));
    } catch { /* non-fatal — sheet simply has no links yet */ }
    finally {
      loadedLinkPathsRef.current.add(path);
    }
  }

  /** Loads `path`'s persisted per-cell text formatting (bold/italic/etc.) into
   *  cellStyleMap, once per path — mirrors ensureSheetLinksLoaded. */
  async function ensureSheetStylesLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedStylePathsRef.current.has(path)) return;
    try {
      const json = await wbRead<string>("load_workbook_sheet_styles", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, CellStyle>;
      const entries = Object.entries(obj);
      if (entries.length > 0) cellStyleMap.current.set(path, new Map(entries));
    } catch { /* non-fatal — sheet simply has no styles yet */ }
    finally {
      loadedStylePathsRef.current.add(path);
    }
  }

  /** Loads `path`'s persisted auto-calc exclusion set into cellExclusionMap, once
   *  per path — mirrors ensureSheetStylesLoaded. Awaited *before* the sheet's first
   *  `loadLevelData`/`deriveLevelFormulas` pass (see loadLevelDataExcl) so a freshly
   *  opened excluded cell never gets clobbered by an auto-derived value first. */
  async function ensureSheetExclusionsLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedExclusionPathsRef.current.has(path)) return;
    try {
      const json = await wbRead<string>("load_workbook_sheet_exclusions", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, true>;
      const keys = Object.keys(obj);
      if (keys.length > 0) cellExclusionMap.current.set(path, new Set(keys));
    } catch { /* non-fatal — sheet simply has no exclusions yet */ }
    finally {
      loadedExclusionPathsRef.current.add(path);
    }
  }

  /** Persists `path`'s current auto-calc exclusion set (or clears it if empty). */
  function persistSheetExclusions(revisionId: number, path: string) {
    const set = cellExclusionMap.current.get(path);
    const obj: Record<string, true> = {};
    if (set) for (const key of set) obj[key] = true;
    wbWrite("save_workbook_sheet_exclusions", {
      revisionId,
      sheetPath: path,
      exclusionsJson: JSON.stringify(obj),
    });
  }

  /** Wraps loadLevelData so that `path`'s persisted exclusion set is loaded and in
   *  cellExclusionMap *before* the first auto-derivation pass runs — guarantees an
   *  excluded cell's hand-built content is never overwritten on a cold sheet load. */
  function loadLevelDataExcl(
    hot: Handsontable,
    data: (string | null)[][],
    level: Level,
    guardRef: React.MutableRefObject<boolean>,
    path: string,
  ): void {
    const revId = revIdRef.current;
    // Re-point named expressions to the new active sheet *inside* loadLevelData, after
    // its clearSheet but before its loadData — so cross-sheet references already hold
    // their correct literal when the new sheet's formulas are first evaluated.
    const reRegister = () => refreshNamedCellsForPath(path);
    // Re-register named expressions both *before* loadData (so the new sheet's formulas
    // evaluate against correct values on first pass — no transient #VALUE!) and *after*
    // (idempotent safety net in case the plugin's loadData re-evaluation reset anything),
    // then render so dependent cells repaint.
    const settle = () => {
      reRegister();
      if (namedCellMap.current.size > 0) hot.render();
    };
    if (revId == null) {
      loadLevelData(hot, data, level, guardRef, path, undefined, reRegister);
      settle();
      return;
    }
    ensureSheetExclusionsLoaded(revId, path).then(() => {
      if (curSheetPath() !== path) return;
      loadLevelData(hot, data, level, guardRef, path, cellExclusionMap.current.get(path), reRegister);
      settle();
    });
  }

  /**
   * Re-derives every linked cell's quantity from its dimension group's *current*
   * geometry/props and rewrites C/D if they've changed — keeps the workbook in sync
   * when a measurement is edited after being imported. Bails out if the user has
   * since navigated away from `path`.
   *
   * For timber-framing links it ALSO re-seeds the row's Quantity Build-up sub-sheet
   * (`<path>/Q<row>`) from the live component breakdown. Previously only the parent
   * C:Quantity was kept live; the build-up sheet was a one-shot snapshot written at
   * drop time and never refreshed, so it silently drifted (e.g. the breakdown summed
   * to 221.72 while the cell showed the live 231.85). Re-deriving it here keeps the
   * breakdown and its parent cell in lock-step every time the sheet is displayed.
   */
  const refreshLinkedCells = useCallback(async (path: string) => {
    const links = cellLinkMap.current.get(path);
    if (!links || links.size === 0) return;

    // Load each group's live context at most once per refresh — a framing group is
    // referenced by its main row's link AND every lintel row's link.
    const ctxCache = new Map<number, GroupImportContext | null>();
    const getCtx = async (groupId: number): Promise<GroupImportContext | null> => {
      if (ctxCache.has(groupId)) return ctxCache.get(groupId) ?? null;
      let c: GroupImportContext | null = null;
      try { c = await loadGroupImportContext(groupId); } catch { c = null; }
      ctxCache.set(groupId, c);
      return c;
    };

    for (const [key, link] of Array.from(links.entries())) {
      if (curSheetPath() !== path) return;
      const [rowStr] = key.split(",");
      const row = Number(rowStr);
      const ctx = await getCtx(link.groupId);
      if (!ctx || curSheetPath() !== path) continue;
      const hot = hotRef.current?.hotInstance;
      if (!hot) continue;

      // Differently-sized sub-quantity row (framing lintel / joist-rafter blocking): track its own
      // size's live total (0 if that size is gone from the group), never the group's own quantity.
      if (isSubQuantityLink(link)) {
        const total = link.lintelSize != null
          ? liveLintelTotal(ctx.framingBreakdown, link.lintelSize)
          : liveBlockingTotal(ctx.arrayBreakdown, link.blockingSize!);
        const text = total != null ? total.toFixed(3) : "0";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (String((hot as any).getSourceDataAtCell(row, COL_QTY) ?? "") !== text) {
          hot.setDataAtCell(row, COL_QTY, text);
        }
        continue;
      }

      const quantity = deriveLinkedQuantity(ctx, link.display);
      if (!quantity) continue;
      const newQtyText = quantityValueText(quantity);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(row, COL_QTY) ?? "") !== newQtyText) {
        hot.setDataAtCell(row, COL_QTY, newQtyText);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(row, COL_UNIT) ?? "") !== quantity.uom) {
        hot.setDataAtCell(row, COL_UNIT, quantity.uom);
      }

      // Keep the framing breakdown sub-sheet AND the lintel line-item rows in step with
      // the live group.
      if (ctx.props.measurement_type === "timber_framing" && ctx.framingBreakdown) {
        const revId = revIdRef.current;
        if (revId == null) continue;
        const qtyPath = `${path}/Q${row}`;
        const freshQty = buildFramingQtyData(ctx.framingBreakdown);
        const existing = sheetDataMap.current.get(qtyPath);
        if (!existing || !sameSheetContent(existing, freshQty)) {
          sheetDataMap.current.set(qtyPath, freshQty);
          sheetComputedMap.current.delete(qtyPath); // force re-eval on next read
          persistSheet(revId, qtyPath, freshQty);
        }
        reconcileFramingLintels(hot, path, row, link.groupId, ctx.framingBreakdown);
      }

      // Same, for a joist/rafter group's differently-sized blocking row.
      if (ctx.props.measurement_type === "array" && ctx.arrayBreakdown) {
        reconcileArrayBlocking(hot, path, row, link.groupId, ctx.arrayBreakdown);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Backfills lintel-row cell links onto legacy (pre-link) framing rows and refreshes
   *  each lintel row's quantity in place from the live breakdown. Scans the contiguous
   *  block of "<size> Lintel to last" rows immediately below the group's row — the shape
   *  `populateFramingRollup` creates — so each lintel row is attributed to THIS group even
   *  when several framing groups share a sheet. Only cell values / links change (never row
   *  structure), so it is safe to run on every display. A vanished size drives its row's
   *  quantity to 0; a NEW size with no existing row is not auto-inserted (that needs a
   *  re-drop, which also lets the user price it). */
  function reconcileFramingLintels(
    hot: Handsontable,
    path: string,
    groupRow: number,
    groupId: number,
    breakdown: FramingGroupBreakdown,
  ): void {
    let attachedLink = false;
    for (let r = groupRow + 1; r < NUM_ROWS; r++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const desc = String((hot as any).getSourceDataAtCell(r, COL_DESC) ?? "");
      const m = LINTEL_DESC_RE.exec(desc);
      if (!m) break; // end of the contiguous lintel block
      const size = m[1];

      const existingLink = getCellLink(path, r, COL_QTY);
      // A row linked to a different group (or to a non-lintel meaning) ends this group's
      // contiguous lintel block — never touch someone else's row.
      if (existingLink && (existingLink.groupId !== groupId || existingLink.lintelSize == null)) break;
      if (!existingLink) {
        setCellLink(path, r, COL_QTY, { groupId, display: "length", lintelSize: size });
        setCellExcluded(path, r, COL_QTY, true);
        attachedLink = true;
      }

      const total = liveLintelTotal(breakdown, size);
      const text = total != null ? total.toFixed(3) : "0";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(r, COL_QTY) ?? "") !== text) {
        hot.setDataAtCell(r, COL_QTY, text);
      }
    }
    // A qty edit above would persist the sheet (with its links) via afterChange/scheduleSave;
    // if we only attached links without changing any quantity, persist explicitly.
    if (attachedLink) {
      const revId = revIdRef.current;
      if (revId != null) persistSheet(revId, path, sheetDataMap.current.get(path) ?? captureSourceData(hot));
    }
  }

  /** The joist/rafter analogue of `reconcileFramingLintels`: backfills the blocking-row cell link
   *  onto a legacy (pre-link) row and refreshes its quantity in place from the live breakdown.
   *  Scans the contiguous block of "<size> Blocking" rows immediately below the group's row — the
   *  shape `populateArrayRollup` creates — so the row is attributed to THIS group even when
   *  several groups share a sheet. Only cell values / links change (never row structure), so it is
   *  safe to run on every display. Blocking that has since been switched off, or changed to the
   *  group's own timber size (and so folded into the group's quantity), drives the row to 0; a
   *  newly-differing size with no existing row is not auto-inserted — that needs a re-drop, which
   *  also lets the user price it. */
  function reconcileArrayBlocking(
    hot: Handsontable,
    path: string,
    groupRow: number,
    groupId: number,
    breakdown: ArrayGroupBreakdown,
  ): void {
    let attachedLink = false;
    for (let r = groupRow + 1; r < NUM_ROWS; r++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const desc = String((hot as any).getSourceDataAtCell(r, COL_DESC) ?? "");
      const m = BLOCKING_DESC_RE.exec(desc);
      if (!m) break; // end of the contiguous blocking block
      const size = m[1];

      const existingLink = getCellLink(path, r, COL_QTY);
      // A row linked to a different group (or to a non-blocking meaning) ends this group's
      // contiguous block — never touch someone else's row.
      if (existingLink && (existingLink.groupId !== groupId || existingLink.blockingSize == null)) break;
      if (!existingLink) {
        setCellLink(path, r, COL_QTY, { groupId, display: "length", blockingSize: size });
        setCellExcluded(path, r, COL_QTY, true);
        attachedLink = true;
      }

      const total = liveBlockingTotal(breakdown, size);
      const text = total != null ? total.toFixed(3) : "0";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(r, COL_QTY) ?? "") !== text) {
        hot.setDataAtCell(r, COL_QTY, text);
      }
    }
    if (attachedLink) {
      const revId = revIdRef.current;
      if (revId != null) persistSheet(revId, path, sheetDataMap.current.get(path) ?? captureSourceData(hot));
    }
  }

  /** Ensures a freshly-displayed sheet's links are loaded and its linked cells reflect
   *  the latest dimension-group quantities. Call right after `loadLevelData`. */
  function syncSheetLinks(path: string) {
    const revId = revIdRef.current;
    if (revId == null) return;
    ensureSheetLinksLoaded(revId, path).then(() => {
      if (curSheetPath() !== path) return;
      const hot = hotRef.current?.hotInstance;
      if (hot) hot.render();
      void refreshLinkedCells(path);
    });
    ensureSheetStylesLoaded(revId, path).then(() => {
      if (curSheetPath() !== path) return;
      const hot = hotRef.current?.hotInstance;
      if (hot) hot.render();
      if (lastSelectedCellRef.current) syncFormatSnapshot();
    });
  }

  /** Imports a dimension group's derived quantity into C/D of `row` on the current
   *  sheet, and marks the cell as a live link (green font, "Show dimension group"). */
  function applyImport(row: number, groupId: number, display: string, quantity: Quantity) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    hot.setDataAtCell(row, COL_QTY, quantityValueText(quantity));
    hot.setDataAtCell(row, COL_UNIT, quantity.uom);
    setCellLink(curSheetPath(), row, COL_QTY, { groupId, display });
    hot.render();
    scheduleSaveRef.current();
  }

  /** Shifts every (row,col)-keyed entry in a cell-link/cell-style map whose row lies in
   *  `[fromRow, toRowExclusive)` down by `by` rows — keeps links/styles attached to their
   *  line items when `insertSubQuantityRowsBelow` has to displace existing rows. Processes from
   *  the bottom up so a row's incoming entry can never clobber one not yet moved. Entries
   *  that would land past the bottom of the fixed `NUM_ROWS` grid are dropped. */
  function shiftRowKeyedEntries<T>(
    map: Map<string, T> | undefined,
    fromRow: number,
    toRowExclusive: number,
    by: number,
    cols: number,
  ): void {
    if (!map || map.size === 0) return;
    // Shifting down (by > 0) must process the highest row first so a
    // not-yet-moved source is never clobbered by an earlier write; shifting
    // up (by < 0, e.g. row deletion) needs the opposite order for the same
    // reason — the lowest row's destination is always already vacated.
    const rows = by >= 0
      ? Array.from({ length: toRowExclusive - fromRow }, (_, i) => toRowExclusive - 1 - i)
      : Array.from({ length: toRowExclusive - fromRow }, (_, i) => fromRow + i);
    for (const r of rows) {
      for (let c = 0; c < cols; c++) {
        const key = styleKey(r, c);
        const val = map.get(key);
        if (val === undefined) continue;
        map.delete(key);
        const dest = r + by;
        if (dest >= 0 && dest <= NUM_ROWS - 1) map.set(styleKey(dest, c), val);
      }
    }
  }

  /** Same row-shift as shiftRowKeyedEntries, for the Set-based exclusion map
   *  (cellExclusionMap stores membership only, not a value per key). */
  function shiftRowKeyedSet(
    set: Set<string> | undefined,
    fromRow: number,
    toRowExclusive: number,
    by: number,
    cols: number,
  ): void {
    if (!set || set.size === 0) return;
    const rows = by >= 0
      ? Array.from({ length: toRowExclusive - fromRow }, (_, i) => toRowExclusive - 1 - i)
      : Array.from({ length: toRowExclusive - fromRow }, (_, i) => fromRow + i);
    for (const r of rows) {
      for (let c = 0; c < cols; c++) {
        const key = styleKey(r, c);
        if (!set.has(key)) continue;
        set.delete(key);
        const dest = r + by;
        if (dest >= 0 && dest <= NUM_ROWS - 1) set.add(styleKey(dest, c));
      }
    }
  }

  /** Column analogue of shiftRowKeyedEntries — used by insert/delete column (Q
   *  onward only; A–P have fixed structural meaning and never shift). `maxCol` is
   *  the current sheet's own column count (columns are per-sheet, not shared like
   *  NUM_ROWS — see growColsTo). */
  function shiftColKeyedEntries<T>(
    map: Map<string, T> | undefined,
    fromCol: number,
    toColExclusive: number,
    by: number,
    rows: number,
    maxCol: number,
  ): void {
    if (!map || map.size === 0) return;
    const cols = by >= 0
      ? Array.from({ length: toColExclusive - fromCol }, (_, i) => toColExclusive - 1 - i)
      : Array.from({ length: toColExclusive - fromCol }, (_, i) => fromCol + i);
    for (const c of cols) {
      for (let r = 0; r < rows; r++) {
        const key = styleKey(r, c);
        const val = map.get(key);
        if (val === undefined) continue;
        map.delete(key);
        const dest = c + by;
        if (dest >= 0 && dest <= maxCol - 1) map.set(styleKey(r, dest), val);
      }
    }
  }

  /** Set-based column analogue of shiftColKeyedEntries. */
  function shiftColKeyedSet(
    set: Set<string> | undefined,
    fromCol: number,
    toColExclusive: number,
    by: number,
    rows: number,
    maxCol: number,
  ): void {
    if (!set || set.size === 0) return;
    const cols = by >= 0
      ? Array.from({ length: toColExclusive - fromCol }, (_, i) => toColExclusive - 1 - i)
      : Array.from({ length: toColExclusive - fromCol }, (_, i) => fromCol + i);
    for (const c of cols) {
      for (let r = 0; r < rows; r++) {
        const key = styleKey(r, c);
        if (!set.has(key)) continue;
        set.delete(key);
        const dest = c + by;
        if (dest >= 0 && dest <= maxCol - 1) set.add(styleKey(r, dest));
      }
    }
  }

  /** Inserts plain `Description`/`Quantity`/`Unit` line items directly below `afterRow` on the
   *  current (Level 2) sheet — the framing group's "<size> Lintel to last" rows and a joist/rafter
   *  group's "<size> Blocking" row. A differently-sized sub-quantity is always an independent line
   *  item (never folded into the Quantity Build-up), placed as a plain takeoff-level value since
   *  there's nothing to drill into.
   *
   *  If existing line items already occupy the rows directly below, inserts blank rows first
   *  (`insertBlankRowAt`, so their sub-sheets, links and every reference to them follow) rather
   *  than overwriting them. */
  function insertSubQuantityRowsBelow(
    hot: Handsontable,
    path: string,
    afterRow: number,
    items: Array<{ desc: string; qty: string; link: CellLink }>,
  ): void {
    const count = items.length;
    if (count === 0) return;
    const insertAt = afterRow + 1;

    const data = captureSourceData(hot);
    let lastOccupied = -1;
    for (let r = NUM_ROWS - 1; r >= insertAt; r--) {
      if (isLineItemRow(data[r])) { lastOccupied = r; break; }
    }
    if (lastOccupied !== -1) {
      for (let i = 0; i < count; i++) insertBlankRowAt(hot, path, insertAt);
    }

    for (let i = 0; i < count; i++) {
      const r = insertAt + i;
      hot.setDataAtCell(r, COL_DESC, items[i].desc);
      hot.setDataAtCell(r, COL_QTY, items[i].qty);
      hot.setDataAtCell(r, COL_UNIT, "m");
      // Prevent accidental drill-down into C:Quantity for these auto-generated rows — the
      // quantity is a flat total (nothing to build up), and drilling would create a sub-sheet
      // whose rollup would overwrite the placed value on drill-up.
      setCellExcluded(path, r, COL_QTY, true);
      // Link the row to its own timber size so refreshLinkedCells keeps its quantity live with
      // the group (see reconcileFramingLintels / reconcileArrayBlocking) instead of freezing at
      // drop time.
      setCellLink(path, r, COL_QTY, items[i].link);
    }
    hot.render();
    scheduleSaveRef.current();
  }

  /** On dropping a timber-framing group: seeds the row's Quantity Build-up sub-sheet
   *  (`<path>/Q<row>`) with one Description/Length row per non-lintel component (plates,
   *  studs, dwangs, jacks, etc.), and inserts a plain "<size> Lintel to last" line item
   *  directly below the group's row for every distinct lintel size present.
   *
   *  Lintels are deliberately NOT folded into the Quantity Build-up — they're always a
   *  separate sub-quantity that must not roll into the group's own matchingTotalM. */
  function populateFramingRollup(row: number, groupId: number, breakdown: FramingGroupBreakdown): void {
    const hot = hotRef.current?.hotInstance;
    const revId = revIdRef.current;
    if (!hot || revId == null) return;
    const path = curSheetPath();

    const nonLintels = breakdown.components.filter(c => !c.sizeOverride);
    const lintels    = breakdown.components.filter(c => !!c.sizeOverride);

    if (nonLintels.length > 0) {
      const qtyPath = `${path}/Q${row}`;
      const qtyData = buildFramingQtyData(breakdown);
      sheetDataMap.current.set(qtyPath, qtyData);
      persistSheet(revId, qtyPath, qtyData);
    }

    if (lintels.length > 0) {
      // aggregateFramingGroup groups lintels by size (framingComponentKey includes
      // sizeOverride), so each entry here is one distinct lintel size.
      const items = lintels.map(c => ({
        desc: `${lintelRowDesc(c.sizeOverride!)}`,
        qty: c.totalM.toFixed(3),
        link: { groupId, display: "length", lintelSize: c.sizeOverride! },
      }));
      insertSubQuantityRowsBelow(hot, path, row, items);
    }
  }

  /** On dropping a Joist/Rafter group: inserts a plain "<size> Blocking" line item directly below
   *  the group's row when the group's blocking is a *different* timber size from its joists —
   *  the array analogue of the framing group's lintel rows, and for the same reason (CLAUDE.md's
   *  one-quantity-per-timber-size model). Same-size blocking needs no row: it is already inside
   *  the group's own imported quantity (`matchingTotalM`). */
  function populateArrayRollup(row: number, groupId: number, breakdown: ArrayGroupBreakdown): void {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    if (!breakdown.blockingSize || breakdown.blockingMatchesSize) return;
    if (Math.abs(breakdown.blockingTotalM) <= 1e-9) return;
    insertSubQuantityRowsBelow(hot, curSheetPath(), row, [{
      desc: blockingRowDesc(breakdown.blockingSize),
      qty: breakdown.blockingTotalM.toFixed(3),
      link: { groupId, display: "length", blockingSize: breakdown.blockingSize },
    }]);
  }

  /** Drop handler entry point: loads the dropped group's current quantity options and
   *  either imports immediately (timber framing / single-option groups) or prompts. */
  async function handleGroupDrop(groupId: number, groupName: string, row: number) {
    let ctx: GroupImportContext;
    try {
      ctx = await loadGroupImportContext(groupId);
    } catch {
      return;
    }

    // Wall framing: only the matching-size lineal-metre total may be imported, and
    // never via the choice dialog (CLAUDE.md framing-multi-size-model).
    if (ctx.props.measurement_type === "timber_framing") {
      const quantity = deriveLinkedQuantity(ctx, "length");
      if (quantity) applyImport(row, groupId, "length", quantity);
      if (ctx.framingBreakdown) populateFramingRollup(row, groupId, ctx.framingBreakdown);
      return;
    }

    const options = buildImportOptions(ctx);
    if (options.length === 0) return;
    // A Joist/Rafter group's differently-sized blocking gets its own line item whichever display
    // the group itself is imported as — it is a separate quantity of a separate timber, not a
    // different reading of the same geometry.
    const blocking = ctx.arrayBreakdown && !ctx.arrayBreakdown.blockingMatchesSize ? ctx.arrayBreakdown : null;
    if (options.length === 1) {
      applyImport(row, groupId, options[0].key, options[0].quantity);
      if (blocking) populateArrayRollup(row, groupId, blocking);
      return;
    }
    const defaultKey = options.some(o => o.key === ctx.props.default_display) ? ctx.props.default_display : options[0].key;
    setImportPrompt({ row, groupId, groupName, options, defaultKey, blocking });
  }

  function handleGridDragOver(event: React.DragEvent<HTMLDivElement>) {
    // dataTransfer.types is unreliable mid-drag in WebView2 — accept here and let
    // handleGridDrop validate the payload (it bails out if the MIME type is absent).
    if (levelRef.current === 1) return; // groups can only be dropped at Level 2/3
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  /** Drops a rate library item onto the Rate column: copies its code/description/unit/
   *  rate into the row as plain values (same one-shot-copy semantics as typing them in
   *  by hand) — there is no live link back to the price book, so a later price book
   *  re-upload never silently changes a rate already committed to a workbook. */
  function applyRateImport(row: number, item: { code: string; description: string; unit: string; rate: number }) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const changes: Array<[number, number, string | number]> = [];
    if (!hot.getDataAtCell(row, COL_CODE)) changes.push([row, COL_CODE, item.code]);
    if (!hot.getDataAtCell(row, COL_DESC)) changes.push([row, COL_DESC, item.description]);
    changes.push([row, COL_UNIT, item.unit]);
    changes.push([row, COL_RATE, item.rate]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hot.setDataAtCell(changes as any);
    hot.render();
    scheduleSaveRef.current();
  }

  function handleGridDrop(event: React.DragEvent<HTMLDivElement>) {
    if (levelRef.current === 1) return; // groups/rates can only be dropped at Level 2/3
    const groupRaw = event.dataTransfer.getData(DIMENSION_DRAG_MIME);
    const rateRaw = event.dataTransfer.getData(RATE_ITEM_DRAG_MIME);
    if (!groupRaw && !rateRaw) return;
    event.preventDefault();
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const td = (event.target as HTMLElement | null)?.closest("td");
    if (!td) return;
    const coords = hot.getCoords(td);
    if (!coords || coords.row < 0) return;

    if (groupRaw && coords.col === COL_QTY) {
      let payload: { groupId: number; name: string };
      try { payload = JSON.parse(groupRaw); } catch { return; }
      void handleGroupDrop(payload.groupId, payload.name, coords.row);
      return;
    }
    if (rateRaw && coords.col === COL_RATE) {
      let payload: { code: string; description: string; unit: string; rate: number };
      try { payload = JSON.parse(rateRaw); } catch { return; }
      applyRateImport(coords.row, payload);
    }
  }

  /** Right-click on a linked C:Quantity / D:Unit cell offers "Show dimension group". */
  /** Right-click on any cell offers "New Named Cell"; a linked C:Quantity / D:Unit
   *  cell additionally offers "Show dimension group". */
  /** Deletes rows `[from..to]` (inclusive), confirming first if any of them hold
   *  a real line item — deletion also permanently drops that row's sub-sheets. */
  function requestDeleteRows(hot: Handsontable, from: number, to: number) {
    const data = captureSourceData(hot);
    let hasContent = false;
    for (let r = from; r <= to; r++) { if (isLineItemRow(data[r])) { hasContent = true; break; } }
    if (hasContent) { setPendingDelete({ kind: "row", from, to }); return; }
    void withWorkbookActivity("Deleting row…", () => {
      const path = curSheetPath();
      for (let r = to; r >= from; r--) deleteRowAt(hot, path, r);
      scheduleSaveRef.current();
      hot.render();
    });
  }

  /** Deletes columns `[from..to]` (inclusive; both must be >= BASE_NUMERIC_COL_COUNT),
   *  confirming first if any of them hold data. */
  function requestDeleteCols(hot: Handsontable, from: number, to: number) {
    const data = captureSourceData(hot);
    let hasContent = false;
    outer:
    for (let c = from; c <= to; c++) {
      for (const row of data) { if (row[c] != null && row[c] !== "") { hasContent = true; break outer; } }
    }
    if (hasContent) { setPendingDelete({ kind: "col", from, to }); return; }
    void withWorkbookActivity("Deleting column…", () => {
      const path = curSheetPath();
      for (let c = to; c >= from; c--) deleteColAt(hot, path, c);
      scheduleSaveRef.current();
      hot.render();
    });
  }

  function handleGridContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const cellEl = (event.target as HTMLElement | null)?.closest("td, th");
    if (!cellEl) return;
    const coords = hot.getCoords(cellEl);
    if (!coords) return;
    const isRowHeader = coords.col < 0 && coords.row >= 0;
    const isColHeader = coords.row < 0 && coords.col >= 0;
    const isCell = coords.row >= 0 && coords.col >= 0;
    if (!isRowHeader && !isColHeader && !isCell) return;
    event.preventDefault();

    const path = curSheetPath();
    const items: ContextMenuEntry[] = [];

    if (isRowHeader) hot.selectRows(coords.row);
    if (isColHeader) hot.selectColumns(coords.col);
    if (isCell) {
      // Right-clicking outside the live selection collapses it to just this cell
      // (Excel/Sheets convention) — a click inside a multi-cell selection leaves
      // it alone so row/col-range actions below still act on the whole range.
      const ranges = hot.getSelectedRange();
      const inSelection = ranges?.some(r => {
        const fromRow = Math.min(r.from.row, r.to.row), toRow = Math.max(r.from.row, r.to.row);
        const fromCol = Math.min(r.from.col, r.to.col), toCol = Math.max(r.from.col, r.to.col);
        return coords.row >= fromRow && coords.row <= toRow && coords.col >= fromCol && coords.col <= toCol;
      });
      if (!inSelection) hot.selectCell(coords.row, coords.col);

      // Cut/Copy/Paste/Delete always come first, at a fixed position, on
      // purpose: the items below (Show dimension group / Project Total /
      // etc.) only appear for some cells, and having them ABOVE the clipboard
      // block meant its row position shifted depending on which cell was
      // clicked — muscle-memory clicking "where Paste was last time" would
      // then land on whatever variable-position item took its place (usually
      // Delete, immediately below it). Keeping this block first makes its
      // position depend only on the menu being open, never on cell content.
      // Kick off the (retrying) clipboard read now, at menu-open time, so it's
      // almost always already resolved by the time the user clicks Paste —
      // Paste's handler below reads whichever settles first: the prefetch, or
      // (if the user clicks faster than that) its own fresh retrying read.
      pendingPasteTextRef.current = null;
      void readClipboardWithRetry().then(text => { pendingPasteTextRef.current = text; });

      items.push({ label: "Cut", action: () => (hot.getPlugin("copyPaste") as unknown as { cut: () => void }).cut() });
      // "Copy Values" is Handsontable's default copy — it copies the COMPUTED cell
      // values (getData, resolved through the formulas plugin). "Copy Formula" copies
      // the underlying SOURCE (getSourceDataAtCell), so a formula cell yields its
      // "=…" text rather than the number it currently evaluates to — the estimator can
      // paste a live formula elsewhere instead of a frozen result. Written straight to
      // the OS clipboard as a TSV block via the Tauri clipboard plugin (same cross-
      // process path readClipboardWithRetry reads back), so it round-trips into Excel.
      items.push({ label: "Copy Values", action: () => (hot.getPlugin("copyPaste") as unknown as { copy: () => void }).copy() });
      items.push({
        label: "Copy Formula",
        action: () => {
          // Copy Formula writes straight to the OS clipboard (see copySelectionFormulas)
          // rather than going through Handsontable's own copyPaste plugin, so its
          // *afterCopy* hook never fires — without this, a subsequent paste's
          // drill-column clone-on-paste and formula-reference shift (afterPaste,
          // which reads lastRateCopyRef) would have no idea what was copied from
          // where, and silently no-op. Recorded here instead, from the same selection
          // copySelectionFormulas itself copies.
          const box = selectionBoundingBox(hot);
          if (box) {
            lastRateCopyRef.current = {
              path: curSheetPath(),
              level: levelRef.current,
              startRow: box.fromRow,
              startCol: box.fromCol,
              rowCount: box.toRow - box.fromRow + 1,
              colCount: box.toCol - box.fromCol + 1,
            };
          }
          void copySelectionFormulas(hot);
        },
      });
      items.push({
        label: "Paste",
        action: () => {
          const cp = hot.getPlugin("copyPaste") as unknown as { paste: (text?: string) => void };
          // Unlike copy()/cut() — which set an internal isTriggeredBy* flag that
          // bypasses the focus check — paste() routes straight into onPaste,
          // which silently drops the event unless `hot.isListening()`. Clicking
          // this menu (a portal outside the grid) leaves the grid unlistened,
          // so re-arm it first or the paste is discarded without any error.
          const doPaste = (text: string) => { hot.listen(); cp.paste(text); };
          if (pendingPasteTextRef.current != null) {
            doPaste(pendingPasteTextRef.current);
          } else {
            void readClipboardWithRetry().then(doPaste);
          }
        },
      });
      items.push({ label: "Delete", action: () => hot.emptySelectedCells() });
      items.push({ separator: true });

      if (coords.col === COL_QTY || coords.col === COL_UNIT) {
        const link = getCellLink(path, coords.row, COL_QTY);
        if (link) {
          items.push({
            label: "Show dimension group",
            action: () => { void goToDimensionGroup(link.groupId); },
          });
        }
      }
      items.push({
        label: "New Named Cell…",
        action: () => setNamedCellDialog({ row: coords.row, col: coords.col }),
      });

      // L1's H:Total column is where a workbook author designates the single cell
      // that holds the project grand total. Bound via the reserved "PROJECT_TOTAL"
      // named cell so it can be read back without the workbook being open.
      if (path === "L1" && coords.col === COL_TOTAL) {
        const pt = namedCellMap.current.get(PROJECT_TOTAL_NAME);
        const isCurrent = pt?.row === coords.row && pt?.col === coords.col;
        items.push({
          label: isCurrent ? "Project Total ✓" : "Set as Project Total",
          action: () => { void defineNamedCell(PROJECT_TOTAL_NAME, "L1", coords.row, coords.col); },
        });
      }

      // "Exclude/re-enable auto-calculation" — operates on the live selection.
      const targetCells = getSelectedCells();
      const allExcluded = targetCells.every(({ row, col }) => isCellExcluded(path, row, col));
      items.push({
        label: allExcluded ? "Re-enable auto-calculation" : "Exclude from auto-calculation",
        action: () => toggleExclusionForSelection(!allExcluded),
      });
    }

    // Row insert/delete — available from a cell click (acts on the selected row
    // range, falling back to the clicked row) or a row-header click.
    if (isCell || isRowHeader) {
      const rows = getSelectedCells().map(c => c.row);
      const fromRow = rows.length > 0 ? Math.min(...rows) : coords.row;
      const toRow   = rows.length > 0 ? Math.max(...rows) : coords.row;
      items.push({ separator: true });
      items.push({ label: "Insert Row Above", action: () => gridApiImplRef.current.insertAbove() });
      items.push({ label: "Insert Row Below", action: () => gridApiImplRef.current.insertBelow() });
      items.push({ label: "Delete Row", danger: true, action: () => requestDeleteRows(hot, fromRow, toRow) });
    }

    // Column insert/delete — disabled within A–P (fixed structural columns; see
    // BASE_NUMERIC_COL_COUNT / the derivation matrix in CLAUDE.md).
    if (isCell || isColHeader) {
      const col = coords.col;
      const disabled = col < BASE_NUMERIC_COL_COUNT;
      items.push({ separator: true });
      items.push({
        label: "Insert Column Left", disabled,
        action: () => void withWorkbookActivity("Inserting column…", () => insertBlankColAt(hot, path, col)),
      });
      items.push({
        label: "Insert Column Right", disabled,
        action: () => void withWorkbookActivity("Inserting column…", () => insertBlankColAt(hot, path, col + 1)),
      });
      items.push({
        label: "Delete Column", danger: !disabled, disabled,
        action: () => requestDeleteCols(hot, col, col),
      });
    }

    setGridContextMenu({ x: event.clientX, y: event.clientY, items });
  }

  /** Cells covered by the live selection, falling back to the last-known cell. */
  function getSelectedCells(): Array<{ row: number; col: number }> {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return lastSelectedCellRef.current ? [lastSelectedCellRef.current] : [];
    const ranges = hot.getSelectedRange();
    if (!ranges || ranges.length === 0) {
      return lastSelectedCellRef.current ? [lastSelectedCellRef.current] : [];
    }
    const cells: Array<{ row: number; col: number }> = [];
    for (const range of ranges) {
      const fromRow = Math.max(0, Math.min(range.from.row, range.to.row));
      const toRow   = Math.max(range.from.row, range.to.row);
      const fromCol = Math.max(0, Math.min(range.from.col, range.to.col));
      const toCol   = Math.max(range.from.col, range.to.col);
      for (let r = fromRow; r <= toRow; r++) {
        for (let c = fromCol; c <= toCol; c++) cells.push({ row: r, col: c });
      }
    }
    return cells;
  }

  /** Applies `mutator` to every selected cell's style and re-renders the grid. */
  function applyToSelection(mutator: (style: CellStyle) => CellStyle) {
    const hot = hotRef.current?.hotInstance;
    const cells = getSelectedCells();
    if (!hot || cells.length === 0) return;
    const path = curSheetPath();
    let map = cellStyleMap.current.get(path);
    if (!map) { map = new Map(); cellStyleMap.current.set(path, map); }
    for (const { row, col } of cells) {
      const key = styleKey(row, col);
      const next = mutator(map.get(key) ?? {});
      if (Object.keys(next).length === 0) map.delete(key);
      else map.set(key, next);
    }
    hot.render();
    syncFormatSnapshot();

    const revId = revIdRef.current;
    if (revId != null) persistSheet(revId, path, sheetDataMap.current.get(path) ?? captureSourceData(hot));
  }

  /** Publishes the active cell's effective format to the store for the ribbon's Format toolbar. */
  function syncFormatSnapshot() {
    const cell = lastSelectedCellRef.current;
    if (!cell) {
      setWorkbookFormat({ ...DEFAULT_WORKBOOK_FORMAT, enabled: false });
      return;
    }
    const style = getCellStyle(cell.row, cell.col);
    const drill = isDrillColumn(curSheetPath(), cell.col);
    setWorkbookFormat({
      enabled: true,
      fontFamily: style.fontFamily ?? DEFAULT_WORKBOOK_FORMAT.fontFamily,
      fontSize: style.fontSize ?? DEFAULT_WORKBOOK_FORMAT.fontSize,
      bold: !!style.bold,
      italic: !!style.italic,
      underline: !!style.underline,
      align: style.align ?? (drill ? "right" : NUMERIC_COLS.has(cell.col) ? "right" : "left"),
      decimals: style.decimals ?? DEFAULT_WORKBOOK_FORMAT.decimals,
    });
  }

  // Stable imperative API the ribbon's Format toolbar drives — registered once
  // (it only ever touches refs / the selection, never component state directly).
  const formatApiRef = useRef<WorkbookFormatApi>({
    setFontFamily: (family) => applyToSelection(s => ({ ...s, fontFamily: family })),
    setFontSize:   (size)   => applyToSelection(s => ({ ...s, fontSize: size })),
    toggleBold:      () => applyToSelection(s => ({ ...s, bold: !s.bold })),
    toggleItalic:    () => applyToSelection(s => ({ ...s, italic: !s.italic })),
    toggleUnderline: () => applyToSelection(s => ({ ...s, underline: !s.underline })),
    setAlign: (align) => applyToSelection(s => ({ ...s, align })),
    adjustDecimals: (delta) => applyToSelection(s => {
      const cur = s.decimals ?? DEFAULT_WORKBOOK_FORMAT.decimals;
      return { ...s, decimals: Math.max(0, Math.min(6, cur + delta)) };
    }),
  });

  useEffect(() => {
    setWorkbookFormatApi(formatApiRef.current);
    return () => setWorkbookFormatApi(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable grid API exposed to the ribbon for row operations and output actions.
  // Implementation is kept in gridApiImplRef (updated each render) so closures
  // always see the latest captureSourceData / insertBlankRowAt / etc. The
  // stable ref itself just delegates, matching the scheduleSaveRef pattern.
  const gridApiImplRef = useRef({
    addRow: () => {},
    insertAbove: () => {},
    insertBelow: () => {},
    exportExcel: async (_levels: FlattenExportLevels) => {},
    print: () => {},
    recalculate: async () => {},
  });

  const gridApiRef = useRef<WorkbookGridApi>({
    addRow:       () => gridApiImplRef.current.addRow(),
    insertAbove:  () => gridApiImplRef.current.insertAbove(),
    insertBelow:  () => gridApiImplRef.current.insertBelow(),
    exportExcel:  (levels) => gridApiImplRef.current.exportExcel(levels),
    print:        () => gridApiImplRef.current.print(),
    recalculate:  () => gridApiImplRef.current.recalculate(),
  });

  useEffect(() => {
    setWorkbookGridApi(gridApiRef.current);
    return () => setWorkbookGridApi(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable refs so Handsontable hooks don't capture stale values
  const levelRef      = useRef<Level>(1);
  levelRef.current    = level;

  const drillDownRef = useRef<(row: number, col: number) => void>(() => {});
  const drillUpRef   = useRef<() => void>(() => {});

  // Guard flag — prevents Level-3 auto-derivation from re-entering itself
  const isAutoUpdatingRef = useRef(false);

  // Debounce timer for auto-save
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── SQLite persistence helpers ─────────────────────────────────────────

  /** Persist one sheet immediately (fire-and-forget — failures are silent). Links/styles/
   *  exclusions are each saved only if THIS path's copy has actually been loaded from the DB
   *  (loadedLinkPathsRef/loadedStylePathsRef/loadedExclusionPathsRef) — cellLinkMap.get(path)
   *  etc. read `undefined` for a path that simply hasn't loaded yet, indistinguishable from a
   *  path that has genuinely no links/styles/exclusions. Saving unconditionally (as this used
   *  to) meant a data-edit save firing before one of those three independent async loads had
   *  finished — e.g. syncSheetLinks can itself trigger a save via refreshLinkedCells the moment
   *  links finish loading, with no guarantee styles/exclusions are done yet — silently wrote an
   *  empty `{}` over the real persisted value, permanently deleting it. This is what wiped a
   *  revision's excluded-cell set on disk. */
  function persistSheet(revisionId: number, path: string, data: (string | null)[][]) {
    const links = cellLinkMap.current.get(path);
    const styles = cellStyleMap.current.get(path);
    const excl = cellExclusionMap.current.get(path);
    // One transaction for all four blobs; an unloaded blob is sent as null so the backend leaves it alone.
    wbWrite("save_workbook_sheet_bundle", {
      revisionId,
      sheetPath: path,
      dataJson: JSON.stringify(trimSheetForStorage(data)),
      linksJson: loadedLinkPathsRef.current.has(path)
        ? JSON.stringify(links ? Object.fromEntries(links) : {}) : null,
      stylesJson: loadedStylePathsRef.current.has(path)
        ? JSON.stringify(styles ? Object.fromEntries(styles) : {}) : null,
      exclusionsJson: loadedExclusionPathsRef.current.has(path)
        ? JSON.stringify(excl ? Object.fromEntries(Array.from(excl, k => [k, true])) : {}) : null,
    });
  }

  /**
   * Extract source data from Handsontable as a string[][] for persistence.
   * Uses getSourceData() so formula strings are stored rather than computed values.
   */
  function captureSourceData(hot: Handsontable): (string | null)[][] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = hot.getSourceData() as any[][];
    const cols = hot.countCols();
    const result = createEmptyData(cols);
    for (let r = 0; r < Math.min(raw.length, NUM_ROWS); r++) {
      const row = raw[r] ?? [];
      for (let c = 0; c < Math.min(row.length, cols); c++) {
        const cell = row[c];
        result[r][c] = (cell != null && cell !== "") ? String(cell) : null;
      }
    }
    return result;
  }

  /** Grows the shared row bound to `targetRows` (a no-op if already that big or
   *  bigger): adds the extra rows to the live grid and re-pads every sheet already
   *  cached in `sheetDataMap.current` to match, so no cached array falls out of sync
   *  with the many `0..NUM_ROWS` loops elsewhere in this file. */
  function growRowsTo(hot: Handsontable, targetRows: number): void {
    if (targetRows <= NUM_ROWS) return;
    const additional = targetRows - NUM_ROWS;
    const insertAfter = NUM_ROWS - 1;
    NUM_ROWS = targetRows;
    hot.alter("insert_row_below", insertAfter, additional);
    for (const [path, data] of sheetDataMap.current) {
      if (data.length < NUM_ROWS) sheetDataMap.current.set(path, padRowsTo(data, NUM_ROWS));
    }
  }

  /** Grows *only the currently displayed sheet's* column count to `targetCols` (a
   *  no-op if it's already that wide): adds the extra columns to the live grid
   *  (with computed double-letter headers/widths past Z) and widens that one
   *  sheet's cached data to match. Deliberately scoped to the current path — unlike
   *  `growRowsTo` (rows are a shared bound across every sheet), widening one sheet
   *  (e.g. a Level 1 trade summary) must never widen any other sheet or a different
   *  workbook revision. */
  function growColsTo(hot: Handsontable, targetCols: number): void {
    const curCols = hot.countCols();
    if (targetCols <= curCols) return;
    const insertAfter = curCols - 1;
    hot.alter("insert_col_end", insertAfter, targetCols - curCols);
    const path = curSheetPath();
    const kind = sheetKindForPath(path);
    const base = layoutColumnsFor(kind);
    hot.updateSettings({
      colHeaders: buildColHeaders(base, targetCols),
      colWidths:  buildColWidths(base, targetCols),
    });
    const cached = sheetDataMap.current.get(path);
    if (cached && (cached[0]?.length ?? 0) < targetCols) {
      sheetDataMap.current.set(path, padColsTo(cached, targetCols));
    }
  }

  /** Persist the displayed sheet now if an autosave is still waiting on its debounce. Saves to the
   *  revision the grid is actually SHOWING (`displayedRevIdRef`), never `revIdRef`: that jumps to a
   *  newly-selected revision immediately, while the grid keeps showing the old revision's sheet
   *  until the switch finishes loading — saving by `revIdRef` in that window wrote the old
   *  revision's sheet over the new revision's L1. */
  function flushPendingSave() {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const revId = displayedRevIdRef.current;
    const hot = hotRef.current?.hotInstance;
    if (revId == null || !hot || hot.isDestroyed) return;
    const curPath = pathStack.current[pathStack.current.length - 1];
    const data = captureSourceData(hot);
    sheetDataMap.current.set(curPath, data);
    persistSheet(revId, curPath, data);
  }
  const flushPendingSaveRef = useRef(flushPendingSave);
  flushPendingSaveRef.current = flushPendingSave;

  // Report failed workbook writes in the footer, let project close/open flush a pending autosave,
  // and flush before the app window closes. A layout effect so its cleanup (flush on unmount) runs
  // before the grid's own teardown destroys the Handsontable instance it reads from.
  useLayoutEffect(() => {
    setWorkbookDbErrorHandler(msg => useAppStore.getState().setWorkbookSaveError(msg));
    setWorkbookFlushHook(() => flushPendingSaveRef.current());
    let unlistenClose: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested(async () => { await flushWorkbookWrites(); })
      .then(unlisten => { if (disposed) unlisten(); else unlistenClose = unlisten; })
      .catch(err => console.error("Could not register workbook close flush:", err));
    return () => {
      disposed = true;
      unlistenClose?.();
      flushPendingSaveRef.current();
      setWorkbookFlushHook(null);
      setWorkbookDbErrorHandler(null);
    };
  }, []);

  /** Schedule a debounced auto-save of the current sheet. */
  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => flushPendingSaveRef.current(), 500);
  }

  // Expose scheduleSave in a ref so the memoised hotSettings closure can reach it
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  // ── Grid API implementations (updated each render so closures stay fresh) ─

  /** Drops every live engine sheet at `path` or beneath it (a deleted row's build-up sheets). */
  function removeEngineSubtree(hot: Handsontable, path: string): void {
    const engine = getFormulasPlugin(hot)?.engine;
    if (!engine) return;
    const prefix = `${path}/`;
    for (const name of engine.getSheetNames() as string[]) {
      const p = sheetNameToPath(name);
      if (p !== path && !p.startsWith(prefix)) continue;
      try { engine.removeSheet(engine.getSheetId(name)); } catch { /* already gone */ }
    }
  }

  /**
   * Moves the drilled sub-sheets (/S, /R, /Q and all their descendants) of rows `[lo..hi]` on cost
   * sheet `path` by `delta` rows — in the live engine, the in-memory caches, the named-cell map and
   * the database — after first dropping `deletePaths` (a deleted row's own sub-sheets). Must run
   * BEFORE the rows themselves move, so the retargeted rollup formulas land on sheets that already
   * hold the right content.
   *
   * The database side is ONE atomic `shift_workbook_subtrees` command, queued behind every earlier
   * write. It used to be one fire-and-forget rename per row (plus a separate delete), which could
   * execute out of order: a delete landing after the next row's rename deleted the wrong build-up,
   * and a rename colliding with a not-yet-moved row failed silently, leaving it behind.
   */
  function moveRowSubtrees(
    hot: Handsontable, path: string, lo: number, hi: number, delta: number, deletePaths: string[],
  ): void {
    const prefixes = isCostSheetPath(path) ? ["S", "R", "Q"] : []; // M5: only cost sheets have children
    if (prefixes.length === 0) return;

    for (const p of deletePaths) {
      purgeCachedSubtree(p);
      removeEngineSubtree(hot, p);
    }

    if (hi >= lo) {
      // One scan of the engine's sheet names and each cache, not one scan per shifted row — see
      // planSubtreeRenames' doc comment.
      let engineNames: string[] = [];
      try { engineNames = (getFormulasPlugin(hot)?.engine?.getSheetNames() as string[]) ?? []; } catch { /* no engine yet */ }
      const engineRenames = planSubtreeRenames(engineNames.map(sheetNameToPath), path, prefixes, lo, hi, delta);
      // Move into an already-vacated slot first: highest row first going down, lowest going up.
      engineRenames.sort((a, b) => (delta > 0 ? b.row - a.row : a.row - b.row));
      applySubtreeRenamesToEngine(hot, engineRenames);

      const plan = (keys: Iterable<string>) => planSubtreeRenames(keys, path, prefixes, lo, hi, delta);
      applySubtreeRenamesToMap(sheetDataMap.current, plan(sheetDataMap.current.keys()), retargetSheetData);
      applySubtreeRenamesToMap(sheetComputedMap.current, plan(sheetComputedMap.current.keys()));
      applySubtreeRenamesToMap(cellLinkMap.current, plan(cellLinkMap.current.keys()));
      applySubtreeRenamesToMap(cellStyleMap.current, plan(cellStyleMap.current.keys()));
      applySubtreeRenamesToMap(cellExclusionMap.current, plan(cellExclusionMap.current.keys()));
      applySubtreeRenamesToSet(loadedLinkPathsRef.current, plan(loadedLinkPathsRef.current));
      applySubtreeRenamesToSet(loadedStylePathsRef.current, plan(loadedStylePathsRef.current));
      applySubtreeRenamesToSet(loadedExclusionPathsRef.current, plan(loadedExclusionPathsRef.current));
      // Named cells bound directly to a relocated sub-sheet follow it (scanned off the map's own
      // paths — a name can be bound to a sub-sheet this session hasn't drilled into yet). The DB
      // side is covered by shift_workbook_subtrees below.
      applySubtreeRenamesToNamedCells(
        namedCellMap.current,
        plan(Array.from(namedCellMap.current.values(), nc => nc.path)),
        registerNamedExpression,
      );
    }

    const revId = revIdRef.current;
    if (revId != null && (hi >= lo || deletePaths.length > 0)) {
      wbWrite("shift_workbook_subtrees", {
        revisionId: revId, ownerPath: path, prefixes, loRow: lo, hiRow: hi, delta, deletePaths,
      });
    }
  }

  /** Re-points every XSUM* rollup in rows `[from..to]` of the displayed sheet at the child sheet of
   *  the row it now sits on. A native row insert/delete shifts ordinary cell references for us, but
   *  a rollup names its child sheet by the row it was drilled from (`L1_sS5!…`), so a moved row's
   *  rollup must be rebuilt from its new position — the same toStored round-trip `beforeChange`
   *  applies to a typed or pasted rollup. */
  function retargetRollupRows(hot: Handsontable, path: string, from: number, to: number): void {
    const cols = hot.countCols();
    const writes: Array<[number, number, string]> = [];
    for (let r = Math.max(0, from); r <= to; r++) {
      for (let c = 0; c < cols; c++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = (hot as any).getSourceDataAtCell(r, c);
        if (typeof src !== "string" || src.charAt(0) !== "=" || !/XSUM/i.test(src)) continue;
        const stored = xsumToStored(xsumToDisplay(src), path, r);
        if (stored !== src) writes.push([r, c, stored]);
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (writes.length) hot.setDataAtCell(writes as any);
  }

  /** A native row insert/delete on `path` makes HyperFormula rewrite references to it in OTHER
   *  sheets too (e.g. a hand-typed cross-sheet reference). Only the edited sheet
   *  goes through autosave, so persist every other sheet whose formulas mention it and whose engine
   *  content no longer matches its cached copy — otherwise the file keeps the pre-shift text and
   *  the workbook recalculates differently after a reopen than it did in the session. */
  function persistSheetsReferencing(hot: Handsontable, path: string): void {
    const engine = getFormulasPlugin(hot)?.engine;
    const revId = revIdRef.current;
    if (!engine || revId == null) return;
    const needle = `${pathToSheetName(path)}!`;
    for (const [otherPath, cached] of sheetDataMap.current) {
      if (otherPath === path) continue;
      if (!cached.some(row => row.some(cell => typeof cell === "string" && cell.includes(needle)))) continue;
      const name = pathToSheetName(otherPath);
      if (!engine.doesSheetExist(name)) continue;
      const serialized = engine.getSheetSerialized(engine.getSheetId(name)) as unknown[][];
      let changed = false;
      const next = cached.map((row, r) => row.map((cell, c) => {
        const v = serialized[r]?.[c];
        const text = v == null || v === "" ? null : String(v);
        if (text !== cell) changed = true;
        return text;
      }));
      if (!changed) continue;
      sheetDataMap.current.set(otherPath, next);
      persistSheet(revId, otherPath, next);
    }
  }

  /**
   * Insert a blank row at `insertAt`, shifting every row below it down by one.
   *
   * Done as a NATIVE grid row insert, so HyperFormula adjusts every reference to the moved rows —
   * on this sheet, on every other sheet, and in named expressions — and grows any range spanning
   * the insert point, exactly as Excel does. (This used to copy cell text down a row by hand and
   * only renumber a formula's references to its own row, so a total like `=SUM(H1:H20)`, a
   * reference from another row, or one from another sheet kept pointing at the old row numbers and
   * totals silently went wrong.) The grid's bottom row is trimmed afterwards to keep the shared
   * row count; if that row holds content the grid is grown first so nothing falls off.
   */
  function insertBlankRowAt(hot: Handsontable, path: string, insertAt: number): void {
    let data = captureSourceData(hot);
    if (isLineItemRow(data[NUM_ROWS - 1])) {
      growRowsTo(hot, NUM_ROWS + ROW_GROWTH_CHUNK);
      data = captureSourceData(hot);
    }
    const cols = hot.countCols();
    let lastOccupied = -1;
    for (let r = NUM_ROWS - 1; r >= insertAt; r--) {
      if (isLineItemRow(data[r])) { lastOccupied = r; break; }
    }

    if (lastOccupied >= insertAt) moveRowSubtrees(hot, path, insertAt, lastOccupied, 1, []);

    isAutoUpdatingRef.current = true;
    try {
      hot.alter("insert_row_above", insertAt, 1);
      hot.alter("remove_row", hot.countRows() - 1, 1); // trim back to the shared row count
      if (lastOccupied >= insertAt) retargetRollupRows(hot, path, insertAt + 1, lastOccupied + 1);
      persistSheetsReferencing(hot, path);
    } finally {
      isAutoUpdatingRef.current = false;
    }

    // Shift any named cells bound to this sheet at or below the insertion point,
    // so they keep pointing at the same logical row of content (Excel-style).
    for (const nc of namedCellMap.current.values()) {
      if (nc.path !== path || nc.row < insertAt) continue;
      if (nc.row + 1 > NUM_ROWS - 1) continue;
      nc.row += 1;
      registerNamedExpression(nc);
      const revId = revIdRef.current;
      if (revId != null) {
        wbWrite("save_workbook_named_cell", {
          revisionId: revId, name: nc.name, sheetPath: nc.path, row: nc.row, col: nc.col,
        });
      }
    }

    if (lastOccupied >= insertAt) {
      shiftRowKeyedEntries(cellLinkMap.current.get(path), insertAt, lastOccupied + 1, 1, cols);
      shiftRowKeyedEntries(cellStyleMap.current.get(path), insertAt, lastOccupied + 1, 1, cols);
      shiftRowKeyedSet(cellExclusionMap.current.get(path), insertAt, lastOccupied + 1, 1, cols);
    }

    // Regenerate row-relative formula cells for the band that moved (each row's F/G/H depends
    // solely on its own C/E, never a neighbour's).
    deriveLevelFormulas(
      hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), path, cellExclusionMap.current.get(path),
      { from: insertAt, to: Math.min(Math.max(insertAt, lastOccupied + 1), NUM_ROWS - 1) },
    );
    scheduleSaveRef.current();
  }

  /**
   * Delete the row at `deleteAt`, shifting every row below it up by one — the mirror image of
   * `insertBlankRowAt`, and likewise a native grid operation so every reference follows (a
   * reference to the deleted row itself becomes #REF!, as in Excel). The deleted row's own
   * sub-sheets are permanently removed; callers confirm with the user first when the row holds
   * real content (see handleGridContextMenu).
   */
  function deleteRowAt(hot: Handsontable, path: string, deleteAt: number): void {
    const data = captureSourceData(hot);
    const cols = hot.countCols();
    let lastOccupied = -1;
    for (let r = NUM_ROWS - 1; r >= deleteAt; r--) {
      if (isLineItemRow(data[r])) { lastOccupied = r; break; }
    }

    const deletePaths = isCostSheetPath(path) ? ["S", "R", "Q"].map(p => `${path}/${p}${deleteAt}`) : [];
    moveRowSubtrees(hot, path, deleteAt + 1, lastOccupied, -1, deletePaths);

    // Drop this row's own link/style/exclusion entries — the row is gone, not shifted.
    const linkMap  = cellLinkMap.current.get(path);
    const styleMap = cellStyleMap.current.get(path);
    const exclSet  = cellExclusionMap.current.get(path);
    for (let c = 0; c < cols; c++) {
      linkMap?.delete(styleKey(deleteAt, c));
      styleMap?.delete(styleKey(deleteAt, c));
      exclSet?.delete(styleKey(deleteAt, c));
    }

    isAutoUpdatingRef.current = true;
    try {
      hot.alter("remove_row", deleteAt, 1);
      hot.alter("insert_row_below", hot.countRows() - 1, 1); // pad back to the shared row count
      if (lastOccupied > deleteAt) retargetRollupRows(hot, path, deleteAt, lastOccupied - 1);
      persistSheetsReferencing(hot, path);
    } finally {
      isAutoUpdatingRef.current = false;
    }

    // Named cells bound to the deleted row are gone; ones below shift up by one.
    const revId = revIdRef.current;
    for (const nc of Array.from(namedCellMap.current.values())) {
      if (nc.path !== path) continue;
      if (nc.row === deleteAt) { void removeNamedCell(nc.name); continue; }
      if (nc.row < deleteAt) continue;
      nc.row -= 1;
      registerNamedExpression(nc);
      if (revId != null) {
        wbWrite("save_workbook_named_cell", {
          revisionId: revId, name: nc.name, sheetPath: nc.path, row: nc.row, col: nc.col,
        });
      }
    }

    if (lastOccupied >= deleteAt) {
      shiftRowKeyedEntries(cellLinkMap.current.get(path), deleteAt + 1, lastOccupied + 1, -1, cols);
      shiftRowKeyedEntries(cellStyleMap.current.get(path), deleteAt + 1, lastOccupied + 1, -1, cols);
      shiftRowKeyedSet(cellExclusionMap.current.get(path), deleteAt + 1, lastOccupied + 1, -1, cols);
    }

    // See insertBlankRowAt's matching comment — narrow the rescan to the band that actually moved.
    deriveLevelFormulas(
      hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), path, cellExclusionMap.current.get(path),
      { from: deleteAt, to: Math.max(deleteAt, lastOccupied) },
    );
    scheduleSaveRef.current();
  }

  /** Re-applies this sheet's column headers/widths after a column insert/delete changed its count. */
  function refreshColumnChrome(hot: Handsontable, path: string): void {
    const cols = hot.countCols();
    const base = layoutColumnsFor(sheetKindForPath(path));
    hot.updateSettings({ colHeaders: buildColHeaders(base, cols), colWidths: buildColWidths(base, cols) });
  }

  /**
   * Insert a blank column at `insertAt` (must be >= BASE_NUMERIC_COL_COUNT — A–P are structural
   * and never shift). A native grid column insert, so every formula referencing a moved column
   * follows it; the sheet grows by one column.
   */
  function insertBlankColAt(hot: Handsontable, path: string, insertAt: number): void {
    if (insertAt < BASE_NUMERIC_COL_COUNT) return;
    const rows = NUM_ROWS;

    isAutoUpdatingRef.current = true;
    try {
      hot.alter("insert_col_start", insertAt, 1);
    } finally {
      isAutoUpdatingRef.current = false;
    }
    refreshColumnChrome(hot, path);
    const cols = hot.countCols();
    sheetDataMap.current.set(path, captureSourceData(hot));

    for (const nc of namedCellMap.current.values()) {
      if (nc.path !== path || nc.col < insertAt) continue;
      nc.col += 1;
      registerNamedExpression(nc);
      const revId = revIdRef.current;
      if (revId != null) {
        wbWrite("save_workbook_named_cell", {
          revisionId: revId, name: nc.name, sheetPath: nc.path, row: nc.row, col: nc.col,
        });
      }
    }

    shiftColKeyedEntries(cellLinkMap.current.get(path), insertAt, cols - 1, 1, rows, cols);
    shiftColKeyedEntries(cellStyleMap.current.get(path), insertAt, cols - 1, 1, rows, cols);
    shiftColKeyedSet(cellExclusionMap.current.get(path), insertAt, cols - 1, 1, rows, cols);
    scheduleSaveRef.current();
  }

  /**
   * Delete the column at `deleteAt` (must be >= BASE_NUMERIC_COL_COUNT). A native grid column
   * delete (references follow; a reference to the deleted column becomes #REF!), with a blank
   * column re-added on the right so the sheet keeps its width.
   */
  function deleteColAt(hot: Handsontable, path: string, deleteAt: number): void {
    if (deleteAt < BASE_NUMERIC_COL_COUNT) return;
    const cols = hot.countCols();
    const rows = NUM_ROWS;

    const linkMap  = cellLinkMap.current.get(path);
    const styleMap = cellStyleMap.current.get(path);
    const exclSet  = cellExclusionMap.current.get(path);
    for (let r = 0; r < rows; r++) {
      linkMap?.delete(styleKey(r, deleteAt));
      styleMap?.delete(styleKey(r, deleteAt));
      exclSet?.delete(styleKey(r, deleteAt));
    }

    isAutoUpdatingRef.current = true;
    try {
      hot.alter("remove_col", deleteAt, 1);
      hot.alter("insert_col_end", cols - 2, 1);
    } finally {
      isAutoUpdatingRef.current = false;
    }
    refreshColumnChrome(hot, path);
    sheetDataMap.current.set(path, captureSourceData(hot));

    for (const nc of Array.from(namedCellMap.current.values())) {
      if (nc.path !== path) continue;
      if (nc.col === deleteAt) { void removeNamedCell(nc.name); continue; }
      if (nc.col < deleteAt) continue;
      nc.col -= 1;
      registerNamedExpression(nc);
      const revId = revIdRef.current;
      if (revId != null) {
        wbWrite("save_workbook_named_cell", {
          revisionId: revId, name: nc.name, sheetPath: nc.path, row: nc.row, col: nc.col,
        });
      }
    }

    shiftColKeyedEntries(cellLinkMap.current.get(path), deleteAt + 1, cols, -1, rows, cols);
    shiftColKeyedEntries(cellStyleMap.current.get(path), deleteAt + 1, cols, -1, rows, cols);
    shiftColKeyedSet(cellExclusionMap.current.get(path), deleteAt + 1, cols, -1, rows, cols);
    scheduleSaveRef.current();
  }

  /**
   * Appends the leaf line items of cost sheet `path` to `out`, recursing through every row whose
   * F:Subtotal is the rollup of its own cost sheet (/S) — so the export reaches every level, not
   * just L1 → L2. A row is expanded only when its Factor is 1 (or blank): its children's totals
   * then add up to the row's own, so replacing the row by them can't change the export's total.
   * A row with any other factor, a typed subtotal, or no line items beneath it is exported as one
   * line. Items below the first level carry their parents' descriptions (`prefix`, "A › B › ")
   * so a flattened item keeps its context.
   */
  async function collectLeafItems(
    path: string, sectionCode: string, sectionDesc: string, prefix: string, out: FlatExportRow[],
  ): Promise<void> {
    const hot = hotRef.current?.hotInstance;
    const revId = revIdRef.current;
    if (!hot || revId == null) return;
    const source = await fetchSheetSourceData(revId, path);
    const evaluated = engineSheetValues(hot, path);
    for (let r = 0; r < source.length; r++) {
      if (!isLineItemRow(source[r])) continue;
      const ev = evaluated[r] ?? [];
      const fSrc = source[r][COL_SUBTOTAL];
      const factor = numOrUndefined(ev[COL_FACTOR]);
      if (typeof fSrc === "string" && /XSUMTOT\s*\(/i.test(fSrc) && (factor == null || factor === 1)) {
        const before = out.length;
        const label = textOrBlank(ev[COL_DESC]);
        await collectLeafItems(`${path}/S${r}`, sectionCode, sectionDesc, label ? `${prefix}${label} › ` : prefix, out);
        if (out.length > before) continue;
      }
      const item = flatExportRowFrom(ev, sectionCode, sectionDesc);
      if (prefix) item.desc = `${prefix}${item.desc}`;
      out.push(item);
    }
  }

  gridApiImplRef.current = {
    addRow() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const data = captureSourceData(hot);
      let lastOccupied = -1;
      for (let r = NUM_ROWS - 1; r >= 0; r--) {
        if (isLineItemRow(data[r])) { lastOccupied = r; break; }
      }
      const targetRow = lastOccupied + 1;
      if (targetRow >= NUM_ROWS) growRowsTo(hot, NUM_ROWS + ROW_GROWTH_CHUNK);
      hot.selectCell(targetRow, COL_DESC);
      hot.scrollViewportTo(targetRow, COL_DESC, true, true);
    },

    insertAbove() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const selected = getSelectedCells();
      if (selected.length === 0) return;
      void withWorkbookActivity("Inserting row…", () => {
        insertBlankRowAt(hot, curSheetPath(), Math.min(...selected.map(c => c.row)));
        hot.selectCell(Math.min(...selected.map(c => c.row)), COL_DESC);
        scheduleSaveRef.current();
      });
    },

    insertBelow() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const selected = getSelectedCells();
      if (selected.length === 0) return;
      const insertAt = Math.max(...selected.map(c => c.row)) + 1;
      if (insertAt >= NUM_ROWS) growRowsTo(hot, NUM_ROWS + ROW_GROWTH_CHUNK);
      void withWorkbookActivity("Inserting row…", () => {
        insertBlankRowAt(hot, curSheetPath(), insertAt);
        hot.selectCell(insertAt, COL_DESC);
        scheduleSaveRef.current();
      });
    },

    async exportExcel(levels: FlattenExportLevels) {
      const hot = hotRef.current?.hotInstance;
      const revId = revIdRef.current;
      if (!hot || revId == null) return;

      // Persist the currently displayed sheet first so the export reflects its latest
      // edits, exactly as drillDown/drillUp do before swapping sheets.
      closeActiveEditor(hot);
      const curPath = pathStack.current[pathStack.current.length - 1];
      const curSourceData = captureSourceData(hot);
      sheetDataMap.current.set(curPath, curSourceData);
      persistSheet(revId, curPath, curSourceData);

      // Section (L1) + Item (L2) leading columns only make sense together — flattening
      // L2 items under their parent section. Selecting only one level means the output
      // rows ARE that level, with no separate grouping columns.
      const includeSectionCols = levels.l1 && levels.l2;

      // Values come from the live engine, which holds every sheet of the revision — so a rollup
      // (`=XSUMTOT(L1_sS3!…)`), a cross-sheet reference or a named cell (`=1+margin_pct/100`)
      // exports exactly the figure shown on screen. (This used to re-evaluate each sheet alone in a
      // throwaway engine, where every rollup's child sheet was missing: rolled-up Subtotals, Rates
      // and Quantities exported blank or wrong.)
      const l1Source = await fetchSheetSourceData(revId, "L1");
      const l1Evaluated = engineSheetValues(hot, "L1");

      const flatRows: FlatExportRow[] = [];
      for (let row = 0; row < NUM_ROWS; row++) {
        if (!isLineItemRow(l1Source[row])) continue;
        const sectionEval = l1Evaluated[row] ?? [];
        const sectionCode = textOrBlank(sectionEval[COL_CODE]);
        const sectionDesc = textOrBlank(sectionEval[COL_DESC]);

        if (!levels.l2) {
          flatRows.push(flatExportRowFrom(sectionEval, sectionCode, sectionDesc));
          continue;
        }

        // Every leaf line item beneath this section, at any depth (see collectLeafItems).
        const items: FlatExportRow[] = [];
        await collectLeafItems(`L1/S${row}`, sectionCode, sectionDesc, "", items);

        if (items.length === 0) {
          // No breakdown sheet — the section row itself is the leaf item.
          flatRows.push(flatExportRowFrom(sectionEval, sectionCode, sectionDesc));
          continue;
        }

        // With both levels selected, bracket each section's items with a header row
        // (the section name) and a footer row (its rolled-up totals) rather than only
        // relying on the repeated leading Section columns to show where it begins/ends.
        if (includeSectionCols) {
          flatRows.push({ sectionCode, sectionDesc, code: "", desc: "", unit: "", rowKind: "header" });
        }
        flatRows.push(...items);

        if (includeSectionCols) {
          // Subtotal = the section's own rolled-up Subtotal (from L1); Factor = the
          // section's own Factor (from L1); Total = the product of the two — per spec,
          // computed directly rather than trusting whatever Total happens to be stored.
          const subtotal = numOrUndefined(sectionEval[COL_SUBTOTAL]);
          const { factor } = deriveFactorTotal(subtotal, numOrUndefined(sectionEval[COL_FACTOR]), undefined);
          const total = subtotal != null ? subtotal * (factor ?? 0) : undefined;
          flatRows.push({
            sectionCode: "", sectionDesc: `Total of ${sectionDesc}`,
            code: "", desc: "", unit: "",
            subtotal, factor, total,
            lab: numOrUndefined(sectionEval[COL_LAB]), labTotal: numOrUndefined(sectionEval[COL_LAB_TOTAL]),
            mat: numOrUndefined(sectionEval[COL_MAT]), matTotal: numOrUndefined(sectionEval[COL_MAT_TOTAL]),
            sub: numOrUndefined(sectionEval[COL_SUB]), subTotal: numOrUndefined(sectionEval[COL_SUB_TOTAL]),
            sum: numOrUndefined(sectionEval[COL_SUM]), sumTotal: numOrUndefined(sectionEval[COL_SUM_TOTAL]),
            rowKind: "footer",
          });
        }
      }

      // The blended $/hr labour rate for the cost-code export's TOTAL Labour formula —
      // same resolution mechanism Factor formulas use for names like `margin_pct`.
      const labRate = levels.costCodes ? engineNamedNumber(hot, "lab_rate") : undefined;

      const filePath = await saveDialog({
        defaultPath: "workbook.xlsx",
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (!filePath) return;
      try {
        await invoke("export_workbook_excel", {
          path: filePath,
          payload: {
            includeSectionCols,
            includeCostCodes: levels.costCodes,
            labRate,
            rows: flatRows,
          },
        });
      } catch (err) {
        console.error("Export failed:", err);
      }
    },

    print() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const kind = sheetKindForPath(curSheetPath());
      const base = kind === "qty" ? QTY_COLUMNS : COLUMNS;
      const rawData: unknown[][] = getEvaluatedGridData(hot);

      const headers = buildColHeaders(base, hot.countCols());
      const headerCells = headers.map(h => `<th>${h}</th>`).join("");
      const dataRows = rawData
        .filter(row => row.some(cell => cell != null && cell !== ""))
        .map(row => {
          const cells = headers.map((_h, i) => {
            const val = row[i];
            const s = (val != null && val !== "") ? String(val) : "";
            return `<td>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td>`;
          }).join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");

      const html = `<!DOCTYPE html><html><head><title>Workbook</title><style>
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 12px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #bbb; padding: 2px 5px; white-space: nowrap; }
        th { background: #e8e8e8; font-weight: 600; }
        td { text-align: right; }
        td:first-child, td:nth-child(2), td:nth-child(4) { text-align: left; }
      </style></head><body>
        <table><thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>
      </body></html>`;

      const iframe = document.createElement("iframe");
      iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:none;";
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument ?? iframe.contentWindow?.document;
      if (!doc) { document.body.removeChild(iframe); return; }
      doc.open();
      doc.write(html);
      doc.close();
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* already gone */ } }, 1000);
    },

    async recalculate() {
      if (cleanupBusy) return;
      setCleanupBusy(true);
      try {
        await recalculateWorkbook();
        showCleanupMessage("Workbook recalculated.");
      } catch (e) {
        showCleanupMessage(`Failed to recalculate workbook: ${e}`);
      } finally {
        setCleanupBusy(false);
      }
    },
  };

  // ── Load root sheet when active revision changes ───────────────────────

  useEffect(() => {
    // Land any edit still waiting on the autosave debounce into the revision it was made in — the
    // grid still shows that revision's sheet at this point — then stop autosaving until the new
    // revision is on screen.
    flushPendingSaveRef.current();
    displayedRevIdRef.current = null;

    const revId = activeRevisionId;
    if (revId == null) return;

    setWorkbookLoading(true);
    setLoadProgress(null);


    // Guards against a stale/superseded switch: sheet names in the shared HyperFormula engine
    // are derived from path alone (no revision qualifier), so a second run of this effect for
    // the same or a different revision — StrictMode's intentional double-invoke in dev, or a
    // real second switch firing before the first finishes — would otherwise let two in-flight
    // runs interleave and overwrite each other's sheets/named-expressions, corrupting the
    // currently-displayed revision (e.g. a PROJECT_TOTAL that changes with no edit). `cancelled`
    // is flipped by the effect's cleanup, so a superseded run (same OR different revId) is
    // caught — the revId-only check below couldn't tell two runs of the same revision apart.
    let cancelled = false;
    const isStale = () => cancelled || revIdRef.current !== revId;

    // Resolve this revision's column layout (M2) BEFORE any sheet loads, so loadLevelData's
    // headers/widths reflect it. Read via getState() (not the `workbooks` closure) so this
    // stays keyed on activeRevisionId alone. NULL layout_json ⇒ the shipped default.
    const rev = useAppStore.getState().workbooks.flatMap(wb => wb.revisions).find(r => r.id === revId);
    activeLayout = parseLayout(rev?.layout_json ?? null);

    // Reset navigation state
    pathStack.current = ["L1"];
    setLevel(1);
    setBreadcrumb([]);
    setActiveCell("A1");
    setActiveCellValue("");
    setCompletions([]);
    cellLinkMap.current = new Map();
    loadedLinkPathsRef.current = new Set();
    cellStyleMap.current = new Map();
    loadedStylePathsRef.current = new Set();
    cellExclusionMap.current = new Map();
    loadedExclusionPathsRef.current = new Set();
    namedCellMap.current = new Map();
    registeredNamedExprRef.current = new Set();

    // Load the WHOLE revision into the multi-sheet engine at once (one round trip), so cross-sheet
    // rollup formulas and named-cell references resolve. Then display L1. Named cells are
    // registered AFTER the sheets exist, so each binds as a live cross-sheet reference.
    const displayL1 = async (map: Map<string, (string | null)[][]>) => {
      if (isStale()) return; // a newer switch has already taken over — don't clobber it
      sheetDataMap.current = map;
      const hot = hotRef.current?.hotInstance;
      if (hot) {
        await resetEngineSheets(
          hot,
          [...map].map(([path, data]) => ({ path, data })),
          (done, total) => setLoadProgress({ done, total }),
          isStale,
        );
        if (isStale()) return; // superseded mid-load — resetEngineSheets already bailed out
        setLoadProgress(null);
        loadLevelDataExcl(hot, map.get("L1")!, 1, isAutoUpdatingRef, "L1");
      }
      displayedRevIdRef.current = revId;
      syncSheetLinks("L1");
    };
    const registerNamedCells = () => {
      return wbRead<string>("load_workbook_named_cells", { revisionId: revId })
        .then(json => {
          if (isStale()) return; // a newer switch has already taken over — don't clobber it
          let entries: NamedCell[];
          try { entries = JSON.parse(json) as NamedCell[]; } catch { entries = []; }
          namedCellMap.current = new Map(entries.map(nc => [nc.name, nc]));
          for (const nc of entries) registerNamedExpression(nc);
          if (entries.length > 0) hotRef.current?.hotInstance?.render();
        })
        .catch(() => { /* non-fatal — workbook simply has no named cells yet */ });
    };

    wbRead<string>("load_workbook_all_sheets", { revisionId: revId })
      .then(async json => {
        let sheets: Array<{ path: string; data: (string | null)[][] }>;
        try { sheets = JSON.parse(json) as typeof sheets; } catch { sheets = []; }
        const map = new Map<string, (string | null)[][]>();
        for (const s of sheets) map.set(s.path, padData(Array.isArray(s.data) ? s.data : []));
        if (!map.has("L1")) map.set("L1", createEmptyData());
        await displayL1(map);
        return registerNamedCells();
      })
      .catch(async () => {
        await displayL1(new Map([["L1", createEmptyData()]]));
        return registerNamedCells();
      })
      .finally(() => {
        setLoadProgress(null);
        if (!isStale()) setWorkbookLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeRevisionId]);

  // Keep the breadcrumb trail scrolled to the bottom so the immediate parent (where you just
  // drilled from) stays visible when the trail is deeper than the visible area.
  useEffect(() => {
    const el = breadcrumbTrailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [breadcrumb.length]);

  // Track grid-container resize to drive Handsontable height
  useEffect(() => {
    const el = gridWrapperRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => setGridHeight(entries[0]?.contentRect.height ?? 400));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Push Handsontable height changes without recreating the settings object
  useEffect(() => {
    hotRef.current?.hotInstance?.updateSettings({ height: gridHeight });
  }, [gridHeight]);

  // ── drill-down navigation ──────────────────────────────────────────────

  /** Writes the drilled cell's own declarative rollup formula into the parent grid: A–H's
   *  F/E/C cell becomes `=XSUM…(child!<col>…)`, referencing the sub-sheet the drill just
   *  created/opened. This is the drill action's own, unavoidable side effect — there is no
   *  way to reference a child sheet before it exists — and nothing else. It does NOT touch
   *  any user column (I onward): those are never written by the app, only by a human typing
   *  into them or a row copy/paste carrying an existing formula along (see afterPaste).
   *  Explicit ranges (not volatile XSUM*) so a multi-level chain converges in one recalc.
   *  Skips excluded cells and dimension-linked C cells. Guarded by isAutoUpdatingRef so the
   *  afterChange derivation doesn't fight this write. */
  function writeRollupFormulasIntoGrid(hot: Handsontable, row: number, col: number, childPath: string, parentPath: string) {
    // Ensure the child sheet exists so the reference resolves immediately (no #REF flash).
    ensureEngineSheet(hot, childPath);
    // CostX-named XSUM over the child's whole column. The child range is an explicit argument so
    // HyperFormula orders the child's own formulas (F=E*C, H=F*G) BEFORE this rollup — required
    // for correctness. All XSUM* are ROUND(SUM(range), dp); the name documents intent.
    const xsum = (fn: string, c: number) => `=${fn}(${rollupRangeRef(childPath, c)})`;
    const writes: Array<[number, number, string]> = [];
    const put = (c: number, formula: string) => { if (!isCellExcluded(parentPath, row, c)) writes.push([row, c, formula]); };
    if (col === COL_SUBTOTAL) {
      put(COL_SUBTOTAL, xsum("XSUMTOT", COL_TOTAL));
    } else if (col === COL_RATE) {
      put(COL_RATE, xsum("XSUMRATE", COL_TOTAL));
    } else if (col === COL_QTY) {
      if (getCellLink(parentPath, row, COL_QTY)) return; // dimension-linked: keep the live import
      put(COL_QTY, xsum("XSUMQTY", COL_TOTAL));
    }
    if (!writes.length) return;
    const prev = isAutoUpdatingRef.current;
    isAutoUpdatingRef.current = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { hot.setDataAtCell(writes as any); } finally { isAutoUpdatingRef.current = prev; }
  }

  const drillDown = useCallback((row: number, col: number) => {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;

    // Close any editor left open by the double-click that triggered this drill before
    // we capture/persist the current sheet or swap in the new one — see closeActiveEditor.
    closeActiveEditor(hot);

    // Cancel any pending debounced save so it doesn't fire on the wrong path
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    const curPath = pathStack.current[pathStack.current.length - 1];
    // M5 drill suffix by column: F:Subtotal → recursive COST sheet (/S); E:Rate → RATE build-up
    // leaf (/R); C:Quantity → QTY build-up leaf (/Q). Distinct suffixes let one cost row carry a
    // cost child AND a rate child AND a qty child (as CostX does), and make XSUMUSER (reads /S)
    // genuinely differ from XSUMRATEUSER (reads /R).
    const drillSuffix = col === COL_QTY ? "Q" : col === COL_RATE ? "R" : "S";
    const isQtyDrill = drillSuffix === "Q";
    const newPath = `${curPath}/${drillSuffix}${row}`;

    // Declarative rollup: the drilled cell holds a live SUM of its child sheet's column, so the
    // parent tracks the child with no baking on drill-up. Written into the grid (guarded so the
    // afterChange derivation doesn't fight it) before we capture the parent's source.
    writeRollupFormulasIntoGrid(hot, row, col, newPath, curPath);

    const curData = captureSourceData(hot);
    sheetDataMap.current.set(curPath, curData);
    // Cache evaluated snapshot too — needed by propagateLiveRollup to sum ancestor
    // sheets' formula columns once this sheet is no longer the displayed one.
    sheetComputedMap.current.set(curPath, getEvaluatedGridData(hot));

    // Persist current sheet before leaving it
    const revId = revIdRef.current;
    if (revId != null) persistSheet(revId, curPath, curData);

    // Use evaluated values (not source/formula strings) for the breadcrumb context —
    // see readRowCtxFromGrid doc comment.
    const ctx = readRowCtxFromGrid(hot, row);
    pathStack.current = [...pathStack.current, newPath];

    // Level we're navigating INTO — uncapped depth now (M5).
    const newLevel = levelRef.current + 1;

    setBreadcrumb(prev => [...prev, ctx]);
    setLevel(prev => prev + 1);
    setActiveCell("A1");
    setActiveCellValue("");

    const display = (data: (string | null)[][]) => {
      sheetDataMap.current.set(newPath, data);
      const hot2 = hotRef.current?.hotInstance;
      if (hot2) {
        loadLevelDataExcl(hot2, data, newLevel, isAutoUpdatingRef, newPath);
        // Drilling in should land on the child sheet's top-left, not wherever the
        // parent row happened to leave the grid scrolled — the row index that was
        // meaningful in the parent has no relation to this sheet's rows.
        hot2.selectCell(0, 0);
        hot2.scrollViewportTo(0, 0);
      }
      syncSheetLinks(newPath);
    };

    // A genuinely new build-up sheet — the estimator sets it up from scratch (or copies an
    // already-set-up row's own sub-sheet in, via afterPaste's clone-on-paste); there's no
    // master template to seed it from any more.
    const seedNewSheet = () => display(createEmptyData());

    // Load new sheet: prefer in-memory cache; fall back to SQLite; else genuinely blank
    if (sheetDataMap.current.has(newPath)) {
      requestAnimationFrame(() => display(sheetDataMap.current.get(newPath)!));
    } else if (revId != null) {
      wbRead<string>("load_workbook_sheet", { revisionId: revId, sheetPath: newPath })
        .then(json => {
          if (!json || json === "[]") { seedNewSheet(); return; }
          let data: (string | null)[][];
          try { data = padData(JSON.parse(json) as (string | null)[][]); }
          catch { display(createEmptyData()); return; }
          display(data);
        })
        .catch(seedNewSheet);
    } else {
      requestAnimationFrame(seedNewSheet);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Navigate up to the ancestor at pathStack index `targetIndex` (the sheet that becomes current),
  // popping every level below it. `breadcrumb[i]` corresponds to `pathStack[i]`, so a breadcrumb
  // row's back arrow passes its own index. drillUp() is just "up one" = the immediate parent.
  const drillUpTo = useCallback((targetIndex: number) => {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const stack = pathStack.current;
    if (targetIndex < 0 || targetIndex >= stack.length - 1) return; // must be an ancestor, not current

    // See closeActiveEditor — prevents a stale open editor bleeding into the sheet swapped in.
    closeActiveEditor(hot);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    const curPath = stack[stack.length - 1];
    const curData = captureSourceData(hot);
    sheetDataMap.current.set(curPath, curData);
    sheetComputedMap.current.set(curPath, getEvaluatedGridData(hot));

    // Declarative engine: rollup cells are live formulas, so there's nothing to bake on the way up —
    // just persist this sheet and navigate. Ancestors recompute from their children automatically.
    const revId = revIdRef.current;
    if (revId != null) persistSheet(revId, curPath, curData);

    const newStack = stack.slice(0, targetIndex + 1);
    const targetPath = newStack[newStack.length - 1];
    pathStack.current = newStack;

    setBreadcrumb(prev => prev.slice(0, targetIndex));
    setLevel(newStack.length);
    setActiveCell("A1");
    setActiveCellValue("");

    requestAnimationFrame(() => {
      const data = sheetDataMap.current.get(targetPath) ?? createEmptyData();
      const hot2 = hotRef.current?.hotInstance;
      if (hot2) loadLevelDataExcl(hot2, data, newStack.length, isAutoUpdatingRef, targetPath);
      syncSheetLinks(targetPath);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drillUp = useCallback(() => {
    drillUpTo(pathStack.current.length - 2); // up one level = the immediate parent
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  drillDownRef.current = drillDown;
  drillUpRef.current   = drillUp;

  // ── Live breadcrumb rollup ──────────────────────────────────────────────
  //
  // The breadcrumb toolbars show each ancestor row's Subtotal/Rate/Total — values
  // that are only *persisted* into the parent sheet on drill-up. Without this,
  // editing the currently-displayed sheet has no visible effect on the breadcrumb
  // until the user drills up and back down. This walks the path upward from the
  // current sheet, recomputing each ancestor row's derived columns the same way
  // drillUp's rollup does (live, in-memory only — nothing is persisted here), and
  // refreshes `breadcrumb` so both toolbars show live totals as you type.
  // Live breadcrumb update on edit. With the declarative engine every ancestor rollup cell is a
  // live formula, so this just re-reads the ancestors' evaluated values from the engine rather than
  // re-deriving them by hand (which, post-cutover, surfaced the parent's raw =XSUM…(ref) source).
  const propagateLiveRollup = useCallback(() => {
    refreshBreadcrumbFromEngine();
  }, [])

  const propagateLiveRollupRef = useRef(propagateLiveRollup);
  propagateLiveRollupRef.current = propagateLiveRollup;

  // ── Workbook maintenance: clean orphaned build-up sheets / clear workbook ──
  //
  // Drilling into a row always derives a child sheet path "<parent>/R<row>",
  // regardless of whether that row holds a real line item. If the user later
  // clears the line item (Code + Description) but had already drilled into it,
  // the child (and grandchild) sheet rows remain in `workbook_sheet_data`,
  // silently still contributing to ancestor totals via rollup. "Clean orphaned
  // sheets" deletes every sub-sheet whose owning row no longer holds anything (and
  // everything beneath it) — done in one backend transaction, prune_workbook_orphans.

  // A row counts as a real line item if ANY of its cells holds a value — not just Code/Desc.
  // Checking Code/Desc alone (the original test) missed two real, common cases: a Quantity
  // Build-up ("qty" kind) row whose content is Count/Length/Width/Height with no label at all
  // (deriveLevelFormulas' qty branch already tests those columns for exactly this reason), and a
  // standard cost-sheet row populated purely by dragging a dimension group's Quantity onto C —
  // handleGroupDrop only ever writes Quantity/Unit, never Code/Desc, so a linked-quantity row with
  // no typed description was ALSO invisible to the old check. Both under-detections had the same
  // consequence: `isLineItemRow` is what row-shift call sites (insertBlankRowAt/deleteRowAt/
  // addRow/requestDeleteRows) use to find "the last real row", so a row it fails to recognise gets
  // silently overwritten in place by the next insert/delete instead of being shifted or protected.
  const isLineItemRow = (row: (string | null)[] | undefined): boolean => {
    if (!row) return false;
    return row.some(cell => cell != null && cell !== "");
  };

  /** Fetch a sheet's source data — in-memory cache first, else SQLite, else empty.
   *  Re-pads a cache hit up to the current `NUM_ROWS` — a sheet can be cached from
   *  before `NUM_ROWS` grew (e.g. a different sheet was the one that just grew) and
   *  callers here iterate `0..NUM_ROWS` directly against the returned array. */
  async function fetchSheetSourceData(revisionId: number, path: string): Promise<(string | null)[][]> {
    const cached = sheetDataMap.current.get(path);
    if (cached) return padRowsTo(cached, NUM_ROWS);
    try {
      const json = await wbRead<string>("load_workbook_sheet", { revisionId, sheetPath: path });
      return padData(JSON.parse(json) as (string | null)[][]);
    } catch {
      return createEmptyData();
    }
  }

  /**
   * Recalculate the whole workbook: persists the displayed sheet, then forces the live engine
   * (which holds every sheet of the revision) to rebuild and re-evaluate, and repaints. Rollups and
   * named cells are live formulas, so this is only a manual safety net.
   */
  async function recalculateWorkbook(): Promise<void> {
    const hot = hotRef.current?.hotInstance;
    const revId = revIdRef.current;
    if (!hot || revId == null) return;

    // Declarative engine: rollups are live cross-sheet `=SUM(child!…)` formulas, so "recalculate"
    // is just forcing HyperFormula to rebuild its dependency graph and re-evaluate, then
    // repainting the displayed sheet and the breadcrumb — no baking tree-walk. This exists mainly
    // as a manual "recompute everything" safety net (e.g. after a bulk edit); the workbook is
    // otherwise self-updating.
    closeActiveEditor(hot);
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const curPath = pathStack.current[pathStack.current.length - 1];
    const curSourceData = captureSourceData(hot);
    sheetDataMap.current.set(curPath, curSourceData);
    persistSheet(revId, curPath, curSourceData);

    // Force a full recompute (explicit-range edges settle in one pass), then repaint.
    recomputeEngine(hot);
    refreshBreadcrumbFromEngine();
    hot.render();
  }

  /** Rebuilds the breadcrumb ancestry rows from the engine's current evaluated values — used by
   *  recalculate and the live breadcrumb rollup. Reads each ancestor row straight from its engine
   *  sheet, so it always reflects the declarative formulas. */
  function refreshBreadcrumbFromEngine(): void {
    const hot = hotRef.current?.hotInstance;
    const engine = getFormulasPlugin(hot)?.engine;
    if (!engine) return;
    const stack = pathStack.current;
    const ctxs: BreadcrumbCtx[] = [];
    for (let i = 0; i < stack.length - 1; i++) {
      const parentPath = stack[i];
      const row = pathLastRow(stack[i + 1]) ?? 0;
      const name = pathToSheetName(parentPath);
      const val = (col: number): string => {
        try {
          const v = engine.getCellValue({ sheet: engine.getSheetId(name), row, col });
          return v != null && v !== "" ? String(v) : "";
        } catch { return ""; }
      };
      ctxs.push({
        code: val(COL_CODE), description: val(COL_DESC), quantity: val(COL_QTY), unit: val(COL_UNIT),
        rate: val(COL_RATE), subtotal: val(COL_SUBTOTAL), factor: val(COL_FACTOR), total: val(COL_TOTAL),
      });
    }
    setBreadcrumb(ctxs);
  }

  /** Drop any cached entries for `path` and everything beneath it. */
  function purgeCachedSubtree(path: string): void {
    const prefix = `${path}/`;
    for (const key of Array.from(sheetDataMap.current.keys())) {
      if (key === path || key.startsWith(prefix)) sheetDataMap.current.delete(key);
    }
    for (const key of Array.from(sheetComputedMap.current.keys())) {
      if (key === path || key.startsWith(prefix)) sheetComputedMap.current.delete(key);
    }
    for (const key of Array.from(cellLinkMap.current.keys())) {
      if (key === path || key.startsWith(prefix)) cellLinkMap.current.delete(key);
    }
    for (const key of Array.from(loadedLinkPathsRef.current)) {
      if (key === path || key.startsWith(prefix)) loadedLinkPathsRef.current.delete(key);
    }
    for (const key of Array.from(cellStyleMap.current.keys())) {
      if (key === path || key.startsWith(prefix)) cellStyleMap.current.delete(key);
    }
    for (const key of Array.from(loadedStylePathsRef.current)) {
      if (key === path || key.startsWith(prefix)) loadedStylePathsRef.current.delete(key);
    }
    for (const key of Array.from(cellExclusionMap.current.keys())) {
      if (key === path || key.startsWith(prefix)) cellExclusionMap.current.delete(key);
    }
    for (const key of Array.from(loadedExclusionPathsRef.current)) {
      if (key === path || key.startsWith(prefix)) loadedExclusionPathsRef.current.delete(key);
    }
  }

  /**
   * Clones a row's drilled child sheet (a Cost/Rate/Qty sub-sheet — "/S", "/R" or "/Q") onto
   * another row's, completely independent of the original — invoked from afterPaste when a
   * copied drill-column cell (F:Subtotal, E:Rate or C:Quantity) is pasted into a different
   * row's same column. This is the reference-following half of a row copy/paste: the pasted
   * cell already carries whatever formula the estimator typed (verbatim, retargeted to its
   * new row by beforeChange's toStored round-trip — see afterPaste) — this function's job is
   * only to make sure the DATA that formula reads actually exists, independently, at the
   * destination, the same way pasting a plain range of cells duplicates their values.
   *
   * A no-op if the source row was never drilled into — nothing exists to clone, so the
   * pasted formula (if any) is left to read an empty/new child on its own.
   *
   * RECURSIVE: a Cost sheet ("/S") can itself drill further (M5: unlimited depth) — a
   * trade-summary row's whole Cost breakdown, full of hand-set-up line items each with their
   * own Rate Build-up, is exactly this shape, and copying that trade row is a normal
   * workflow, not an edge case. So once `cloned`'s own data is in hand, every one of ITS
   * occupied rows' own S/R/Q children is cloned too (recursing into this same function), and
   * any XSUM* reference inside `cloned`'s cells that pointed at one of those children is
   * retargeted to the newly-cloned copy — `cloneSheetData` copies cell text verbatim, and
   * unlike a normal grid paste, nothing here goes through beforeChange's toStored round-trip
   * to fix that up on its own. Rate and Qty sheets are leaves (see isDrillColumn), so the
   * recursion naturally bottoms out there.
   */
  async function maybeCloneChildSheet(srcPath: string, dstPath: string): Promise<void> {
    if (srcPath === dstPath) return;
    const revId = revIdRef.current;

    let srcData = sheetDataMap.current.get(srcPath);
    if (!srcData) {
      if (revId == null) return;
      try {
        const json = await wbRead<string>("load_workbook_sheet", { revisionId: revId, sheetPath: srcPath });
        if (!json || json === "[]") return;
        srcData = padData(JSON.parse(json) as (string | null)[][]);
      } catch {
        return;
      }
      await Promise.all([
        ensureSheetStylesLoaded(revId, srcPath),
        ensureSheetLinksLoaded(revId, srcPath),
        ensureSheetExclusionsLoaded(revId, srcPath),
      ]);
    }

    // Clean overwrite: drop whatever was already cached/persisted at the destination
    // first, so the clone is fully independent of any prior content there.
    purgeCachedSubtree(dstPath);
    if (revId != null) {
      wbWrite("delete_workbook_sheet_subtree", { revisionId: revId, sheetPath: dstPath });
    }

    const cloned = cloneSheetData(srcData);
    sheetDataMap.current.set(dstPath, cloned);

    const clonedStyles = cloneStyleMap(cellStyleMap.current.get(srcPath));
    if (clonedStyles) cellStyleMap.current.set(dstPath, clonedStyles);

    const srcLinks = cellLinkMap.current.get(srcPath);
    if (srcLinks && srcLinks.size > 0) cellLinkMap.current.set(dstPath, new Map(srcLinks));

    const srcExcl = cellExclusionMap.current.get(srcPath);
    if (srcExcl && srcExcl.size > 0) cellExclusionMap.current.set(dstPath, new Set(srcExcl));

    loadedStylePathsRef.current.add(dstPath);
    loadedLinkPathsRef.current.add(dstPath);
    loadedExclusionPathsRef.current.add(dstPath);

    // If this sheet is itself a cost sheet, it can carry its OWN drilled S/R/Q children
    // (M5: unlimited depth) — a trade-summary row's Cost sheet full of hand-set-up line
    // items, each with its own Rate Build-up, is exactly this shape. Clone every one of
    // them too, recursively, and retarget any XSUM* reference inside `cloned`'s own cells
    // that pointed at one of THOSE children so it now points at the newly-cloned copy —
    // `cloneSheetData` copies cell text verbatim, and (unlike a normal grid paste) nothing
    // here goes through beforeChange's toStored round-trip to fix that up on its own.
    if (isCostSheetPath(srcPath)) {
      for (const row of cloned) {
        for (let c = 0; c < row.length; c++) row[c] = retargetSheetRefs(row[c], srcPath, dstPath);
      }
      // Only the children that actually exist. The live engine holds every sheet of the revision,
      // and the cache holds any created this session, so between them they list every direct
      // child — this used to probe all three suffixes on every row of the sheet (hundreds of
      // lookups, most of them database round trips, per pasted row). Concurrent: each call touches
      // only its own src/dst paths. A child failing is logged, not left to abort the parent's
      // persist/engine-push below via an unhandled rejection.
      const prefix = `${srcPath}/`;
      const children = new Set<string>();
      let engineNames: string[] = [];
      try { engineNames = (getFormulasPlugin(hotRef.current?.hotInstance)?.engine?.getSheetNames() as string[]) ?? []; } catch { /* no engine */ }
      for (const p of [...engineNames.map(sheetNameToPath), ...sheetDataMap.current.keys()]) {
        if (!p.startsWith(prefix)) continue;
        const seg = p.slice(prefix.length);
        if (/^[SRQ]\d+$/.test(seg)) children.add(seg); // direct children only; each recursion handles its own
      }
      const childClones: Array<Promise<void>> = [];
      for (const seg of children) {
        childClones.push(
          maybeCloneChildSheet(`${srcPath}/${seg}`, `${dstPath}/${seg}`)
            .catch(err => { console.error(`clone-on-paste: failed to clone ${srcPath}/${seg}`, err); }),
        );
      }
      await Promise.all(childClones);
    }

    if (revId != null) persistSheet(revId, dstPath, cloned);

    // Push the cloned data into the LIVE engine under the destination's own sheet name, so
    // whatever formula the pasted parent cell holds (already retargeted to read THIS sheet
    // by beforeChange's toStored round-trip — see afterPaste) resolves against real data
    // immediately, instead of the app computing and writing a value into the parent row
    // itself. The parent cell's own formula is the only thing that determines what the
    // parent row shows; this only makes sure it has something real to read.
    //
    // Deliberately does NOT settle (recompute/render) here — this function recurses into every
    // occupied row's own S/R/Q children (M5), and a paste of a cost sheet with dozens of rows
    // used to mean dozens of full-engine recalculations plus dozens of full grid re-renders, one
    // per clone, each already paying for the OTHERS' now-stale-again engine state. Callers
    // settle ONCE after every clone in the paste has finished — see afterPaste.
    const hot = hotRef.current?.hotInstance;
    if (hot) {
      const plugin = getFormulasPlugin(hot);
      const engine = plugin?.engine;
      if (plugin && engine) {
        try {
          const name = pathToSheetName(dstPath);
          const rows = dataForHot(cloned);
          if (engine.doesSheetExist(name)) engine.setSheetContent(engine.getSheetId(name), rows);
          else plugin.addSheet(name, rows);
        } catch { /* non-fatal — the cache/DB clone above still keeps it consistent on reload */ }
      }
    }
  }

  /** Settles the engine/UI once after one or more `maybeCloneChildSheet` calls — see that
   *  function's doc comment on why it no longer does this itself per-clone. */
  function settleAfterCloneOnPaste(): void {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    // No full recompute: the engine already reflects the cloned sheets (values are live).
    propagateLiveRollupRef.current();
    refreshProjectTotal();
    hot.render();
  }

  /** Reset the whole view back to a blank Level 1 sheet (in-memory only). */
  /**
   * Switches the grid to an arbitrary fixed sheet path at a given level, with no
   * breadcrumb ancestry. Used by template-edit mode to jump between the master
   * Level 1 (takeoff) and master Level 2 (rate build-up) sheets — these are
   * standalone "roots" with no real parent rows, unlike normal drill-down targets.
   *
   * `selectAfter` (optional) selects and scrolls to a cell once the target sheet's
   * data has loaded and rendered — used by the Named Cells manager's "Go to" action,
   * which needs the destination cell highlighted, not just the sheet displayed.
   */
  function jumpToSheet(path: string, level: Level, selectAfter?: { row: number; col: number }): void {
    const hot = hotRef.current?.hotInstance;
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    if (hot) {
      // See closeActiveEditor — prevents a stale open editor from bleeding its pending
      // value into whichever cell of the target sheet ends up under it after the swap.
      closeActiveEditor(hot);
      const curPath = pathStack.current[pathStack.current.length - 1];
      const curData = captureSourceData(hot);
      sheetDataMap.current.set(curPath, curData);
      const revId = revIdRef.current;
      if (revId != null) persistSheet(revId, curPath, curData);
    }

    pathStack.current = [path];
    sheetComputedMap.current = new Map();
    setBreadcrumb([]);
    setLevel(level);
    setActiveCell("A1");
    setActiveCellValue("");

    const display = (data: (string | null)[][]) => {
      sheetDataMap.current.set(path, data);
      requestAnimationFrame(() => {
        const hot2 = hotRef.current?.hotInstance;
        if (hot2) {
          loadLevelDataExcl(hot2, data, level, isAutoUpdatingRef, path);
          if (selectAfter) {
            hot2.selectCell(selectAfter.row, selectAfter.col);
            hot2.scrollViewportTo(selectAfter.row, selectAfter.col, true, true);
          }
        }
        syncSheetLinks(path);
      });
    };

    if (sheetDataMap.current.has(path)) {
      display(sheetDataMap.current.get(path)!);
      return;
    }

    const revId = revIdRef.current;
    if (revId != null) {
      wbRead<string>("load_workbook_sheet", { revisionId: revId, sheetPath: path })
        .then(json => {
          let data: (string | null)[][];
          try { data = padData(JSON.parse(json) as (string | null)[][]); }
          catch { data = createEmptyData(); }
          display(data);
        })
        .catch(() => display(createEmptyData()));
    } else {
      display(createEmptyData());
    }
  }

  function resetToRootSheet(): void {
    pathStack.current = ["L1"];
    sheetDataMap.current = new Map([["L1", sheetDataMap.current.get("L1") ?? createEmptyData()]]);
    sheetComputedMap.current = new Map();
    setBreadcrumb([]);
    setLevel(1);
    setActiveCell("A1");
    setActiveCellValue("");
    requestAnimationFrame(() => {
      const hot = hotRef.current?.hotInstance;
      if (hot) loadLevelDataExcl(hot, sheetDataMap.current.get("L1") ?? createEmptyData(), 1, isAutoUpdatingRef, "L1");
      syncSheetLinks("L1");
    });
  }

  const handleCleanOrphans = useCallback(async () => {
    const revId = revIdRef.current;
    if (revId == null || cleanupBusy) return;
    setCleanupBusy(true);
    try {
      // Persist the current sheet first so its row contents are up to date for the scan.
      const hot = hotRef.current?.hotInstance;
      if (hot) {
        const curPath = pathStack.current[pathStack.current.length - 1];
        const curData = captureSourceData(hot);
        sheetDataMap.current.set(curPath, curData);
        persistSheet(revId, curPath, curData);
      }

      // One backend transaction finds and deletes every orphan (prune_workbook_orphans); it runs
      // behind the save queued just above, so it sees the current sheet's latest rows.
      const removed = await wbInvoke<string[]>("prune_workbook_orphans", { revisionId: revId });
      for (const p of removed) {
        purgeCachedSubtree(p);
        // The live engine holds every sheet of the revision; drop the deleted ones there too, or
        // they keep feeding totals for the rest of the session while the file no longer has them.
        if (hot) removeEngineSubtree(hot, p);
      }

      // If we're currently viewing a sheet that was just removed, jump back to L1.
      const viewingRemoved = pathStack.current.some(p =>
        removed.some(d => p === d || p.startsWith(`${d}/`)));
      if (viewingRemoved) resetToRootSheet();

      showCleanupMessage(
        removed.length > 0
          ? `Removed ${removed.length} orphaned build-up sheet${removed.length === 1 ? "" : "s"}.`
          : "No orphaned sheets found — the workbook is clean."
      );
    } catch (e) {
      showCleanupMessage(`Failed to clean orphaned sheets: ${e}`);
    } finally {
      setCleanupBusy(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupBusy, showCleanupMessage]);

  const handleClearWorkbook = useCallback(async () => {
    const revId = revIdRef.current;
    if (revId == null || cleanupBusy) return;
    setCleanupBusy(true);
    try {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      await wbInvoke<number>("clear_workbook_revision_data", { revisionId: revId });
      sheetDataMap.current = new Map([["L1", createEmptyData()]]);
      // Mirror the wipe in the live engine: every other sheet goes, L1 is blanked.
      const hot = hotRef.current?.hotInstance;
      if (hot) await resetEngineSheets(hot, [{ path: "L1", data: createEmptyData() }]);
      cellLinkMap.current = new Map();
      loadedLinkPathsRef.current = new Set();
      cellStyleMap.current = new Map();
      loadedStylePathsRef.current = new Set();
      cellExclusionMap.current = new Map();
      loadedExclusionPathsRef.current = new Set();
      resetToRootSheet();
      showCleanupMessage("Workbook cleared — all sheets reset to blank.");
    } catch (e) {
      showCleanupMessage(`Failed to clear workbook: ${e}`);
    } finally {
      setCleanupBusy(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupBusy, showCleanupMessage]);

  function runConfirmedAction(action: "clean" | "clear") {
    setConfirmAction(null);
    if (action === "clean") void handleCleanOrphans();
    else void handleClearWorkbook();
  }

  // ── Cell renderer: number format (2dp + 1000's separator), drill-down ───
  // colour, and Format-toolbar styles (font/size/bold/italic/underline/align).
  // Defined once (closes only over refs), reused for every value column.
  function workbookCellRenderer(
    instance: Handsontable.Core,
    td: HTMLTableCellElement,
    row: number,
    col: number,
    prop: string | number,
    value: unknown,
    cellProperties: Handsontable.CellProperties,
  ) {
    textRenderer(instance, td, row, col, prop, value, cellProperties);

    const style = getCellStyle(row, col);
    const numeric = NUMERIC_COLS.has(col);

    if (numeric) {
      const decimals = style.decimals ?? DEFAULT_WORKBOOK_FORMAT.decimals;
      const formatted = formatNumericDisplay(value, decimals);
      if (formatted != null) td.textContent = formatted;
    }

    td.style.fontWeight     = style.bold ? "700" : "400";
    td.style.fontStyle      = style.italic ? "italic" : "normal";
    td.style.textDecoration = style.underline ? "underline" : "none";
    td.style.fontFamily     = style.fontFamily ?? "inherit";
    td.style.fontSize       = style.fontSize ? `${style.fontSize}px` : "";
    td.style.textAlign      = style.align ?? (numeric ? "right" : "left");

    // Quantity cells imported from a dimension group (and their Unit cell) are shown
    // in green so the user can see at a glance which figures are live CostX imports.
    const isLinked = (col === COL_QTY || col === COL_UNIT) && !!getCellLink(curSheetPath(), row, COL_QTY);
    const excluded = isCellExcluded(curSheetPath(), row, col);
    // An excluded drill column reverts from drill-blue to plain black — the visual
    // cue that exclusion has also switched off its drill-down behaviour (see
    // beforeOnCellMouseDown).
    const isDrill = isDrillColumn(curSheetPath(), col) && !excluded;
    td.style.color = isLinked ? LINK_FONT_COLOUR : (isDrill ? DRILL_FONT_COLOUR : "");

    // Cells excluded from auto-calc carry a faint dashed top border so the user can
    // see at a glance which F/G/H cells are hand-built and won't be auto-derived.
    td.style.borderTop = excluded ? `1px dashed ${EXCLUDED_BORDER_COLOUR}` : "";

    // Highlight the designated "PROJECT_TOTAL" cell on L1 — a class (not
    // td.style) so its !important CSS rule can win over ht-yellow-cell's.
    const pt = namedCellMap.current.get(PROJECT_TOTAL_NAME);
    const isProjectTotal = curSheetPath() === "L1" && pt?.row === row && pt?.col === col;
    td.classList.toggle("ht-project-total-cell", isProjectTotal);
  }

  // ── Handsontable settings (created once; hooks read from refs) ─────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hotSettings = useMemo(() => ({
    licenseKey: "non-commercial-and-evaluation",
    themeName: "ht-theme-classic",
    data: createEmptyData(),
    rowHeaders: true,
    rowHeaderWidth: ROW_HDR_W,
    colHeaders: buildColHeaders(COLUMNS, BASE_NUM_COLS),
    colWidths: buildColWidths(COLUMNS, BASE_NUM_COLS),
    manualColumnResize: true,
    manualRowResize: true,
    contextMenu: false,
    fillHandle: false,
    autoColumnSize: false,
    stretchH: "none",
    height: 400,
    // Clicking a ribbon Format button (outside the grid) would otherwise deselect the
    // current range before the button's onClick runs — so getSelectedRange() (used by
    // applyToSelection) sees nothing and falls back to a single last-known cell instead
    // of the full multi-cell selection.
    outsideClickDeselects: false,

    // ── Formula engine (multi-sheet) ─────────────────────────────────────
    // The plugin owns its HyperFormula engine but we drive it multi-sheet: every workbook sheet
    // path is its own engine sheet (name = pathToSheetName), navigation is switchSheet, and the
    // whole revision is loaded so cross-sheet rollup formulas resolve. The bound sheet is L1.
    formulas: {
      engine: HyperFormula,
      sheetName: pathToSheetName("L1"),
    },

    afterSelection(row: number, col: number, row2: number, col2: number) {
      if (row < 0 || col < 0) return;
      lastSelectedCellRef.current = { row, col };
      const letter = colLetter(col);
      setActiveCell(`${letter}${row + 1}`);
      // Show formula string (source data), not the computed value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hot = (hotRef.current?.hotInstance) as any;
      const val = hot?.getSourceDataAtCell(row, col);
      // Show the CostX-clean positional form of a rollup (=XSUMRATE(2)); the stored cell keeps the
      // child reference the engine needs. No-op for any other content.
      setActiveCellValue(val != null ? xsumToDisplay(String(val)) : "");
      setCompletions([]);
      syncFormatSnapshot();

      // Compute Excel-style status bar stats over the selected range
      if (hot) {
        const fromRow = Math.min(row, row2);
        const toRow   = Math.max(row, row2);
        const fromCol = Math.min(col, col2);
        const toCol   = Math.max(col, col2);
        let numCount = 0;
        let sum = 0;
        for (let r = fromRow; r <= toRow; r++) {
          for (let c = fromCol; c <= toCol; c++) {
            const v = hot.getDataAtCell(r, c);
            const n = typeof v === "number" ? v : (v != null && v !== "" ? Number(v) : NaN);
            if (isFinite(n)) { sum += n; numCount++; }
          }
        }
        const cellCount = (toRow - fromRow + 1) * (toCol - fromCol + 1);
        if (numCount > 0 && cellCount > 1) {
          setSelectionStats({ count: numCount, sum, average: sum / numCount });
        } else {
          setSelectionStats(null);
        }
      }
    },

    // Remembers the copied selection so afterPaste can tell whether a drill column
    // (F:Subtotal, E:Rate or C:Quantity) was part of it — see lastRateCopyRef /
    // maybeCloneChildSheet.
    afterCopy(
      _data: unknown[][],
      coords: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
    ) {
      const r0 = coords?.[0];
      if (!r0) return;
      lastRateCopyRef.current = {
        path: curSheetPath(),
        level: levelRef.current,
        startRow: r0.startRow,
        startCol: r0.startCol,
        rowCount: r0.endRow - r0.startRow + 1,
        colCount: r0.endCol - r0.startCol + 1,
      };
    },

    // Pasting a copied cell does two things, mirroring Excel/CostX:
    //  1. Any plain (non-XSUM) formula has its row references shifted by the same amount the
    //     paste moved the cell down (or up) by — `=M1*C1` copied from row 1 to row 3 becomes
    //     `=M3*C3` — via shiftFormulaRowRefs. Handsontable pastes the source text verbatim, so
    //     without this the pasted formula would silently keep reading the row it was copied
    //     FROM. An XSUM formula is retargeted separately, by cell position, via beforeChange's
    //     toStored round-trip. An F:Subtotal/H:Total already holding the auto formula for its
    //     new row is skipped — the paste's own afterChange re-derived it, and shifting it again
    //     double-counted the offset (row 5 pasted to row 7 read row 9).
    //  2. Pasting a copied drill-column cell (F:Subtotal, E:Rate or C:Quantity) additionally
    //     clones the source row's drilled child sheet onto the destination row, so its full
    //     breakdown comes along independently of the original. Any drill column, any level —
    //     the source sheet doesn't need to be a cost sheet itself for this to apply.
    afterPaste(
      _data: unknown[][],
      coords: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
    ) {
      const copy = lastRateCopyRef.current;
      if (!copy) return;
      const dstPath = curSheetPath();
      const hot = hotRef.current?.hotInstance;
      const drillCols: Array<[number, "S" | "R" | "Q"]> = [
        [COL_SUBTOTAL, "S"], [COL_RATE, "R"], [COL_QTY, "Q"],
      ];
      const kind = sheetKindForPath(dstPath);
      // By the time afterPaste runs, the paste's own afterChange may already have re-derived an auto
      // formula (F=E×C, H=F×G, qty H=PRODUCT) onto its new row; shifting that again would double the
      // offset. So skip exactly the cells that already hold the auto formula for THEIR OWN row.
      // Everything else — an estimator's own F/H formula (never re-derived), or an auto formula the
      // derivation didn't reach (e.g. only column H was pasted) — gets the ordinary shift below.
      const isAutoRegenerated = (row: number, col: number) => {
        const formula = autoFormulaFor(kind, col, row);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return formula != null && (hot as any)?.getSourceDataAtCell(row, col) === formula;
      };
      const refFix: Array<[number, number, string]> = [];
      // Tracked so the footer's activity indicator (set below) clears only once every
      // clone-on-paste has actually finished — these are fired off async (DB round-trips per
      // child sheet), not awaited inline, so the paste's own synchronous work finishes first.
      const clonePromises: Promise<void>[] = [];
      for (const range of coords ?? []) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            const colOffsetInRange = ((c - range.startCol) % copy.colCount + copy.colCount) % copy.colCount;
            const rowOffsetInRange = ((r - range.startRow) % copy.rowCount + copy.rowCount) % copy.rowCount;
            const srcRow = copy.startRow + rowOffsetInRange;
            const srcCol = copy.startCol + colOffsetInRange;

            if (hot && !isAutoRegenerated(r, c) && (srcRow !== r || srcCol !== c || copy.path !== dstPath)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pasted = (hot as any).getSourceDataAtCell(r, c);
              if (typeof pasted === "string" && pasted.charAt(0) === "=") {
                const shifted = shiftFormulaRowRefs(pasted, r - srcRow);
                if (shifted !== pasted) refFix.push([r, c, shifted]);
              }
            }

            const drill = drillCols.find(([col]) => col === c);
            if (!drill) continue;
            const [, suffix] = drill;
            const srcColOffset = c - copy.startCol;
            if (srcColOffset < 0 || srcColOffset >= copy.colCount) continue;
            if (colOffsetInRange !== srcColOffset) continue;
            const srcChildPath = `${copy.path}/${suffix}${srcRow}`;
            const dstChildPath = `${dstPath}/${suffix}${r}`;
            if (srcChildPath === dstChildPath) continue;
            clonePromises.push(
              maybeCloneChildSheet(srcChildPath, dstChildPath)
                .catch(err => { console.error(`clone-on-paste: failed to clone ${srcChildPath}`, err); }),
            );
          }
        }
      }
      if (refFix.length && hot) {
        isAutoUpdatingRef.current = true;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hot.setDataAtCell(refFix as any);
        } finally {
          isAutoUpdatingRef.current = false;
        }
        propagateLiveRollupRef.current();
        refreshProjectTotal();
        hot.render();
      }
      if (clonePromises.length) {
        useAppStore.getState().setWorkbookActivity("Copying build-up sheets…");
        void Promise.allSettled(clonePromises).then(() => {
          // One settle for the whole paste instead of one per clone — see maybeCloneChildSheet's
          // doc comment; this is what made pasting many drilled rows dramatically slower than
          // pasting the same number of plain cells.
          settleAfterCloneOnPaste();
          useAppStore.getState().setWorkbookActivity("");
        });
      }
    },

    // Expand a positional rollup (=XSUMRATE(2)) into the stored child-reference form before
    // it reaches the engine, retargeted at THIS cell's own position. Always round-trips through
    // xsumToDisplay first: a human keystroke is already positional (no-op), but a pasted cell
    // (Copy Formula, or the grid's own Ctrl+V) carries another cell's STORED reference verbatim —
    // toStored alone treats that as "already stored" and leaves it pointed at the source row/sheet,
    // which is the row-doesn't-update-on-paste bug. Stripping to positional first discards that
    // stale reference so toStored always rebuilds it fresh from (path, ch[0]). No-op for every
    // non-rollup value, and idempotent for a programmatic write already targeting this cell.
    beforeChange(changes: Array<[number, number, unknown, unknown]> | null, source?: string) {
      if (!changes || source === "loadData") return;
      const path = curSheetPath();
      for (const ch of changes) {
        const next = ch?.[3];
        if (typeof next === "string" && next.charAt(0) === "=") {
          const expanded = xsumToStored(xsumToDisplay(next), path, ch[0]);
          if (expanded !== next) ch[3] = expanded;
        }
      }
    },

    afterChange(changes: Handsontable.CellChange[] | null) {
      if (!changes) return;
      const hot = hotRef.current?.hotInstance as Handsontable | undefined;
      if (!hot) return;
      const sel = hot.getSelectedRange()?.[0];
      if (sel) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const val = (hot as any).getSourceDataAtCell(sel.highlight.row, sel.highlight.col);
        setActiveCellValue(val != null ? xsumToDisplay(String(val)) : "");
      }
      // Debounced auto-save to SQLite
      scheduleSaveRef.current();

      // Named cells bound to a cell on the active sheet are registered as *live*
      // HyperFormula references (see namedExprFormula), so edits to a bound cell
      // recompute and repaint their dependents natively — no manual sync needed here.

      // ── Level 2/3 auto-derivation: F=E×C, G auto-populate=1, H=F×G ─────
      // Skipped when isAutoUpdatingRef is true — i.e. for the nested afterChange
      // calls fired by our own setDataAtCell writes below (prevents recursion).
      if (!isAutoUpdatingRef.current) {
        // Auto-extend the grid once an edit lands near the bottom — matches Google
        // Sheets' "grow as you fill the last few rows" behaviour instead of hard-
        // capping the sheet at its initial row count.
        const maxEditedRow = Math.max(...changes.map(ch => ch[0]));
        if (maxEditedRow >= NUM_ROWS - ROW_GROWTH_THRESHOLD) {
          growRowsTo(hot, NUM_ROWS + ROW_GROWTH_CHUNK);
        }

        // Same idea on the column axis — editing near the right edge (e.g. Y or Z)
        // of *this* sheet appends another column (AA, AB, …) to it, scoped to this
        // sheet only (see growColsTo) rather than capping the sheet at Z or bleeding
        // the extra column into any other sheet/revision.
        const maxEditedCol = Math.max(...changes.map(ch => typeof ch[1] === "number" ? ch[1] : -1));
        const curCols = hot.countCols();
        if (maxEditedCol >= curCols - COL_GROWTH_THRESHOLD) {
          growColsTo(hot, curCols + COL_GROWTH_CHUNK);
        }

        // Remove stale cell links when a linked C:Quantity cell is cleared by the user.
        // Without this, refreshLinkedCells on next sheet load re-populates the cleared cell.
        const path = curSheetPath();
        for (const ch of changes) {
          const row = ch[0];
          const col = typeof ch[1] === "number" ? ch[1] : -1;
          if (col !== COL_QTY) continue;
          const newVal = ch[3];
          if (newVal != null && newVal !== "") continue;
          const linkKey = styleKey(row, COL_QTY);
          const links = cellLinkMap.current.get(path);
          if (links?.has(linkKey)) {
            links.delete(linkKey);
            const revId = revIdRef.current;
            if (revId != null) {
              wbWrite("save_workbook_sheet_links", {
                revisionId: revId,
                sheetPath: path,
                linksJson: JSON.stringify(Object.fromEntries(links)),
              });
            }
          }
        }

        const kind = sheetKindForPath(curSheetPath());

        // Re-derive through the single, template-driven engine: A–H fixed roles (F=E*C, G=1,
        // H=F*G, or the qty PRODUCT) plus each user column's OWN template formula. No hardcoded
        // user-column behaviour lives here — only runs when a derivation-relevant input changed.
        let derivationRelevant = false;
        for (const ch of changes) {
          const col = typeof ch[1] === "number" ? ch[1] : -1;
          if ((col >= COL_QTY && col <= COL_FACTOR) || col >= FIRST_USER_COL) { derivationRelevant = true; break; }
        }
        if (derivationRelevant) {
          const dpath = curSheetPath();
          deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, kind, dpath, cellExclusionMap.current.get(dpath));
        }

        // ── Live breadcrumb rollup ──────────────────────────────────────
        // Run after derivation has settled (guard is back to false) so the
        // current sheet's F/G/H reflect the just-applied formulas before we
        // sum them up into the ancestor breadcrumb context.
        if (levelRef.current >= 2) {
          propagateLiveRollupRef.current();
        }

        // Keep the workbook sidebar's cached project total live as the user types.
        refreshProjectTotal();
      }
    },

    beforeOnCellMouseDown(
      event: MouseEvent,
      coords: Handsontable.CellCoords,
    ) {
      if ((event as MouseEvent).detail < 2) return;
      if (coords.row < 0 || coords.col < 0) return;
      // M5: F/E/C all drill on a cost sheet (F → deeper cost sheet, recursively); rate/qty leaves
      // don't drill.
      const isDrill = isDrillColumn(curSheetPath(), coords.col);
      // A cell excluded from auto-calc has been "switched off" — including its
      // drill-down behaviour, since drilling into it would create/seed a sub-sheet
      // whose rollup the exclusion is specifically meant to suppress. The renderer
      // shows it in black (not drill-blue) as the visual cue that it no longer drills.
      if (isDrill && isCellExcluded(curSheetPath(), coords.row, coords.col)) return;
      if (isDrill) {
        event.stopImmediatePropagation();
        // The first click of the double-click already selected (and may have begun
        // editing) this cell — close it immediately so its pending value can't bleed
        // into the about-to-load sub-sheet (drillDown also calls closeActiveEditor,
        // but doing it here too closes the window between this mousedown and that
        // deferred call during which Handsontable's own dblclick handler can still fire).
        const hotNow = hotRef.current?.hotInstance;
        if (hotNow) closeActiveEditor(hotNow);
        const row = coords.row;
        const col = coords.col;
        setTimeout(() => drillDownRef.current(row, col), 0);
      }
    },

    cells(_row: number, col: number) {
      const props: Record<string, unknown> = { renderer: workbookCellRenderer };
      if (isHighlightColumn(levelRef.current, sheetKindForPath(curSheetPath()), col)) {
        props.className = "ht-yellow-cell";
      }
      return props;
    },

    // Standard text-format shortcuts: Ctrl+B / Ctrl+U / Ctrl+I toggle bold,
    // underline and italic on the current selection. Also the interception
    // point for the in-cell formula autocomplete dropdown (Up/Down/Tab/Enter/
    // Escape) — this hook fires before Handsontable's own key handling.
    // Reads from refs, not the `cellCompletions*` state directly, since this
    // whole settings object is memoised once (deps: []).
    beforeKeyDown(event: KeyboardEvent) {
      const active = cellCompletionsRef.current;
      if (active.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault(); stopHotShortcut(event);
          setCellCompletionIdx(i => (i + 1) % active.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault(); stopHotShortcut(event);
          setCellCompletionIdx(i => (i - 1 + active.length) % active.length);
          return;
        }
        if (event.key === "Tab" || event.key === "Enter") {
          const name = active[cellCompletionIdxRef.current];
          if (name) {
            event.preventDefault(); stopHotShortcut(event);
            insertCellCompletion(name);
            return;
          }
        }
        if (event.key === "Escape") {
          stopHotShortcut(event);
          setCellCompletions([]);
          setCellCompletionPos(null);
          return;
        }
      }

      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const api = formatApiRef.current;
      if (key === "b") { event.preventDefault(); api.toggleBold(); }
      else if (key === "u") { event.preventDefault(); api.toggleUnderline(); }
      else if (key === "i") { event.preventDefault(); api.toggleItalic(); }
    },

    // Attaches the in-cell autocomplete's input/blur listeners to the editor's
    // own textarea the moment editing begins. Handsontable creates that
    // textarea synchronously as part of opening the editor, but a tick's delay
    // (requestAnimationFrame) keeps this robust against any editor-positioning
    // work Handsontable itself still has queued.
    afterBeginEditing(row: number, col: number) {
      requestAnimationFrame(() => {
        const hot = hotRef.current?.hotInstance;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const editor = (hot as any)?.getActiveEditor?.();
        const textarea: HTMLTextAreaElement | undefined = editor?.TEXTAREA;
        if (!textarea) return;
        // If editing began on a stored rollup, swap the editor text to the clean positional form
        // (=XSUMRATE(2)); beforeChange expands it back to the stored reference on commit.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const src = (hot as any)?.getSourceDataAtCell?.(row, col);
        if (typeof src === "string") {
          const disp = xsumToDisplay(src);
          if (disp !== src && typeof editor.setValue === "function") editor.setValue(disp);
        }
        cellEditorTextareaRef.current = textarea;
        textarea.addEventListener("input", handleCellEditorInput);
        textarea.addEventListener("blur", handleCellEditorBlur);
        // Seed immediately in case editing began on an existing formula (F2 /
        // double-click), rather than waiting for the next keystroke.
        updateCellCompletionsFromTextarea();
      });
    },

    afterGetColHeader(col: number, TH: HTMLTableCellElement) {
      if (isHighlightColumn(levelRef.current, sheetKindForPath(curSheetPath()), col)) {
        (TH as HTMLTableCellElement).style.background = HIGHLIGHT_BG;
      } else {
        (TH as HTMLTableCellElement).style.background = "";
      }
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // ── Formula bar autocomplete ───────────────────────────────────────────

  function updateCompletions(value: string, cursorPos: number) {
    if (!value.startsWith("=")) { setCompletions([]); return; }
    const token = currentAlphaToken(value, cursorPos);
    const matches = matchingCompletions(token, namedCellMap.current);
    setCompletions(matches.slice(0, 8));
    setCompletionIdx(0);
  }

  function insertCompletion(name: string) {
    const input = formulaBarRef.current;
    if (!input) return;
    const cursorPos = input.selectionStart ?? activeCellValue.length;
    const val = activeCellValue;
    const before = val.slice(0, cursorPos);
    const after  = val.slice(cursorPos);
    const tokenMatch = before.match(/([A-Za-z]+)$/);
    if (!tokenMatch) return;
    const tokenStart = cursorPos - tokenMatch[1].length;
    // Functions get an opening paren to invite arguments; a named cell is a
    // complete reference on its own, so it's inserted verbatim.
    const isFunction = FORMULA_FUNCTIONS[name] != null;
    const insertText = isFunction ? `${name}(` : name;
    const newValue   = val.slice(0, tokenStart) + insertText + after;
    const newCursor  = tokenStart + insertText.length;

    setActiveCellValue(newValue);
    const hot = hotRef.current?.hotInstance as Handsontable | undefined;
    if (hot) {
      const cell = resolveCell();
      if (cell) hot.setDataAtCell(cell.row, cell.col, newValue);
    }
    setCompletions([]);

    requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(newCursor, newCursor);
    });
  }

  // ── In-cell formula autocomplete ───────────────────────────────────────
  // Same dropdown/matching as the formula bar, but triggered while typing
  // directly into a cell's own editor textarea (see afterBeginEditing and
  // beforeKeyDown in hotSettings, which wire these in).

  function updateCellCompletionsFromTextarea() {
    const textarea = cellEditorTextareaRef.current;
    if (!textarea) return;
    const value = textarea.value;
    const cursorPos = textarea.selectionStart ?? value.length;
    if (!value.startsWith("=")) { setCellCompletions([]); return; }
    const token = currentAlphaToken(value, cursorPos);
    const matches = matchingCompletions(token, namedCellMap.current);
    setCellCompletions(matches.slice(0, 8));
    setCellCompletionIdx(0);
    const rect = textarea.getBoundingClientRect();
    setCellCompletionPos({ top: rect.bottom, left: rect.left });
  }

  function handleCellEditorInput() {
    updateCellCompletionsFromTextarea();
  }

  function handleCellEditorBlur() {
    const textarea = cellEditorTextareaRef.current;
    if (textarea) {
      textarea.removeEventListener("input", handleCellEditorInput);
      textarea.removeEventListener("blur", handleCellEditorBlur);
    }
    cellEditorTextareaRef.current = null;
    setCellCompletions([]);
    setCellCompletionPos(null);
  }

  /** Splices `name` into the live editor textarea at the current token, mirroring
   *  insertCompletion but writing straight to the DOM textarea Handsontable's
   *  editor owns — a synthetic "input" event tells the editor to pick up the
   *  new value (it doesn't poll the textarea; it listens for that event). */
  function insertCellCompletion(name: string) {
    const textarea = cellEditorTextareaRef.current;
    if (!textarea) return;
    const cursorPos = textarea.selectionStart ?? textarea.value.length;
    const val = textarea.value;
    const before = val.slice(0, cursorPos);
    const after  = val.slice(cursorPos);
    const tokenMatch = before.match(/([A-Za-z]+)$/);
    if (!tokenMatch) return;
    const tokenStart = cursorPos - tokenMatch[1].length;
    const isFunction = FORMULA_FUNCTIONS[name] != null;
    const insertText = isFunction ? `${name}(` : name;
    const newValue   = val.slice(0, tokenStart) + insertText + after;
    const newCursor  = tokenStart + insertText.length;

    textarea.value = newValue;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.setSelectionRange(newCursor, newCursor);
    setCellCompletions([]);
    setCellCompletionPos(null);
  }

  // ── Formula bar change ─────────────────────────────────────────────────

  /** Returns the active cell coords: live selection first, then last-known. */
  function resolveCell(): { row: number; col: number } | null {
    const hot = hotRef.current?.hotInstance as Handsontable | undefined;
    if (!hot) return lastSelectedCellRef.current;
    const sel = hot.getSelectedRange()?.[0];
    return sel ? { row: sel.highlight.row, col: sel.highlight.col } : lastSelectedCellRef.current;
  }

  function handleFormulaBarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setActiveCellValue(val);
    const hot = hotRef.current?.hotInstance as Handsontable | undefined;
    if (!hot) return;
    const cell = resolveCell();
    if (cell) hot.setDataAtCell(cell.row, cell.col, val);
    updateCompletions(val, e.target.selectionStart ?? val.length);
  }

  function handleFormulaBarKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && completions.length === 0) {
      // Commit the current value and return focus to the grid
      e.preventDefault();
      const hot = hotRef.current?.hotInstance as Handsontable | undefined;
      const cell = resolveCell();
      if (hot && cell) {
        // Expand a typed positional rollup (=XSUMRATE(2)) into the stored child-reference form the
        // engine needs, using this cell's own position. No-op for any other input.
        hot.setDataAtCell(cell.row, cell.col, xsumToStored(activeCellValue, curSheetPath(), cell.row));
        // Return keyboard focus to the grid so arrow keys work immediately
        requestAnimationFrame(() => (hot.rootElement as HTMLElement)?.focus());
      }
      setCompletions([]);
      return;
    }
    if (e.key === "Escape" && completions.length === 0) {
      setCompletions([]);
      return;
    }
    if (completions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCompletionIdx(i => (i + 1) % completions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCompletionIdx(i => (i - 1 + completions.length) % completions.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      const fn = completions[completionIdx];
      if (fn) { e.preventDefault(); insertCompletion(fn); }
    } else if (e.key === "Escape") {
      setCompletions([]);
    }
  }

  function handleFormulaBarBlur() {
    // Delay clearing so a click on a completion item fires first
    setTimeout(() => setCompletions([]), 150);
  }

  // ── Styles ────────────────────────────────────────────────────────────

  const TB_BORDER = "1px solid #ccc";
  const tbCell = (extra?: React.CSSProperties): React.CSSProperties => ({
    height: "100%",
    display: "flex",
    alignItems: "center",
    padding: "0 6px",
    fontSize: 12,
    borderRight: TB_BORDER,
    flexShrink: 0,
    ...extra,
  });

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        background: "#fff",
        fontFamily: "Segoe UI, Arial, sans-serif",
        border: templateEditMode ? "5px solid #d32f2f" : undefined,
        boxSizing: "border-box",
      }}
    >
      {templateEditMode && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 32,
            padding: "0 10px",
            gap: 10,
            flexShrink: 0,
            background: "#d32f2f",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Editing template &ldquo;{templateEditMode.name}&rdquo;
          </span>

          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => void handleClearWorkbook()}
            disabled={cleanupBusy}
            style={{
              height: 24, padding: "0 10px", fontSize: 12, fontWeight: 400,
              background: "rgba(255,255,255,0.15)", color: "#fff",
              border: "1px solid rgba(255,255,255,0.6)", cursor: cleanupBusy ? "default" : "pointer",
            }}
          >
            Clear changes
          </button>
          <button
            type="button"
            onClick={() => {
              // Flush the currently displayed sheet immediately so the template's
              // content isn't lost if the debounced autosave hasn't fired yet.
              const hot = hotRef.current?.hotInstance;
              const revId = revIdRef.current;
              if (hot && revId != null) {
                if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
                const curPath = pathStack.current[pathStack.current.length - 1];
                persistSheet(revId, curPath, captureSourceData(hot));
              }
              exitTemplateEdit();
            }}
            style={{
              height: 24, padding: "0 10px", fontSize: 12, fontWeight: 600,
              background: "#fff", color: "#d32f2f",
              border: "1px solid #fff", cursor: "pointer",
            }}
          >
            Save changes
          </button>
        </div>
      )}

      {/* ── Global Handsontable overrides ── */}
      <style>{`
        .ht-yellow-cell { background: ${HIGHLIGHT_BG} !important; }
        .handsontable .ht-yellow-cell { background: ${HIGHLIGHT_BG} !important; }
        .handsontable .ht-project-total-cell { background: #ffe27a !important; }
        .handsontable th { white-space: nowrap; overflow: hidden; }
        .handsontable td { font-size: 12px; }
        .handsontable th {
          font-size: 12px;
          font-weight: 700;
          color: #33475b;
          background-color: #dde6f0 !important;
          border-color: #b7c6d9 !important;
        }
        .handsontable th .colHeader { color: #33475b; }
      `}</style>

      {/* ─────────────────────────────────────────────────────────────────
          Toolbar row 1: active cell | formula bar | Total
      ──────────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", height: 34, borderBottom: TB_BORDER, background: "#eef2f7", flexShrink: 0, position: "relative", padding: "0 8px", gap: 8 }}>

        {/* Active cell reference box — bordered field, like Excel's Name Box */}
        <div
          style={{
            width: 64,
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 12,
            fontWeight: 600,
            color: "#333",
            background: "#fff",
            border: "1px solid #b9c2cc",
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          {activeCell}
        </div>

        {/* "Cell =" label */}
        <div style={{ fontSize: 12, color: "#666", flexShrink: 0 }}>
          Cell =
        </div>

        {/* Formula input + autocomplete dropdown — bordered field, like Excel's formula bar */}
        <div style={{ flex: 1, position: "relative", height: 24, display: "flex", alignItems: "center" }}>
          <input
            ref={formulaBarRef}
            value={activeCellValue}
            onChange={handleFormulaBarChange}
            onKeyDown={handleFormulaBarKeyDown}
            onBlur={handleFormulaBarBlur}
            placeholder=""
            style={{
              width: "100%",
              height: "100%",
              border: "1px solid #b9c2cc",
              borderRadius: 3,
              outline: "none",
              background: "#fff",
              fontSize: 12,
              padding: "0 8px",
              color: "#333",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <FormulaAutocomplete
            completions={completions}
            selectedIndex={completionIdx}
            onSelect={insertCompletion}
            onHover={setCompletionIdx}
            namedCells={namedCellMap.current}
          />
        </div>

        {/* Project total — CostX-style boxed readout at the right of the toolbar */}
        <div
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "0 10px",
            flexShrink: 0,
            whiteSpace: "nowrap",
            background: "#fff",
            border: "1px solid #b9c2cc",
            borderRadius: 3,
            fontSize: 12,
          }}
        >
          <span style={{ color: "#666" }}>Total =</span>
          <span style={{ fontWeight: 700, color: "#1f2d3d" }}>
            {activeProjectTotal != null
              ? activeProjectTotal.toLocaleString("en-NZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 })
              : "—"}
          </span>
        </div>
      </div>

      {/* Transient status message from a maintenance operation */}
      {cleanupMessage && (
        <div style={{ padding: "4px 10px", fontSize: 11, color: "#555", background: "#f7f7ee", borderBottom: TB_BORDER, flexShrink: 0 }}>
          {cleanupMessage}
        </div>
      )}

      {confirmAction && (
        <ConfirmDialog
          title={confirmAction === "clean" ? "Clean orphaned sheets" : "Clear workbook"}
          body={
            confirmAction === "clean"
              ? "This scans every sheet for line items that have been cleared, and permanently removes any build-up sheets left behind for them (including nested rate-buildup sheets). This cannot be undone.\n\nContinue?"
              : "This permanently deletes ALL sheet data for this workbook revision — every level 1, 2 and 3 sheet — and resets it to a single blank sheet. This cannot be undone.\n\nContinue?"
          }
          confirmLabel={confirmAction === "clean" ? "Clean" : "Clear workbook"}
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => runConfirmedAction(confirmAction)}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={pendingDelete.kind === "row" ? "Delete row" : "Delete column"}
          body={
            pendingDelete.kind === "row"
              ? `This permanently deletes ${pendingDelete.to > pendingDelete.from ? `rows ${pendingDelete.from + 1}–${pendingDelete.to + 1}` : `row ${pendingDelete.from + 1}`} and any build-up sheets they own. This cannot be undone.\n\nContinue?`
              : `This permanently deletes ${pendingDelete.to > pendingDelete.from ? `columns ${colLetter(pendingDelete.from)}–${colLetter(pendingDelete.to)}` : `column ${colLetter(pendingDelete.from)}`}. This cannot be undone.\n\nContinue?`
          }
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const hot = hotRef.current?.hotInstance;
            const pd = pendingDelete;
            setPendingDelete(null);
            if (!hot || !pd) return;
            void withWorkbookActivity(pd.kind === "row" ? "Deleting row…" : "Deleting column…", () => {
              const path = curSheetPath();
              if (pd.kind === "row") {
                for (let r = pd.to; r >= pd.from; r--) deleteRowAt(hot, path, r);
              } else {
                for (let c = pd.to; c >= pd.from; c--) deleteColAt(hot, path, c);
              }
              scheduleSaveRef.current();
              hot.render();
            });
          }}
        />
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Breadcrumb column-label header — shown once, above every pill below
      ──────────────────────────────────────────────────────────────────── */}
      {breadcrumb.length >= 1 && (
        <BreadcrumbHeaderRow />
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Breadcrumb trail (M5, unlimited depth): one row per ancestor, from L1 down to the
          immediate parent. The back arrow steps up one level; the trail scrolls if it grows tall.
      ──────────────────────────────────────────────────────────────────── */}
      {breadcrumb.length >= 1 && (
        <div ref={breadcrumbTrailRef} style={{ maxHeight: 132, overflowY: "auto" }}>
          {breadcrumb.map((ctx, i) => (
            <BreadcrumbRow key={i} ctx={ctx} onBack={() => drillUpTo(i)} />
          ))}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Spreadsheet grid
      ──────────────────────────────────────────────────────────────────── */}
      <div
        ref={gridWrapperRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden", position: "relative" }}
        onDragOver={handleGridDragOver}
        onDrop={handleGridDrop}
        onContextMenu={handleGridContextMenu}
      >
        <GridCore hotRef={hotRef} settings={hotSettings} />
        {workbookLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              background: theme.bg.pane,
              zIndex: 20,
            }}
          >
            {loadProgress ? (
              <>
                <div
                  style={{
                    width: 220,
                    height: 6,
                    borderRadius: 3,
                    background: theme.bg.hover,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.round((loadProgress.done / loadProgress.total) * 100)}%`,
                      height: "100%",
                      background: theme.iconAccent,
                      // Sheet-by-sheet progress arrives in discrete chunks (PROGRESS_CHUNK at a
                      // time), so ease the bar's own width change rather than snapping — reads as
                      // smoother motion than it technically is.
                      transition: "width 150ms ease-out",
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, color: theme.text.muted }}>
                  Loading sheets… ({loadProgress.done}/{loadProgress.total})
                </span>
              </>
            ) : (
              <>
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: 32, lineHeight: 1, color: theme.iconAccent, animation: "studiq-spin 1s linear infinite" }}
                >
                  progress_activity
                </span>
                <span style={{ fontSize: 12, color: theme.text.muted }}>Loading workbook…</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Excel-style status bar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 22,
          borderTop: "1px solid #d0d0d0",
          background: "#f0f0f0",
          flexShrink: 0,
          paddingRight: 12,
          justifyContent: "flex-end",
          gap: 20,
          fontSize: 11,
          color: "#333",
          userSelect: "none",
        }}
      >
        {selectionStats ? (
          <>
            <span>Average: {selectionStats.average.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span>Count: {selectionStats.count}</span>
            <span>Sum: {selectionStats.sum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </>
        ) : (
          <span style={{ color: "#aaa" }}></span>
        )}
      </div>

      {templateManagerOpen && <TemplateManagerDialog />}

      {importPrompt && (
        <ImportDimensionDialog
          groupName={importPrompt.groupName}
          options={importPrompt.options}
          defaultKey={importPrompt.defaultKey}
          onCancel={() => setImportPrompt(null)}
          onConfirm={(option) => {
            applyImport(importPrompt.row, importPrompt.groupId, option.key, option.quantity);
            if (importPrompt.blocking) populateArrayRollup(importPrompt.row, importPrompt.groupId, importPrompt.blocking);
            setImportPrompt(null);
          }}
        />
      )}

      {gridContextMenu && (
        <ContextMenu
          x={gridContextMenu.x}
          y={gridContextMenu.y}
          items={gridContextMenu.items}
          onClose={() => setGridContextMenu(null)}
        />
      )}

      {/* In-cell formula autocomplete — portaled since the editing cell can be
          anywhere on screen; positioned under the editor's own textarea. */}
      {cellCompletionPos && createPortal(
        <FormulaAutocomplete
          completions={cellCompletions}
          selectedIndex={cellCompletionIdx}
          onSelect={insertCellCompletion}
          onHover={setCellCompletionIdx}
          namedCells={namedCellMap.current}
          fixedPosition={cellCompletionPos}
        />,
        document.body,
      )}

      {namedCellDialog && (
        <TextInputDialog
          title="New Named Cell"
          label={`Name for ${cellRefLabel(namedCellDialog.row, namedCellDialog.col)} — usable in formulas at any level of this workbook`}
          initialValue=""
          confirmLabel="Create"
          onCancel={() => setNamedCellDialog(null)}
          onConfirm={(value) => {
            const name = value.trim();
            const dialog = namedCellDialog;
            setNamedCellDialog(null);
            if (!dialog) return;
            if (!isValidNamedCellName(name)) {
              window.alert(
                `"${name}" isn't a valid name. Names must start with a letter or underscore, ` +
                `contain only letters, digits, underscores or periods, and must not look like a cell reference (e.g. A1).`,
              );
              return;
            }
            void defineNamedCell(name, curSheetPath(), dialog.row, dialog.col);
          }}
        />
      )}

      {namedCellsManagerOpen && (
        <NamedCellsManagerDialog
          entries={Array.from(namedCellMap.current.values())
            .map((nc): NamedCellEntry => ({ name: nc.name, path: nc.path, ref: cellRefLabel(nc.row, nc.col) }))
            .sort((a, b) => a.name.localeCompare(b.name))}
          isValidName={isValidNamedCellName}
          onClose={closeNamedCellsManager}
          onGoTo={goToNamedCell}
          onRename={(oldName, newName) => void renameNamedCell(oldName, newName)}
          onDelete={(name) => void removeNamedCell(name)}
        />
      )}

      {columnLayoutManagerOpen && (
        <ColumnLayoutDialog
          layout={activeLayout}
          onClose={closeColumnLayoutManager}
          onSave={(next) => {
            // Update the shared active layout, persist (NULL when it's the default), then
            // re-apply headers/widths to the sheet on screen so the rename shows immediately.
            activeLayout = next;
            const revId = revIdRef.current;
            if (revId != null) {
              void saveWorkbookLayout(revId, isDefaultLayout(next) ? null : serializeLayout(next));
            }
            const hot = hotRef.current?.hotInstance;
            if (hot) {
              const path = curSheetPath();
              const base = layoutColumnsFor(sheetKindForPath(path));
              const numCols = hot.countCols();
              hot.updateSettings({
                colHeaders: buildColHeaders(base, numCols),
                colWidths:  buildColWidths(base, numCols),
              });
              // Re-derive so the new user-column formulae apply to the current sheet immediately.
              deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), path, cellExclusionMap.current.get(path));
              hot.render();
            }
          }}
        />
      )}
    </div>
  );
}
