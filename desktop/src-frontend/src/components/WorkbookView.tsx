import React, { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
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
import ExcelJS from "exceljs";
import { ConfirmDialog } from "./ConfirmDialog";
import { TemplateManagerDialog } from "./TemplateManagerDialog";
import { ContextMenu } from "./ContextMenu";
import { TextInputDialog } from "./TextInputDialog";
import { NamedCellsManagerDialog, type NamedCellEntry } from "./NamedCellsManagerDialog";
import { ImportDimensionDialog, type ImportDisplayOption } from "./ImportDimensionDialog";
import { quantityValueText, type Quantity } from "../lib/quantity";
import type { FramingGroupBreakdown } from "../lib/framing";
import {
  loadGroupImportContext,
  buildImportOptions,
  deriveLinkedQuantity,
  type GroupImportContext,
} from "../lib/groupImport";

registerAllModules();

// ─── Column definitions A–P ───────────────────────────────────────────────

const COLUMNS = [
  { letter: "A", label: "Code",         width: 80  },
  { letter: "B", label: "Description",  width: 220 },
  { letter: "C", label: "Quantity",     width: 90  },
  { letter: "D", label: "Unit",         width: 65  },
  { letter: "E", label: "Rate",         width: 85  },
  { letter: "F", label: "Subtotal",     width: 95  },
  { letter: "G", label: "Factor",       width: 75  },
  { letter: "H", label: "Total",        width: 95  },
  { letter: "I", label: "Lab",          width: 75  },
  { letter: "J", label: "Lab - Total",  width: 95  },
  { letter: "K", label: "Mat",          width: 75  },
  { letter: "L", label: "Mat - Total",  width: 95  },
  { letter: "M", label: "Sub",          width: 75  },
  { letter: "N", label: "Sub - Total",  width: 95  },
  { letter: "O", label: "Sum",          width: 75  },
  { letter: "P", label: "Sum - Total",  width: 95  },
] as const;

// Column layout for "Quantity Build-up" sub-sheets (drilled into from a Level 2
// takeoff row's C:Quantity). A–H differ from the standard layout (Count/Length/
// Width/Height/Factor/Quantity, with H = product of C×D×E×F×G); I–P (Lab/Mat/Sub/Sum
// and their totals) are unchanged so the same pull-through machinery applies.
const QTY_COLUMNS = [
  { letter: "A", label: "Code",         width: 80  },
  { letter: "B", label: "Description",  width: 220 },
  { letter: "C", label: "Count",        width: 80  },
  { letter: "D", label: "Length",       width: 80  },
  { letter: "E", label: "Width",        width: 80  },
  { letter: "F", label: "Height",       width: 80  },
  { letter: "G", label: "Factor",       width: 75  },
  { letter: "H", label: "Quantity",     width: 95  },
  { letter: "I", label: "Lab",          width: 75  },
  { letter: "J", label: "Lab - Total",  width: 95  },
  { letter: "K", label: "Mat",          width: 75  },
  { letter: "L", label: "Mat - Total",  width: 95  },
  { letter: "M", label: "Sub",          width: 75  },
  { letter: "N", label: "Sub - Total",  width: 95  },
  { letter: "O", label: "Sum",          width: 75  },
  { letter: "P", label: "Sum - Total",  width: 95  },
] as const;

const NUM_COLS     = COLUMNS.length;   // 16
const NUM_ROWS     = 100;
const COL_SUBTOTAL = 5;                // F – drillable at Level 1
const COL_TOTAL    = 7;                // H – yellow highlight only
const COL_RATE     = 4;                // E – drillable at Level 2
const COL_QTY      = 2;                // C
const COL_FACTOR   = 6;                // G
const COL_LAB       = 8;               // I  – pulled through from rate build-up
const COL_LAB_TOTAL = 9;               // J  = I×C
const COL_MAT       = 10;              // K  – pulled through from rate build-up
const COL_MAT_TOTAL = 11;              // L  = K×C
const COL_SUB       = 12;              // M  – pulled through from rate build-up
const COL_SUB_TOTAL = 13;              // N  = M×C
const COL_SUM       = 14;              // O  – pulled through from rate build-up
const COL_SUM_TOTAL = 15;              // P  = O×C
const COL_CODE     = 0;                // A – used to detect "empty" / cleared line items
const COL_DESC     = 1;                // B – used to detect "empty" / cleared line items
const COL_UNIT     = 3;                // D – populated alongside C on dimension-group import
// Reserved named-cell name: the single L1/H:Total cell a workbook author
// designates as the project grand total (its resolved value is cached on the
// revision via setWorkbookRevisionProjectTotal for the workbook sidebar).
const PROJECT_TOTAL_NAME = "PROJECT_TOTAL";
// Must match hotSettings.rowHeaderWidth so breadcrumb boxes align with grid columns.
const ROW_HDR_W = 50;

const COL_HEADERS = COLUMNS.map(c => `${c.letter}:${c.label}`);
const COL_WIDTHS  = COLUMNS.map(c => c.width);

// Quantity Build-up sheets reuse the same column *indices* with different A–H meanings:
// C=Count, D=Length, E=Width, F=Height, G=Factor (still index 6), H=Quantity (still index 7).
const COL_COUNT  = 2;                  // C
const COL_LENGTH = 3;                  // D
const COL_WIDTH  = 4;                  // E
const COL_HEIGHT = 5;                  // F
const QTY_COL_HEADERS = QTY_COLUMNS.map(c => `${c.letter}:${c.label}`);
const QTY_COL_WIDTHS  = QTY_COLUMNS.map(c => c.width);

// Numeric value columns — everything except Code/Description/Unit, which hold
// text. These are displayed to a fixed number of decimal places with 1000's
// separation (default 2dp; adjustable per cell via the Format toolbar).
const NUMERIC_COLS = new Set<number>(
  COLUMNS.map((_, i) => i).filter(i => i !== COL_CODE && i !== COL_DESC && i !== 3 /* D:Unit */)
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
function isDrillColumn(level: Level, col: number): boolean {
  return (level === 1 && col === COL_SUBTOTAL)
      || (level === 2 && (col === COL_RATE || col === COL_QTY));
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
  return `${COLUMNS[col]?.letter ?? "A"}${row + 1}`;
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
};

const FUNCTION_NAMES = Object.keys(FORMULA_FUNCTIONS);

// ─── Types ────────────────────────────────────────────────────────────────

type Level = 1 | 2 | 3;

// A sheet's "kind" determines its A–H column meaning and derivation/rollup formulas —
// orthogonal to its depth (`Level`). "qty" sheets are Quantity Build-up sheets (drilled
// into from a Level 2 row's C:Quantity); everything else ("standard") uses the existing
// Code/Description/Quantity/Unit/Rate/Subtotal/Factor/Total layout. Derived purely from
// the sheet's path via `isQtyBuildupPath` — see that helper's comment.
type SheetKind = "standard" | "qty";
function sheetKindForPath(path: string): SheetKind {
  return isQtyBuildupPath(path) ? "qty" : "standard";
}

// Reserved sheet paths (never reachable via drill-down — real paths look like
// "L1/R3"). Used both as a template's master takeoff (L2) / rate build-up (L3)
// sheets and, once a workbook is created from that template, as the seeds
// copied into every new Level 2 / Level 3 sheet created in that workbook
// (Level 2 sheets seed from the L2 master, Level 3 sheets from the L3 master).
// Must match the literals used in lib.rs's create_workbook_revision_from_template.
const TEMPLATE_MASTER_L2_PATH = "TEMPLATE_MASTER_L2";
const TEMPLATE_MASTER_L3_PATH = "TEMPLATE_MASTER_L3";
// Master seed for "Quantity Build-up" sheets — drilled into from a Level 2 row's
// C:Quantity (sibling to the Rate Build-up drill from E:Rate; same depth, parent is
// always an L2 row, but a distinct A–H column layout and rollup target).
const TEMPLATE_MASTER_LQ_PATH = "TEMPLATE_MASTER_LQ";

// Real Quantity Build-up sheet paths look like "L1/R3/Q5" — the "/Q<row>" suffix
// (vs. "/R<row>" for Rate Build-up / standard takeoff sheets) is what identifies a
// sheet's "kind" purely from its path, with no extra state needed alongside pathStack.
function isQtyBuildupPath(path: string): boolean {
  return /\/Q\d+$/.test(path) || path === TEMPLATE_MASTER_LQ_PATH;
}

/** Derives a sheet's drill level purely from its path depth — "L1" is level 1,
 *  "L1/R3" is level 2, "L1/R3/R2" or "L1/R3/Q5" is level 3. Used by the Named
 *  Cells manager's "Go to" action, which only has the bound cell's path to work from. */
function levelForPath(path: string): Level {
  const depth = path.split("/").length;
  return Math.min(3, Math.max(1, depth)) as Level;
}

interface BreadcrumbCtx {
  code:        string;
  description: string;
  quantity:    string;
  unit:        string;
  rate:        string;
  subtotal:    string;
  total:       string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function createEmptyData(): (string | null)[][] {
  return Array.from({ length: NUM_ROWS }, () => Array<string | null>(NUM_COLS).fill(null));
}

/** Deep-clone a sheet's source data so each new sheet gets independent rows/cells. */
function cloneSheetData(data: (string | null)[][]): (string | null)[][] {
  return data.map((row) => [...row]);
}

function cloneStyleMap(map: Map<string, CellStyle> | undefined): Map<string, CellStyle> | undefined {
  if (!map || map.size === 0) return undefined;
  return new Map(Array.from(map.entries(), ([key, style]) => [key, { ...style }]));
}

/** Ensure loaded JSON has exactly NUM_ROWS × NUM_COLS, padding with nulls as needed. */
function padData(raw: (string | null)[][]): (string | null)[][] {
  const result = createEmptyData();
  for (let r = 0; r < Math.min(raw.length, NUM_ROWS); r++) {
    const row = raw[r] ?? [];
    for (let c = 0; c < Math.min(row.length, NUM_COLS); c++) {
      const v = row[c];
      result[r][c] = (v != null && v !== "") ? String(v) : null;
    }
  }
  return result;
}

/**
 * Convert stored data (null = empty) to a form safe for Handsontable + HyperFormula.
 * HyperFormula does NOT clear existing formula cells when a null is loaded — only an
 * explicit empty string tells it to clear the cell. This prevents stale formulas from
 * one level leaking into another when the same sheet is reused across drill levels.
 */
/**
 * Quantity Build-up H:Quantity formula for row `r` (0-based): C×D×E×F×G, via PRODUCT()
 * rather than `*` — PRODUCT ignores blank cells (same convention as SUM/AVERAGE) instead
 * of coercing them to 0, so leaving e.g. Width/Height unused doesn't zero out a row that
 * only needs Count×Length.
 */
function qtyTotalFormula(r: number): string {
  const row = r + 1;
  return `=PRODUCT(C${row},D${row},E${row},F${row},G${row})`;
}

function dataForHot(data: (string | null)[][]): string[][] {
  return data.map(row => row.map(cell => cell ?? ""));
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
  excluded?: Set<string>,
): void {
  if (guardRef.current) return;
  guardRef.current = true;
  try {
    const isExcluded = (r: number, c: number) => excluded != null && excluded.has(styleKey(r, c));

    if (kind === "qty") {
      // Quantity Build-up sheets: H = C×D×E×F×G (Count×Length×Width×Height×Factor).
      // G auto-populates to 1 the first time a row has a computable product and Factor
      // is blank — same threshold pattern as the standard G/H derivation. I–P are left
      // untouched: nothing pulls through into a leaf sheet that doesn't drill further.
      const pass: Array<[number, number, string]> = [];
      for (let r = 0; r < NUM_ROWS; r++) {
        const vals = [COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT].map(c => hot.getDataAtCell(r, c));
        const hasInput = vals.some(v => v != null && v !== "");
        if (!hasInput) continue;

        if (!isExcluded(r, COL_FACTOR)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
          if (gSrc == null || String(gSrc) === "") {
            pass.push([r, COL_FACTOR, "1"]);
          }
        }
        if (!isExcluded(r, COL_TOTAL)) pass.push([r, COL_TOTAL, qtyTotalFormula(r)]);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (pass.length) hot.setDataAtCell(pass as any);
      return;
    }

    // Pass 1: F = E×C for every row with a Quantity or Rate value (levels 2 & 3 only —
    // at level 1, F comes from the level-2 drill-up rollup, not from C×E).
    const pass1: Array<[number, number, string]> = [];
    if (level >= 2) {
      for (let r = 0; r < NUM_ROWS; r++) {
        if (isExcluded(r, COL_SUBTOTAL)) continue;
        const cVal = hot.getDataAtCell(r, COL_QTY);
        const eVal = hot.getDataAtCell(r, COL_RATE);
        if ((cVal != null && cVal !== "") || (eVal != null && eVal !== "")) {
          pass1.push([r, COL_SUBTOTAL, `=E${r + 1}*C${r + 1}`]);
        }
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (pass1.length) hot.setDataAtCell(pass1 as any);

    // Pass 2: for every row with an F value, auto-populate G=1 if blank and write H=F×G.
    const pass2: Array<[number, number, string]> = [];
    for (let r = 0; r < NUM_ROWS; r++) {
      const fRaw = hot.getDataAtCell(r, COL_SUBTOTAL);
      if (fRaw == null || fRaw === "") continue;
      const f = typeof fRaw === "number" ? fRaw : parseFloat(String(fRaw)) || 0;

      if (!isExcluded(r, COL_FACTOR)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
        if (f > 0 && (gSrc == null || String(gSrc) === "")) {
          pass2.push([r, COL_FACTOR, "1"]);
        }
      }
      if (!isExcluded(r, COL_TOTAL)) pass2.push([r, COL_TOTAL, `=F${r + 1}*G${r + 1}`]);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (pass2.length) hot.setDataAtCell(pass2 as any);

    // Pass 3 (Level 2 only): J/L/N/P = Lab/Mat/Sub/Sum (I/K/M/O, pulled through from
    // the rate build-up) × Quantity (C) — the "rate × quantity" theory for these columns.
    if (level === 2) {
      const pass3: Array<[number, number, string]> = [];
      const pullThroughCols: Array<[number, number]> = [
        [COL_LAB, COL_LAB_TOTAL],
        [COL_MAT, COL_MAT_TOTAL],
        [COL_SUB, COL_SUB_TOTAL],
        [COL_SUM, COL_SUM_TOTAL],
      ];
      for (let r = 0; r < NUM_ROWS; r++) {
        const cVal = hot.getDataAtCell(r, COL_QTY);
        for (const [src, total] of pullThroughCols) {
          if (isExcluded(r, total)) continue;
          const srcVal = hot.getDataAtCell(r, src);
          if ((srcVal != null && srcVal !== "") || (cVal != null && cVal !== "")) {
            const colLetter = COLUMNS[src].letter;
            pass3.push([r, total, `=${colLetter}${r + 1}*C${r + 1}`]);
          }
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (pass3.length) hot.setDataAtCell(pass3 as any);
    }
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
 * sheets, so the grid's headers must follow whichever sheet is being displayed.
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
  hot.updateSettings({
    colHeaders: kind === "qty" ? QTY_COL_HEADERS : COL_HEADERS,
    colWidths:  kind === "qty" ? QTY_COL_WIDTHS  : COL_WIDTHS,
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hf = (hot.getPlugin('formulas') as any)?.engine;
    if (hf) {
      const sheetId = hf.getSheetId?.('Sheet1') as number | undefined;
      if (sheetId !== undefined) hf.clearSheet(sheetId);
    }
  } catch { /* ignore if HyperFormula API differs across versions */ }
  // Re-point named expressions to the *new* active sheet BEFORE loadData evaluates
  // its formulas. Otherwise a cross-sheet `=margin*2` would first be evaluated while
  // `margin` still points at the just-cleared cell (→ #VALUE!), and the plugin would
  // paint that error; fixing the name afterwards recomputes the engine but doesn't
  // reliably repaint. Doing it here means the first evaluation already sees the
  // correct literal/live reference. See refreshNamedCellsForPath / namedExprFormula.
  reRegisterNamed?.();
  hot.loadData(dataForHot(data));
  deriveLevelFormulas(hot, level, guardRef, kind, excluded);
}

/**
 * Build breadcrumb display context from a row of *evaluated* data (e.g. `hot.getData()`).
 * Using evaluated values — rather than source/formula strings — ensures formula cells
 * (e.g. F holding `=E5*C5`) display their computed numeric result, not the formula text,
 * so BreadcrumbRow can render Subtotal/Total as plain formatted numbers.
 */
function readRowCtx(rowIndex: number, data: unknown[][]): BreadcrumbCtx {
  const r = (data[rowIndex] ?? []) as unknown[];
  const v = (i: number): string => (r[i] != null && r[i] !== "" ? String(r[i]) : "");
  return { code: v(0), description: v(1), quantity: v(2), unit: v(3), rate: v(4), subtotal: v(5), total: v(7) };
}

/** Get the trailing alphabetic token the user is currently typing (for autocomplete). */
function currentAlphaToken(value: string, cursorPos: number): string {
  const before = value.slice(0, cursorPos);
  const match = before.match(/([A-Za-z]+)$/);
  return match ? match[1].toUpperCase() : "";
}

/** Given a partial token, return matching function names. */
function matchingFunctions(token: string): string[] {
  if (!token) return [];
  return FUNCTION_NAMES.filter(f => f.startsWith(token) && f !== token);
}

/** Extract the 0-based row index from the last path segment, e.g. "L1/R3" → 3,
 *  "L1/R3/Q5" → 5. The row index is purely positional — kind-agnostic — so both
 *  "/R<n>" (standard / Rate Build-up) and "/Q<n>" (Quantity Build-up) match. */
function pathLastRow(path: string): number | null {
  const m = path.match(/\/[RQ](\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Sum a column from Handsontable's computed (evaluated) data, skipping non-numeric cells.
 * Returns null when no numeric data is present (child sheet is blank).
 */
function sumComputedCol(computedData: unknown[][], colIndex: number): number | null {
  let total = 0;
  let hasData = false;
  for (const row of computedData) {
    const v = (row as unknown[])[colIndex];
    const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? parseFloat(v) : NaN;
    if (isFinite(n)) { total += n; hasData = true; }
  }
  return hasData ? total : null;
}

/**
 * Evaluates a sheet's raw source rows (formula strings and all) in a standalone,
 * throwaway HyperFormula instance — needed to roll up a freshly-cloned Rate
 * Build-up sheet's Lab/Mat/Sub/Sum columns live, right after the clone is written
 * in memory (there is no live HotTable instance for that not-yet-displayed sheet
 * to read evaluated values from). A plain `parseFloat` over the raw strings would
 * miss any cell entered as a formula (e.g. a rate looked up from the Rates list,
 * or F/H's own `=E×C`/`=F×G`) — those only resolve to a real number once evaluated,
 * exactly as they would the moment a live grid loads this sheet.
 */
function evaluateClonedRows(data: (string | null)[][]): unknown[][] {
  let hf: HyperFormula | null = null;
  try {
    hf = HyperFormula.buildFromArray(dataForHot(data), { licenseKey: "gpl-v3" });
    return hf.getSheetValues(0);
  } catch {
    return data;
  } finally {
    hf?.destroy();
  }
}

/** Coerce a cell value (number, numeric string, formula string, null) to a finite number, defaulting to 0. */
function toNum(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string" && v !== "") { const n = parseFloat(v); if (isFinite(n)) return n; }
  return 0;
}

/** Coerce an *evaluated* cell value to a number, or `undefined` if the cell is blank —
 *  used by the Excel flatten-export so empty cells stay empty rather than rendering as 0. */
function numOrUndefined(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : undefined;
}

/** Coerce an evaluated cell value to display text, or "" if blank. */
function textOrBlank(v: unknown): string {
  return v != null && v !== "" ? String(v) : "";
}

/** Base64-encode an ArrayBuffer in chunks (avoids call-stack limits from spreading huge byte arrays). */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

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
}

/** Build one flattened export row from an evaluated sheet row (see `evaluateClonedRows`). */
function flatExportRowFrom(evaluated: unknown[], sectionCode: string, sectionDesc: string): FlatExportRow {
  return {
    sectionCode, sectionDesc,
    code: textOrBlank(evaluated[COL_CODE]), desc: textOrBlank(evaluated[COL_DESC]),
    qty: numOrUndefined(evaluated[COL_QTY]), unit: textOrBlank(evaluated[COL_UNIT]), rate: numOrUndefined(evaluated[COL_RATE]),
    subtotal: numOrUndefined(evaluated[COL_SUBTOTAL]), factor: numOrUndefined(evaluated[COL_FACTOR]), total: numOrUndefined(evaluated[COL_TOTAL]),
    lab: numOrUndefined(evaluated[COL_LAB]), labTotal: numOrUndefined(evaluated[COL_LAB_TOTAL]),
    mat: numOrUndefined(evaluated[COL_MAT]), matTotal: numOrUndefined(evaluated[COL_MAT_TOTAL]),
    sub: numOrUndefined(evaluated[COL_SUB]), subTotal: numOrUndefined(evaluated[COL_SUB_TOTAL]),
    sum: numOrUndefined(evaluated[COL_SUM]), sumTotal: numOrUndefined(evaluated[COL_SUM_TOTAL]),
  };
}

// ─── Breadcrumb toolbar row ───────────────────────────────────────────────

interface BreadcrumbRowProps {
  ctx:      BreadcrumbCtx;
  onBack:   () => void;
  showCode: boolean; // true = Level-1 context (code + description separate boxes)
}

function BreadcrumbRow({ ctx, onBack, showCode }: BreadcrumbRowProps) {
  const BD: React.CSSProperties = { borderRight: "1px solid #ccc" };
  const cell = (extra?: React.CSSProperties): React.CSSProperties => ({
    height: "100%",
    display: "flex",
    alignItems: "center",
    padding: "0 4px",
    fontSize: 12,
    flexShrink: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    ...BD,
    ...extra,
  });

  return (
    <div style={{ display: "flex", alignItems: "center", height: 28, borderBottom: "1px solid #ccc", background: "#e8e8e8", flexShrink: 0, overflow: "hidden" }}>

      {/* ← back arrow — same width as rowHeaderWidth so column A aligns with the grid */}
      <button
        onClick={onBack}
        title="Return to previous level"
        style={{ width: ROW_HDR_W, height: "100%", border: "none", ...BD, background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: "#555" }}>arrow_back</span>
      </button>

      {/* A: Code – only when showing Level-1 context */}
      {showCode && (
        <div style={cell({ width: COLUMNS[0].width, color: "#555", fontWeight: 500 })}>
          {ctx.code}
        </div>
      )}

      {/* B: Description – takes A+B width if code is hidden */}
      <div style={cell({ width: showCode ? COLUMNS[1].width : COLUMNS[0].width + COLUMNS[1].width, fontWeight: showCode ? 600 : 400 })}>
        {ctx.description}
      </div>

      {/* C: Quantity */}
      <div style={cell({ width: COLUMNS[2].width, justifyContent: "flex-end" })}>
        {ctx.quantity}
      </div>

      {/* D: Unit */}
      <div style={cell({ width: COLUMNS[3].width })}>
        {ctx.unit}
      </div>

      {/* E: Rate */}
      <div style={cell({ width: COLUMNS[4].width, justifyContent: "flex-end" })}>
        {ctx.rate}
      </div>

      {/* F: Subtotal – yellow */}
      <div style={cell({ width: COLUMNS[5].width, justifyContent: "flex-end", background: "#fffff0" })}>
        {formatNumericDisplay(ctx.subtotal, DEFAULT_WORKBOOK_FORMAT.decimals) ?? ctx.subtotal}
      </div>

      {/* H: Total – yellow (factor column omitted; H is already F×G from the sheet) */}
      <div style={cell({ width: COLUMNS[6].width + COLUMNS[7].width, justifyContent: "flex-end", background: "#fffff0" })}>
        {formatNumericDisplay(ctx.total, DEFAULT_WORKBOOK_FORMAT.decimals) ?? ctx.total}
      </div>
    </div>
  );
}

// ─── Formula autocomplete dropdown ────────────────────────────────────────

interface AutocompleteProps {
  completions:    string[];
  selectedIndex:  number;
  onSelect:       (name: string) => void;
  onHover:        (index: number) => void;
}

function FormulaAutocomplete({ completions, selectedIndex, onSelect, onHover }: AutocompleteProps) {
  if (completions.length === 0) return null;
  const fn = FORMULA_FUNCTIONS[completions[selectedIndex]];

  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
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
      {/* Function list */}
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

      {/* Syntax hint for selected function */}
      {fn && (
        <div style={{ borderTop: "1px solid #ddd", padding: "5px 8px", background: "#f8f8f8", borderRadius: "0 0 4px 4px" }}>
          <div style={{ fontWeight: 600, color: "#1a5fa8", marginBottom: 2 }}>{fn.syntax}</div>
          <div style={{ color: "#555" }}>{fn.desc}</div>
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
  const [gridHeight, setGridHeight] = useState(400);

  // Active revision from store (drives data load/save)
  const activeRevisionId = useAppStore(s => s.activeRevisionId);
  const revIdRef = useRef<number | null>(null);
  revIdRef.current = activeRevisionId;

  const setWorkbookRevisionProjectTotal = useAppStore(s => s.setWorkbookRevisionProjectTotal);

  // Format toolbar bridge (ribbon ⇄ grid) — see appStore.ts
  const setWorkbookFormat    = useAppStore(s => s.setWorkbookFormat);
  const setWorkbookFormatApi = useAppStore(s => s.setWorkbookFormatApi);
  const setWorkbookGridApi   = useAppStore(s => s.setWorkbookGridApi);

  // Template manager / template-edit-mode (Settings → Template Manager in the ribbon)
  const templateManagerOpen = useAppStore(s => s.templateManagerOpen);
  const templateEditMode    = useAppStore(s => s.templateEditMode);
  const exitTemplateEdit    = useAppStore(s => s.exitTemplateEdit);
  // Which master sheet is currently shown while editing a template — reset to the
  // takeoff sheet whenever a (different) template is opened for editing.
  const [masterView, setMasterView] = useState<"L1" | "L2" | "L3" | "LQ">("L1");
  const templateIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (templateEditMode && templateEditMode.templateId !== templateIdRef.current) {
      templateIdRef.current = templateEditMode.templateId;
      setMasterView("L1");
    } else if (!templateEditMode) {
      templateIdRef.current = null;
    }
  }, [templateEditMode]);

  // Current drill-down level and breadcrumb context stack
  const [level,      setLevel]      = useState<Level>(1);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbCtx[]>([]);

  // Active cell display / formula bar
  const [activeCell,      setActiveCell]      = useState("A1");
  const [activeCellValue, setActiveCellValue] = useState("");

  // Formula autocomplete
  const [completions,    setCompletions]    = useState<string[]>([]);
  const [completionIdx,  setCompletionIdx]  = useState(0);

  // Last grid cell that had selection focus — used to sync formula bar edits
  // back to the cell even after focus moves to the input element.
  const lastSelectedCellRef = useRef<{ row: number; col: number } | null>(null);

  // Most recent Ctrl+C/copy selection — used by afterPaste to detect "an E:Rate
  // cell was copied" so the paste can clone that row's Rate Build-up sheet onto
  // the destination row (see maybeCloneRateBuildupSheet).
  const lastRateCopyRef = useRef<{
    path: string;
    level: Level;
    startRow: number;
    startCol: number;
    rowCount: number;
    colCount: number;
  } | null>(null);

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
  // Parallel cache of *evaluated* snapshots (hot.getData()), captured at the same
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

  // TEMP DEBUG: window.__ncDump() dumps every named cell's bound path + engine
  // formula + resolved value, plus the current sheet path. Remove once the
  // cross-sheet named-cell bug is resolved.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__ncDump = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hf = (hotRef.current?.hotInstance?.getPlugin('formulas') as any)?.engine;
      const out: Record<string, unknown> = { curSheetPath: pathStack.current[pathStack.current.length - 1] };
      for (const n of namedCellMap.current.values()) {
        out[n.name] = {
          boundPath: n.path, row: n.row, col: n.col,
          formula: (() => { try { return hf?.getNamedExpression(n.name)?.expression; } catch { return "ERR"; } })(),
          value: (() => { try { return hf?.getNamedExpressionValue(n.name); } catch { return "ERR"; } })(),
        };
      }
      // eslint-disable-next-line no-console
      console.log("[NC] dump", JSON.parse(JSON.stringify(out)));
      return out;
    };
  }, []);
  const namedCellsManagerOpen    = useAppStore(s => s.namedCellsManagerOpen);
  const closeNamedCellsManager   = useAppStore(s => s.closeNamedCellsManager);

  // Drag-and-drop import dialog (shown when more than one derived display is possible)
  // and the "Show dimension group" context menu for already-linked cells.
  const [importPrompt, setImportPrompt] = useState<{
    row: number; groupId: number; groupName: string; options: ImportDisplayOption[]; defaultKey: string;
  } | null>(null);
  const [gridContextMenu, setGridContextMenu] = useState<{
    x: number; y: number; items: { label: string; action: () => void; danger?: boolean }[];
  } | null>(null);
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

  /** Adds or removes (row,col) on `path` from the exclusion set and persists it. */
  function setCellExcluded(path: string, row: number, col: number, excluded: boolean) {
    let set = cellExclusionMap.current.get(path);
    if (excluded) {
      if (!set) { set = new Set(); cellExclusionMap.current.set(path, set); }
      set.add(styleKey(row, col));
    } else if (set) {
      set.delete(styleKey(row, col));
      if (set.size === 0) cellExclusionMap.current.delete(path);
    }
    const revId = revIdRef.current;
    if (revId != null) persistSheetExclusions(revId, path);
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
    deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), cellExclusionMap.current.get(path));
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

  /** Builds the HyperFormula named-expression formula for `nc` given the *currently
   *  active* sheet:
   *
   *  - Bound cell is on the active sheet → a **live reference** (`=Sheet1!$C$5`).
   *    HyperFormula then tracks the dependency natively, so editing the bound cell
   *    instantly recomputes *and repaints* every formula referencing the name —
   *    exactly Excel's named-range behaviour. (Only one sheet is ever loaded into
   *    HyperFormula's "Sheet1", so the reference is unambiguous while we're on it.)
   *  - Bound cell is on a *different* sheet → a **literal snapshot** of its
   *    last-known evaluated value. A live `Sheet1!` reference would resolve against
   *    whichever sheet currently occupies "Sheet1" (the wrong cell); and since the
   *    bound cell isn't even visible, there's nothing to update live anyway. The
   *    literal is refreshed by `syncNamedExpressions` whenever sheets change. */
  function namedExprFormula(nc: NamedCell): string {
    if (nc.path === curSheetPath()) {
      const letter = COLUMNS[nc.col]?.letter ?? "A";
      return `=Sheet1!$${letter}$${nc.row + 1}`;
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
    // eslint-disable-next-line no-console
    console.log("[NC] reg", nc.name, "bound=", nc.path, "cur=", curSheetPath(), "formula=", formula, "->", resolved);

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
      await invoke("save_workbook_named_cell", {
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
      await invoke("delete_workbook_named_cell", { revisionId: revId, name });
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
  async function ensureSheetLinksLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedLinkPathsRef.current.has(path)) return;
    loadedLinkPathsRef.current.add(path);
    try {
      const json = await invoke<string>("load_workbook_sheet_links", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, CellLink>;
      const entries = Object.entries(obj);
      if (entries.length > 0) cellLinkMap.current.set(path, new Map(entries));
    } catch { /* non-fatal — sheet simply has no links yet */ }
  }

  /** Loads `path`'s persisted per-cell text formatting (bold/italic/etc.) into
   *  cellStyleMap, once per path — mirrors ensureSheetLinksLoaded. */
  async function ensureSheetStylesLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedStylePathsRef.current.has(path)) return;
    loadedStylePathsRef.current.add(path);
    try {
      const json = await invoke<string>("load_workbook_sheet_styles", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, CellStyle>;
      const entries = Object.entries(obj);
      if (entries.length > 0) cellStyleMap.current.set(path, new Map(entries));
    } catch { /* non-fatal — sheet simply has no styles yet */ }
  }

  /** Loads `path`'s persisted auto-calc exclusion set into cellExclusionMap, once
   *  per path — mirrors ensureSheetStylesLoaded. Awaited *before* the sheet's first
   *  `loadLevelData`/`deriveLevelFormulas` pass (see loadLevelDataExcl) so a freshly
   *  opened excluded cell never gets clobbered by an auto-derived value first. */
  async function ensureSheetExclusionsLoaded(revisionId: number, path: string): Promise<void> {
    if (loadedExclusionPathsRef.current.has(path)) return;
    loadedExclusionPathsRef.current.add(path);
    try {
      const json = await invoke<string>("load_workbook_sheet_exclusions", { revisionId, sheetPath: path });
      const obj = JSON.parse(json) as Record<string, true>;
      const keys = Object.keys(obj);
      if (keys.length > 0) cellExclusionMap.current.set(path, new Set(keys));
    } catch { /* non-fatal — sheet simply has no exclusions yet */ }
  }

  /** Persists `path`'s current auto-calc exclusion set (or clears it if empty). */
  function persistSheetExclusions(revisionId: number, path: string) {
    const set = cellExclusionMap.current.get(path);
    const obj: Record<string, true> = {};
    if (set) for (const key of set) obj[key] = true;
    invoke("save_workbook_sheet_exclusions", {
      revisionId,
      sheetPath: path,
      exclusionsJson: JSON.stringify(obj),
    }).catch(() => {/* non-fatal */});
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
   */
  const refreshLinkedCells = useCallback(async (path: string) => {
    const links = cellLinkMap.current.get(path);
    if (!links || links.size === 0) return;
    for (const [key, link] of Array.from(links.entries())) {
      if (curSheetPath() !== path) return;
      const [rowStr] = key.split(",");
      const row = Number(rowStr);
      let quantity: Quantity | null;
      try {
        quantity = deriveLinkedQuantity(await loadGroupImportContext(link.groupId), link.display);
      } catch {
        continue;
      }
      if (!quantity || curSheetPath() !== path) continue;
      const hot = hotRef.current?.hotInstance;
      if (!hot) continue;
      const newQtyText = quantityValueText(quantity);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(row, COL_QTY) ?? "") !== newQtyText) {
        hot.setDataAtCell(row, COL_QTY, newQtyText);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (String((hot as any).getSourceDataAtCell(row, COL_UNIT) ?? "") !== quantity.uom) {
        hot.setDataAtCell(row, COL_UNIT, quantity.uom);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
   *  line items when `insertLintelRowsBelow` has to displace existing rows. Processes from
   *  the bottom up so a row's incoming entry can never clobber one not yet moved. Entries
   *  that would land past the bottom of the fixed `NUM_ROWS` grid are dropped. */
  function shiftRowKeyedEntries<T>(
    map: Map<string, T> | undefined,
    fromRow: number,
    toRowExclusive: number,
    by: number,
  ): void {
    if (!map || map.size === 0) return;
    for (let r = toRowExclusive - 1; r >= fromRow; r--) {
      for (let c = 0; c < NUM_COLS; c++) {
        const key = styleKey(r, c);
        const val = map.get(key);
        if (val === undefined) continue;
        map.delete(key);
        const dest = r + by;
        if (dest <= NUM_ROWS - 1) map.set(styleKey(dest, c), val);
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
  ): void {
    if (!set || set.size === 0) return;
    for (let r = toRowExclusive - 1; r >= fromRow; r--) {
      for (let c = 0; c < NUM_COLS; c++) {
        const key = styleKey(r, c);
        if (!set.has(key)) continue;
        set.delete(key);
        const dest = r + by;
        if (dest <= NUM_ROWS - 1) set.add(styleKey(dest, c));
      }
    }
  }

  /** Moves the standard-layout line items occupying rows `[fromRow..lastRow]` down by
   *  `by` rows, freeing `[fromRow, fromRow+by)` for new line items without overwriting
   *  what's there — used when auto-placing "<size> Lintel to last" rows directly below a
   *  dropped framing group would otherwise collide with existing takeoff rows.
   *
   *  Formula columns (F/H/J/L/N/P) hold row-relative references (`=E{r}*C{r}`, …) — copying
   *  their strings verbatim would leave them pointing at the old row indices, so this copies
   *  only the input/pulled-through columns (A/B/C/D/E/G/I/K/M/O) verbatim, blanks the formula
   *  columns at the destination, and lets `deriveLevelFormulas` regenerate them correctly for
   *  the new row positions afterwards (mirrors how a freshly-entered row is derived). Rows
   *  that would land past the bottom of the fixed `NUM_ROWS` grid are dropped — sheets
   *  essentially never fill all 100 rows, and losing trailing blank rows is harmless. */
  function shiftStandardRowsDown(hot: Handsontable, path: string, fromRow: number, lastRow: number, by: number): void {
    const data = captureSourceData(hot);
    const verbatimCols = [COL_CODE, COL_DESC, COL_QTY, COL_UNIT, COL_RATE, COL_FACTOR, COL_LAB, COL_MAT, COL_SUB, COL_SUM];
    const formulaCols  = [COL_SUBTOTAL, COL_TOTAL, COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL];

    isAutoUpdatingRef.current = true;
    try {
      const batch: Array<[number, number, string]> = [];
      for (let r = lastRow; r >= fromRow; r--) {
        const dest = r + by;
        if (dest > NUM_ROWS - 1) continue;
        for (const col of verbatimCols) batch.push([dest, col, data[r][col] ?? ""]);
        for (const col of formulaCols) batch.push([dest, col, ""]);
      }
      // Clear the rows the new line items will occupy — their old contents have
      // already been copied onward to fromRow+by.. and won't be touched above.
      for (let r = fromRow; r < fromRow + by; r++) {
        for (let c = 0; c < NUM_COLS; c++) batch.push([r, c, ""]);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (batch.length) hot.setDataAtCell(batch as any);
    } finally {
      isAutoUpdatingRef.current = false;
    }

    shiftRowKeyedEntries(cellLinkMap.current.get(path), fromRow, lastRow + 1, by);
    shiftRowKeyedEntries(cellStyleMap.current.get(path), fromRow, lastRow + 1, by);
    shiftRowKeyedSet(cellExclusionMap.current.get(path), fromRow, lastRow + 1, by);

    // Regenerate F/H/J/L/N/P for every row (cheap, idempotent) now that the moved
    // rows' inputs sit at their new positions.
    deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, "standard", cellExclusionMap.current.get(path));
  }

  /** Inserts plain `Description`/`Quantity`/`Unit` line items directly below `afterRow` on
   *  the current (Level 2) sheet — used for the framing group's "<size> Lintel to last" rows.
   *  Lintels are always independent line items (never folded into the Quantity Build-up),
   *  placed as plain takeoff-level values since there's nothing to drill into.
   *
   *  If existing line items already occupy the rows directly below, shifts them down first
   *  (formula-safely — see `shiftStandardRowsDown`) rather than overwriting them. */
  function insertLintelRowsBelow(
    hot: Handsontable,
    path: string,
    afterRow: number,
    items: Array<{ desc: string; qty: string }>,
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
      shiftStandardRowsDown(hot, path, insertAt, lastOccupied, count);
    }

    for (let i = 0; i < count; i++) {
      const r = insertAt + i;
      hot.setDataAtCell(r, COL_DESC, items[i].desc);
      hot.setDataAtCell(r, COL_QTY, items[i].qty);
      hot.setDataAtCell(r, COL_UNIT, "m");
      // Prevent accidental drill-down into C:Quantity for auto-generated lintel rows —
      // the quantity is a flat total (nothing to build up), and drilling would create a
      // sub-sheet whose rollup would overwrite the placed value on drill-up.
      setCellExcluded(path, r, COL_QTY, true);
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
  function populateFramingRollup(row: number, breakdown: FramingGroupBreakdown): void {
    const hot = hotRef.current?.hotInstance;
    const revId = revIdRef.current;
    if (!hot || revId == null) return;
    const path = curSheetPath();

    const nonLintels = breakdown.components.filter(c => !c.sizeOverride);
    const lintels    = breakdown.components.filter(c => !!c.sizeOverride);

    if (nonLintels.length > 0) {
      const qtyPath = `${path}/Q${row}`;
      const qtyData = createEmptyData();
      nonLintels.forEach((c, i) => {
        if (i >= NUM_ROWS) return;
        qtyData[i][COL_DESC]   = c.label;
        qtyData[i][COL_LENGTH] = c.totalM.toFixed(3);
      });
      sheetDataMap.current.set(qtyPath, qtyData);
      persistSheet(revId, qtyPath, qtyData);
    }

    if (lintels.length > 0) {
      // aggregateFramingGroup groups lintels by size (framingComponentKey includes
      // sizeOverride), so each entry here is one distinct lintel size.
      const items = lintels.map(c => ({
        desc: `${c.sizeOverride} Lintel to last`,
        qty: c.totalM.toFixed(3),
      }));
      insertLintelRowsBelow(hot, path, row, items);
    }
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
      if (ctx.framingBreakdown) populateFramingRollup(row, ctx.framingBreakdown);
      return;
    }

    const options = buildImportOptions(ctx);
    if (options.length === 0) return;
    if (options.length === 1) {
      applyImport(row, groupId, options[0].key, options[0].quantity);
      return;
    }
    const defaultKey = options.some(o => o.key === ctx.props.default_display) ? ctx.props.default_display : options[0].key;
    setImportPrompt({ row, groupId, groupName, options, defaultKey });
  }

  function handleGridDragOver(event: React.DragEvent<HTMLDivElement>) {
    // dataTransfer.types is unreliable mid-drag in WebView2 — accept here and let
    // handleGridDrop validate the payload (it bails out if the MIME type is absent).
    if (levelRef.current === 1) return; // groups can only be dropped at Level 2/3
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleGridDrop(event: React.DragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData(DIMENSION_DRAG_MIME);
    if (!raw || levelRef.current === 1) return;
    event.preventDefault();
    let payload: { groupId: number; name: string };
    try { payload = JSON.parse(raw); } catch { return; }
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const td = (event.target as HTMLElement | null)?.closest("td");
    if (!td) return;
    const coords = hot.getCoords(td);
    if (!coords || coords.row < 0 || coords.col !== COL_QTY) return;
    void handleGroupDrop(payload.groupId, payload.name, coords.row);
  }

  /** Right-click on a linked C:Quantity / D:Unit cell offers "Show dimension group". */
  /** Right-click on any cell offers "New Named Cell"; a linked C:Quantity / D:Unit
   *  cell additionally offers "Show dimension group". */
  function handleGridContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const td = (event.target as HTMLElement | null)?.closest("td");
    if (!td) return;
    const coords = hot.getCoords(td);
    if (!coords || coords.row < 0 || coords.col < 0) return;
    event.preventDefault();

    const items: { label: string; action: () => void; danger?: boolean }[] = [];
    if (coords.col === COL_QTY || coords.col === COL_UNIT) {
      const link = getCellLink(curSheetPath(), coords.row, COL_QTY);
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
    if (curSheetPath() === "L1" && coords.col === COL_TOTAL) {
      const pt = namedCellMap.current.get(PROJECT_TOTAL_NAME);
      const isCurrent = pt?.row === coords.row && pt?.col === coords.col;
      items.push({
        label: isCurrent ? "Project Total ✓" : "Set as Project Total",
        action: () => { void defineNamedCell(PROJECT_TOTAL_NAME, "L1", coords.row, coords.col); },
      });
    }

    // "Exclude/re-enable auto-calculation" — operates on the live selection (falls
    // back to the right-clicked cell when nothing is selected). Lets a template
    // author switch off the F:Subtotal/G:Factor/H:Total auto-derivation for a
    // hand-built summary block that overwrites those columns with its own formulas.
    const selection = getSelectedCells();
    const targetCells = selection.length > 0 ? selection : [{ row: coords.row, col: coords.col }];
    const path = curSheetPath();
    const allExcluded = targetCells.every(({ row, col }) => isCellExcluded(path, row, col));
    items.push({
      label: allExcluded ? "Re-enable auto-calculation" : "Exclude from auto-calculation",
      action: () => toggleExclusionForSelection(!allExcluded),
    });

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
    const drill = isDrillColumn(levelRef.current, cell.col);
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
  // always see the latest captureSourceData / shiftStandardRowsDown / etc. The
  // stable ref itself just delegates, matching the scheduleSaveRef pattern.
  const gridApiImplRef = useRef({
    addRow: () => {},
    insertAbove: () => {},
    insertBelow: () => {},
    exportExcel: async (_levels: FlattenExportLevels) => {},
    print: () => {},
  });

  const gridApiRef = useRef<WorkbookGridApi>({
    addRow:       () => gridApiImplRef.current.addRow(),
    insertAbove:  () => gridApiImplRef.current.insertAbove(),
    insertBelow:  () => gridApiImplRef.current.insertBelow(),
    exportExcel:  (levels) => gridApiImplRef.current.exportExcel(levels),
    print:        () => gridApiImplRef.current.print(),
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

  /** Persist one sheet immediately (fire-and-forget — failures are silent). */
  function persistSheet(revisionId: number, path: string, data: (string | null)[][]) {
    invoke("save_workbook_sheet", {
      revisionId,
      sheetPath: path,
      dataJson: JSON.stringify(data),
    }).catch(() => {/* non-fatal */});

    const links = cellLinkMap.current.get(path);
    invoke("save_workbook_sheet_links", {
      revisionId,
      sheetPath: path,
      linksJson: JSON.stringify(links ? Object.fromEntries(links) : {}),
    }).catch(() => {/* non-fatal */});

    const styles = cellStyleMap.current.get(path);
    invoke("save_workbook_sheet_styles", {
      revisionId,
      sheetPath: path,
      stylesJson: JSON.stringify(styles ? Object.fromEntries(styles) : {}),
    }).catch(() => {/* non-fatal */});

    persistSheetExclusions(revisionId, path);
  }

  /**
   * Extract source data from Handsontable as a string[][] for persistence.
   * Uses getSourceData() so formula strings are stored rather than computed values.
   */
  function captureSourceData(hot: Handsontable): (string | null)[][] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = hot.getSourceData() as any[][];
    const result = createEmptyData();
    for (let r = 0; r < Math.min(raw.length, NUM_ROWS); r++) {
      const row = raw[r] ?? [];
      for (let c = 0; c < Math.min(row.length, NUM_COLS); c++) {
        const cell = row[c];
        result[r][c] = (cell != null && cell !== "") ? String(cell) : null;
      }
    }
    return result;
  }

  /** Schedule a debounced auto-save of the current sheet. */
  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const revId = revIdRef.current;
      const hot   = hotRef.current?.hotInstance;
      if (revId == null || !hot) return;
      const curPath = pathStack.current[pathStack.current.length - 1];
      const data    = captureSourceData(hot);
      sheetDataMap.current.set(curPath, data);
      persistSheet(revId, curPath, data);
    }, 500);
  }

  // Expose scheduleSave in a ref so the memoised hotSettings closure can reach it
  const scheduleSaveRef = useRef(scheduleSave);
  scheduleSaveRef.current = scheduleSave;

  // ── Grid API implementations (updated each render so closures stay fresh) ─

  /**
   * Insert a blank row at `insertAt`, shifting all occupied rows from that
   * position downward by one.  ALL columns are copied verbatim (including
   * F:Subtotal and the …-Total columns which at Level 1 hold plain rollup
   * numbers, not row-relative formulas).  `deriveLevelFormulas` is called
   * afterwards to regenerate the formula columns (F=E×C at L2+, H=F×G at
   * all levels, J/L/N/P×C at L2) for their new row positions — it overwrites
   * only the cells it handles, leaving plain-number cells untouched.
   *
   * This is intentionally NOT `shiftStandardRowsDown`, which clears the
   * …-Total columns and is only correct at Level 2/3 (never at Level 1).
   */
  function insertBlankRowAt(hot: Handsontable, path: string, insertAt: number): void {
    const data = captureSourceData(hot);
    let lastOccupied = -1;
    for (let r = NUM_ROWS - 1; r >= insertAt; r--) {
      if (isLineItemRow(data[r])) { lastOccupied = r; break; }
    }

    isAutoUpdatingRef.current = true;
    try {
      const batch: Array<[number, number, string]> = [];
      if (lastOccupied >= insertAt) {
        for (let r = lastOccupied; r >= insertAt; r--) {
          const dest = r + 1;
          if (dest > NUM_ROWS - 1) continue;
          for (let c = 0; c < NUM_COLS; c++) batch.push([dest, c, data[r][c] ?? ""]);
        }
      }
      for (let c = 0; c < NUM_COLS; c++) batch.push([insertAt, c, ""]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (batch.length) hot.setDataAtCell(batch as any);
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
        invoke("save_workbook_named_cell", {
          revisionId: revId, name: nc.name, sheetPath: nc.path, row: nc.row, col: nc.col,
        }).catch(() => {/* non-fatal */});
      }
    }

    if (lastOccupied >= insertAt) {
      shiftRowKeyedEntries(cellLinkMap.current.get(path), insertAt, lastOccupied + 1, 1);
      shiftRowKeyedEntries(cellStyleMap.current.get(path), insertAt, lastOccupied + 1, 1);
      shiftRowKeyedSet(cellExclusionMap.current.get(path), insertAt, lastOccupied + 1, 1);

      // Remap in-memory sub-sheet caches (bottom-up to avoid collisions).
      // At Level 1 sub-sheets are "<path>/R{r}"; at Level 2 also "<path>/Q{r}".
      const lv = levelRef.current;
      const subPrefixes = lv === 1 ? ["R"] : lv === 2 ? ["R", "Q"] : [];
      if (subPrefixes.length > 0) {
        for (let r = lastOccupied; r >= insertAt; r--) {
          for (const prefix of subPrefixes) {
            const oldSub = `${path}/${prefix}${r}`;
            const newSub = `${path}/${prefix}${r + 1}`;
            // Rename the exact path in every Map cache.
            function remapMapKey<V>(map: Map<string, V>) {
              if (map.has(oldSub)) { map.set(newSub, map.get(oldSub)!); map.delete(oldSub); }
              const subPrefix = `${oldSub}/`;
              for (const key of Array.from(map.keys())) {
                if (key.startsWith(subPrefix)) { map.set(newSub + key.slice(oldSub.length), map.get(key)!); map.delete(key); }
              }
            }
            remapMapKey(sheetDataMap.current as Map<string, unknown>);
            remapMapKey(sheetComputedMap.current as Map<string, unknown>);
            remapMapKey(cellLinkMap.current);
            remapMapKey(cellStyleMap.current);
            remapMapKey(cellExclusionMap.current);
            // Rename in the "loaded" Set caches.
            function remapSetKey(set: Set<string>) {
              if (set.has(oldSub)) { set.add(newSub); set.delete(oldSub); }
              const subPrefix = `${oldSub}/`;
              for (const key of Array.from(set)) {
                if (key.startsWith(subPrefix)) { set.add(newSub + key.slice(oldSub.length)); set.delete(key); }
              }
            }
            remapSetKey(loadedLinkPathsRef.current);
            remapSetKey(loadedStylePathsRef.current);
            remapSetKey(loadedExclusionPathsRef.current);
          }
        }

        // Persist the path renames to SQLite (bottom-up; fire-and-forget).
        const revId = revIdRef.current;
        if (revId != null) {
          for (let r = lastOccupied; r >= insertAt; r--) {
            for (const prefix of subPrefixes) {
              const oldSub = `${path}/${prefix}${r}`;
              const newSub = `${path}/${prefix}${r + 1}`;
              invoke("rename_workbook_sheet_subtree", {
                revisionId: revId, oldPath: oldSub, newPath: newSub,
              }).catch(() => {/* non-fatal */});
            }
          }
        }
      }
    }

    // Regenerate row-relative formula cells at their new positions.
    deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, sheetKindForPath(path), cellExclusionMap.current.get(path));
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
      const targetRow = Math.min(lastOccupied + 1, NUM_ROWS - 1);
      hot.selectCell(targetRow, COL_DESC);
      hot.scrollViewportTo(targetRow, COL_DESC, true, true);
    },

    insertAbove() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const selected = getSelectedCells();
      if (selected.length === 0) return;
      insertBlankRowAt(hot, curSheetPath(), Math.min(...selected.map(c => c.row)));
      hot.selectCell(Math.min(...selected.map(c => c.row)), COL_DESC);
      scheduleSaveRef.current();
    },

    insertBelow() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const selected = getSelectedCells();
      if (selected.length === 0) return;
      const insertAt = Math.max(...selected.map(c => c.row)) + 1;
      if (insertAt >= NUM_ROWS) return;
      insertBlankRowAt(hot, curSheetPath(), insertAt);
      hot.selectCell(insertAt, COL_DESC);
      scheduleSaveRef.current();
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

      const l1Source = await fetchSheetSourceData(revId, "L1");
      const l1Evaluated = evaluateClonedRows(l1Source);

      const flatRows: FlatExportRow[] = [];
      for (let row = 0; row < NUM_ROWS; row++) {
        if (!isLineItemRow(l1Source[row])) continue;
        const sectionEval = l1Evaluated[row] as unknown[];
        const sectionCode = textOrBlank(sectionEval[COL_CODE]);
        const sectionDesc = textOrBlank(sectionEval[COL_DESC]);

        if (!levels.l2) {
          flatRows.push(flatExportRowFrom(sectionEval, sectionCode, sectionDesc));
          continue;
        }

        const childPath = `L1/R${row}`;
        const childSource = await fetchSheetSourceData(revId, childPath);
        const childLineRows: number[] = [];
        for (let cr = 0; cr < NUM_ROWS; cr++) {
          if (isLineItemRow(childSource[cr])) childLineRows.push(cr);
        }

        if (childLineRows.length === 0) {
          // No breakdown sheet — the section row itself is the leaf item.
          flatRows.push(flatExportRowFrom(sectionEval, sectionCode, sectionDesc));
          continue;
        }

        const childEvaluated = evaluateClonedRows(childSource);
        for (const cr of childLineRows) {
          flatRows.push(flatExportRowFrom(childEvaluated[cr] as unknown[], sectionCode, sectionDesc));
        }
      }

      interface ColDef { key: keyof FlatExportRow; header: string; width: number; numFmt?: string; }
      const cols: ColDef[] = [];
      if (includeSectionCols) {
        cols.push({ key: "sectionCode", header: "Section Code", width: 14 });
        cols.push({ key: "sectionDesc", header: "Section", width: 32 });
      }
      cols.push(
        { key: "code",      header: "Code",         width: 12 },
        { key: "desc",      header: "Description",  width: 40 },
        { key: "qty",       header: "Quantity",     width: 12, numFmt: "#,##0.00" },
        { key: "unit",      header: "Unit",         width: 10 },
        { key: "rate",      header: "Rate",         width: 12, numFmt: "#,##0.00" },
        { key: "subtotal",  header: "Subtotal",     width: 14, numFmt: "#,##0.00" },
        { key: "factor",    header: "Factor",       width: 10, numFmt: "0.00" },
        { key: "total",     header: "Total",        width: 14, numFmt: "#,##0.00" },
        { key: "lab",       header: "Lab",           width: 10, numFmt: "#,##0.00" },
        { key: "labTotal",  header: "Lab - Total",   width: 14, numFmt: "#,##0.00" },
        { key: "mat",       header: "Mat",           width: 10, numFmt: "#,##0.00" },
        { key: "matTotal",  header: "Mat - Total",   width: 14, numFmt: "#,##0.00" },
        { key: "sub",       header: "Sub",           width: 10, numFmt: "#,##0.00" },
        { key: "subTotal",  header: "Sub - Total",   width: 14, numFmt: "#,##0.00" },
        { key: "sum",       header: "Sum",           width: 10, numFmt: "#,##0.00" },
        { key: "sumTotal",  header: "Sum - Total",   width: 14, numFmt: "#,##0.00" },
      );

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Workbook");
      sheet.columns = cols.map(c => ({ header: c.header, key: c.key, width: c.width }));
      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E0E0" } };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      for (const r of flatRows) sheet.addRow(r as unknown as Record<string, unknown>);
      for (const c of cols) {
        if (c.numFmt) sheet.getColumn(c.key).numFmt = c.numFmt;
      }

      const filePath = await saveDialog({
        defaultPath: "workbook.xlsx",
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (!filePath) return;
      try {
        const buffer = await workbook.xlsx.writeBuffer();
        const base64 = arrayBufferToBase64(buffer as ArrayBuffer);
        await invoke("write_binary_file", { path: filePath, dataBase64: base64 });
      } catch (err) {
        console.error("Export failed:", err);
      }
    },

    print() {
      const hot = hotRef.current?.hotInstance;
      if (!hot) return;
      const kind = sheetKindForPath(curSheetPath());
      const cols = kind === "qty" ? QTY_COLUMNS : COLUMNS;
      const rawData: unknown[][] = hot.getData() as unknown[][];

      const headerCells = cols.map(c => `<th>${c.letter}:${c.label}</th>`).join("");
      const dataRows = rawData
        .filter(row => row.some(cell => cell != null && cell !== ""))
        .map(row => {
          const cells = cols.map((_c, i) => {
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
  };

  // ── Load root sheet when active revision changes ───────────────────────

  useEffect(() => {
    const revId = activeRevisionId;
    if (revId == null) return;

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

    invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: "L1" })
      .then(json => {
        let data: (string | null)[][];
        try { data = padData(JSON.parse(json) as (string | null)[][]); }
        catch { data = createEmptyData(); }
        sheetDataMap.current = new Map([["L1", data]]);
        const hot = hotRef.current?.hotInstance;
        if (hot) loadLevelDataExcl(hot, data, 1, isAutoUpdatingRef, "L1");
        syncSheetLinks("L1");
      })
      .catch(() => {
        const empty = createEmptyData();
        sheetDataMap.current = new Map([["L1", empty]]);
        const hot = hotRef.current?.hotInstance;
        if (hot) loadLevelDataExcl(hot, empty, 1, isAutoUpdatingRef, "L1");
        syncSheetLinks("L1");
      });

    // Named cells are workbook-wide (not per-sheet) — load the whole set once per
    // revision and register each with HyperFormula so they resolve from any level.
    invoke<string>("load_workbook_named_cells", { revisionId: revId })
      .then(json => {
        let entries: NamedCell[];
        try { entries = JSON.parse(json) as NamedCell[]; } catch { entries = []; }
        namedCellMap.current = new Map(entries.map(nc => [nc.name, nc]));
        for (const nc of entries) registerNamedExpression(nc);
        // If the sheet finished loading before this callback fired, formula cells that
        // reference these named expressions already rendered with stale/=0 values.
        // Force a re-render so they pick up the now-correct named expressions.
        if (entries.length > 0) hotRef.current?.hotInstance?.render();
      })
      .catch(() => { /* non-fatal — workbook simply has no named cells yet */ });
  }, [activeRevisionId]);

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

  const drillDown = useCallback((row: number, col: number) => {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;

    // Close any editor left open by the double-click that triggered this drill before
    // we capture/persist the current sheet or swap in the new one — see closeActiveEditor.
    closeActiveEditor(hot);

    // Cancel any pending debounced save so it doesn't fire on the wrong path
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    const curPath = pathStack.current[pathStack.current.length - 1];
    const curData = captureSourceData(hot);
    sheetDataMap.current.set(curPath, curData);
    // Cache evaluated snapshot too — needed by propagateLiveRollup to sum ancestor
    // sheets' formula columns once this sheet is no longer the displayed one.
    sheetComputedMap.current.set(curPath, hot.getData() as unknown[][]);

    // Persist current sheet before leaving it
    const revId = revIdRef.current;
    if (revId != null) persistSheet(revId, curPath, curData);

    // Use evaluated values (not source/formula strings) for the breadcrumb context —
    // see readRowCtx doc comment.
    const ctx = readRowCtx(row, hot.getData() as unknown[][]);
    // C:Quantity opens a Quantity Build-up sheet ("/Q<row>"); every other drill column
    // (F:Subtotal at L1, E:Rate at L2) opens a standard/Rate Build-up sheet ("/R<row>").
    const isQtyDrill = levelRef.current === 2 && col === COL_QTY;
    const newPath = `${curPath}/${isQtyDrill ? "Q" : "R"}${row}`;
    pathStack.current = [...pathStack.current, newPath];

    // Level we're navigating INTO — needed by loadLevelData to run the correct
    // F/G/H derivation pass (mirrors the setLevel update below).
    const newLevel = (levelRef.current < 3 ? levelRef.current + 1 : levelRef.current) as Level;

    setBreadcrumb(prev => [...prev, ctx]);
    setLevel(prev => (prev < 3 ? (prev + 1) as Level : prev));
    setActiveCell("A1");
    setActiveCellValue("");

    const display = (data: (string | null)[][]) => {
      sheetDataMap.current.set(newPath, data);
      const hot2 = hotRef.current?.hotInstance;
      if (hot2) loadLevelDataExcl(hot2, data, newLevel, isAutoUpdatingRef, newPath);
      syncSheetLinks(newPath);
    };

    // A genuinely new build-up sheet — seed it from the workbook's matching master
    // sheet (copied in from a template at creation time, if any) rather than
    // starting blank. Level 2 sheets seed from the master takeoff (L2); Level 3
    // sheets seed from the master rate build-up (L3) or, for a Quantity Build-up
    // sheet (drilled in via C:Quantity), the master quantity build-up (LQ).
    const masterPath = isQtyDrill
      ? TEMPLATE_MASTER_LQ_PATH
      : (newLevel === 3 ? TEMPLATE_MASTER_L3_PATH : TEMPLATE_MASTER_L2_PATH);
    // Carries the master sheet's per-cell formatting onto the freshly-seeded sheet
    // (mirrors the data clone above) — otherwise template formatting is lost the
    // moment a new Level 2/3 sheet is created from it.
    const seedStylesFrom = (masterStyles: Map<string, CellStyle> | undefined) => {
      const cloned = cloneStyleMap(masterStyles);
      if (cloned) cellStyleMap.current.set(newPath, cloned);
    };
    const seedNewSheet = () => {
      if (sheetDataMap.current.has(masterPath)) {
        seedStylesFrom(cellStyleMap.current.get(masterPath));
        display(cloneSheetData(sheetDataMap.current.get(masterPath)!));
        return;
      }
      if (revId == null) { display(createEmptyData()); return; }
      Promise.all([
        invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: masterPath }),
        ensureSheetStylesLoaded(revId, masterPath),
      ])
        .then(([json]) => {
          seedStylesFrom(cellStyleMap.current.get(masterPath));
          if (!json || json === "[]") { display(createEmptyData()); return; }
          let seed: (string | null)[][];
          try { seed = padData(JSON.parse(json) as (string | null)[][]); }
          catch { display(createEmptyData()); return; }
          sheetDataMap.current.set(masterPath, seed);
          display(cloneSheetData(seed));
        })
        .catch(() => display(createEmptyData()));
    };

    // Load new sheet: prefer in-memory cache; fall back to SQLite; else seed from master
    if (sheetDataMap.current.has(newPath)) {
      requestAnimationFrame(() => display(sheetDataMap.current.get(newPath)!));
    } else if (revId != null) {
      invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: newPath })
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

  const drillUp = useCallback(() => {
    const hot = hotRef.current?.hotInstance;
    if (!hot || pathStack.current.length <= 1) return;

    // See closeActiveEditor — prevents a stale open editor from bleeding its pending
    // value into whichever cell of the parent sheet ends up under it after the swap.
    closeActiveEditor(hot);

    // Cancel any pending debounced save so it doesn't fire on the wrong path
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    const curPath = pathStack.current[pathStack.current.length - 1];
    const curData = captureSourceData(hot);
    sheetDataMap.current.set(curPath, curData);

    // ── Roll up aggregate columns into the parent sheet ───────────────────
    // Use hot.getData() (evaluated values) rather than source data (formula strings)
    // so formula cells contribute their computed result to the sums.
    const computed  = hot.getData() as unknown[][];
    // Cache evaluated snapshot too — needed by propagateLiveRollup to sum ancestor
    // sheets' formula columns once this sheet is no longer the displayed one.
    sheetComputedMap.current.set(curPath, computed);
    const newStack  = pathStack.current.slice(0, -1);
    const parentPath = newStack[newStack.length - 1];
    const rowInParent = pathLastRow(curPath);

    if (rowInParent !== null) {
      const parentData = sheetDataMap.current.get(parentPath) ?? createEmptyData();
      const lv = levelRef.current;
      // Skip writing any column the user has excluded from auto-calc on the parent
      // sheet — e.g. a summary row whose F/G/H carry hand-built formulas must not be
      // clobbered by the drill-up rollup.
      const excluded = (col: number) => isCellExcluded(parentPath, rowInParent, col);

      if (lv === 2) {
        // Leaving Level 2 → Level 1:
        //   F:Subtotal              = SUM of Level-2 H:Total
        //   J/L/N/P (…-Total)       = SUM of their matching Level-2 columns (pulled through)
        const sumH = sumComputedCol(computed, COL_TOTAL);
        if (!excluded(COL_SUBTOTAL)) parentData[rowInParent][COL_SUBTOTAL] = sumH !== null ? String(sumH) : null;
        for (const total of [COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL]) {
          if (excluded(total)) continue;
          const s = sumComputedCol(computed, total);
          parentData[rowInParent][total] = s !== null ? String(s) : null;
        }
        sheetDataMap.current.set(parentPath, parentData);
      } else if (lv === 3 && isQtyBuildupPath(curPath)) {
        // Leaving a Quantity Build-up sheet → Level 2:
        //   C:Quantity = SUM of the build-up sheet's H:Quantity
        // F:Subtotal/G:Factor/H:Total and the J/L/N/P pull-through formulas all
        // reference C, so they're recomputed for free by deriveLevelFormulas when
        // the parent (standard Level 2) sheet is redisplayed — nothing else to write.
        const sumH = sumComputedCol(computed, COL_TOTAL);
        if (!excluded(COL_QTY)) parentData[rowInParent][COL_QTY] = sumH !== null ? String(sumH) : null;
        sheetDataMap.current.set(parentPath, parentData);
      } else if (lv === 3) {
        // Leaving Level 3 → Level 2:
        //   E:Rate           = SUM of Level-3 H:Total
        //   I/K/M/O (Lab/Mat/Sub/Sum) = SUM of their matching Level-3 columns (pulled through)
        //   J/L/N/P (…-Total)         = formula: pulled-through rate × this row's Quantity (C)
        const sumH = sumComputedCol(computed, COL_TOTAL);
        if (!excluded(COL_RATE)) parentData[rowInParent][COL_RATE] = sumH !== null ? String(sumH) : null;
        const pullThroughCols: Array<[number, number]> = [
          [COL_LAB, COL_LAB_TOTAL],
          [COL_MAT, COL_MAT_TOTAL],
          [COL_SUB, COL_SUB_TOTAL],
          [COL_SUM, COL_SUM_TOTAL],
        ];
        for (const [src, total] of pullThroughCols) {
          const s = sumComputedCol(computed, src);
          if (!excluded(src)) parentData[rowInParent][src] = s !== null ? String(s) : null;
          if (!excluded(total)) {
            parentData[rowInParent][total] =
              (s !== null) ? `=${COLUMNS[src].letter}${rowInParent + 1}*C${rowInParent + 1}` : null;
          }
        }
        sheetDataMap.current.set(parentPath, parentData);
      }

      // Persist the updated parent data alongside the current sheet
      const revId = revIdRef.current;
      if (revId != null) {
        persistSheet(revId, curPath, curData);
        persistSheet(revId, parentPath, parentData);
      }
    } else {
      // No row context — just persist the current sheet as normal
      const revId = revIdRef.current;
      if (revId != null) persistSheet(revId, curPath, curData);
    }

    pathStack.current = newStack;

    // Level we're navigating INTO — needed by loadLevelData to run the correct
    // F/G/H derivation pass (mirrors the setLevel update below).
    const newLevel = (levelRef.current > 1 ? levelRef.current - 1 : 1) as Level;

    setBreadcrumb(prev => prev.slice(0, -1));
    setLevel(prev => (prev > 1 ? (prev - 1) as Level : 1));
    setActiveCell("A1");
    setActiveCellValue("");

    requestAnimationFrame(() => {
      const parentData = sheetDataMap.current.get(parentPath) ?? createEmptyData();
      const hot2 = hotRef.current?.hotInstance;
      if (hot2) loadLevelDataExcl(hot2, parentData, newLevel, isAutoUpdatingRef, parentPath);
      syncSheetLinks(parentPath);
    });
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
  const propagateLiveRollup = useCallback(() => {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const lv = levelRef.current;
    if (lv < 2) return;

    const path = pathStack.current;
    // Snapshot the currently-displayed sheet's evaluated data once, up front — it's
    // the base for the innermost (curLevel === lv) rollup step on every invocation.
    const baseComputed: unknown[][] = hot.getData() as unknown[][];

    setBreadcrumb(prev => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      // `childComputed` is reassigned as the loop walks upward (it becomes each
      // ancestor's computed view with the live-derived row substituted in). It must
      // be local to this updater — React.StrictMode invokes state updaters twice in
      // development, and a `let` shared across invocations would carry the previous
      // run's already-rolled-up view into the next run's innermost step, compounding
      // the sums into wildly wrong totals.
      let childComputed: unknown[][] = baseComputed;

      for (let curLevel = lv; curLevel >= 2; curLevel--) {
        const depth      = lv - curLevel;
        const childPath  = path[path.length - depth - 1];
        const parentPath = path[path.length - depth - 2];
        const rowInParent = pathLastRow(childPath);
        if (rowInParent == null || parentPath == null) break;

        const parentSource = sheetDataMap.current.get(parentPath);
        if (!parentSource) break;
        const parentComputed = sheetComputedMap.current.get(parentPath) ?? parentSource;

        // Clone the row so we can override its derived columns without mutating the cache.
        const liveRow = [...(parentSource[rowInParent] ?? [])] as (string | null)[];
        // Skip live-deriving any column the user has excluded from auto-calc on the
        // parent sheet — e.g. a summary row whose F/G/H carry hand-built formulas
        // must keep showing those, not a rolled-up child total, in the breadcrumb.
        const excluded = (col: number) => isCellExcluded(parentPath, rowInParent, col);

        if (curLevel === 2) {
          // Leaving L2 → L1 rollup: F = SUM(child H); J/L/N/P = SUM(child J/L/N/P)
          // (pulled through); G auto-populate; H = F×G
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const f = sumH ?? 0;
          if (!excluded(COL_SUBTOTAL)) liveRow[COL_SUBTOTAL] = f !== 0 ? String(f) : null;

          for (const total of [COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL]) {
            if (excluded(total)) continue;
            const s = sumComputedCol(childComputed, total);
            liveRow[total] = s !== null ? String(s) : null;
          }

          if (!excluded(COL_FACTOR) || !excluded(COL_TOTAL)) {
            let gRaw: string | null = liveRow[COL_FACTOR];
            if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
            if (!excluded(COL_FACTOR)) liveRow[COL_FACTOR] = gRaw;
            const g = toNum(gRaw);
            if (!excluded(COL_TOTAL)) liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
          }
        } else if (curLevel === 3 && isQtyBuildupPath(childPath)) {
          // Leaving a Quantity Build-up sheet → L2 rollup: C:Quantity = SUM(child
          // H:Quantity); I/K/M/O are untouched (they belong to the rate-buildup
          // relationship, not this one) but J/L/N/P = (existing I/K/M/O) × new C must
          // be re-derived; then F = E×C, G auto-populate, H = F×G for that L2 row.
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const cVal = sumH ?? 0;
          if (!excluded(COL_QTY)) liveRow[COL_QTY] = sumH !== null ? String(sumH) : null;

          for (const [src, total] of [
            [COL_LAB, COL_LAB_TOTAL],
            [COL_MAT, COL_MAT_TOTAL],
            [COL_SUB, COL_SUB_TOTAL],
            [COL_SUM, COL_SUM_TOTAL],
          ] as Array<[number, number]>) {
            if (excluded(total)) continue;
            const srcRaw = liveRow[src];
            liveRow[total] = (srcRaw != null && srcRaw !== "") ? String(toNum(srcRaw) * cVal) : null;
          }

          const e = toNum(liveRow[COL_RATE]);
          const f = e * cVal;
          if (!excluded(COL_SUBTOTAL)) liveRow[COL_SUBTOTAL] = (e !== 0 || cVal !== 0) ? String(f) : null;

          if (!excluded(COL_FACTOR) || !excluded(COL_TOTAL)) {
            let gRaw: string | null = liveRow[COL_FACTOR];
            if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
            if (!excluded(COL_FACTOR)) liveRow[COL_FACTOR] = gRaw;
            const g = toNum(gRaw);
            if (!excluded(COL_TOTAL)) liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
          }
        } else if (curLevel === 3) {
          // Leaving L3 → L2 rollup: E = SUM(child H); I/K/M/O = SUM(child I/K/M/O) (pulled
          // through); J/L/N/P = pulled-through value × C; then F = E×C, G auto-populate,
          // H = F×G for that L2 row
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const e = sumH ?? 0;
          if (!excluded(COL_RATE)) liveRow[COL_RATE] = sumH !== null ? String(sumH) : null;

          const cValForTotals = toNum(liveRow[COL_QTY]);
          for (const [src, total] of [
            [COL_LAB, COL_LAB_TOTAL],
            [COL_MAT, COL_MAT_TOTAL],
            [COL_SUB, COL_SUB_TOTAL],
            [COL_SUM, COL_SUM_TOTAL],
          ] as Array<[number, number]>) {
            const s = sumComputedCol(childComputed, src);
            if (!excluded(src)) liveRow[src] = s !== null ? String(s) : null;
            if (!excluded(total)) liveRow[total] = s !== null ? String(s * cValForTotals) : null;
          }

          const cVal = toNum(liveRow[COL_QTY]);
          const f = e * cVal;
          if (!excluded(COL_SUBTOTAL)) liveRow[COL_SUBTOTAL] = (e !== 0 || cVal !== 0) ? String(f) : null;

          if (!excluded(COL_FACTOR) || !excluded(COL_TOTAL)) {
            let gRaw: string | null = liveRow[COL_FACTOR];
            if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
            if (!excluded(COL_FACTOR)) liveRow[COL_FACTOR] = gRaw;
            const g = toNum(gRaw);
            if (!excluded(COL_TOTAL)) liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
          }
        }

        // Refresh this row's breadcrumb entry from the live-derived row
        const breadcrumbIdx = curLevel - 2;
        if (breadcrumbIdx < next.length) {
          next[breadcrumbIdx] = readRowCtx(0, [liveRow]);
        }

        // Build the "evaluated" view of the parent sheet for the NEXT iteration up:
        // cached evaluated values for every row except the one we just live-derived.
        if (curLevel > 2) {
          childComputed = parentComputed.map((row, i) => (i === rowInParent ? liveRow : row));
        }
      }

      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const propagateLiveRollupRef = useRef(propagateLiveRollup);
  propagateLiveRollupRef.current = propagateLiveRollup;

  // ── Workbook maintenance: clean orphaned build-up sheets / clear workbook ──
  //
  // Drilling into a row always derives a child sheet path "<parent>/R<row>",
  // regardless of whether that row holds a real line item. If the user later
  // clears the line item (Code + Description) but had already drilled into it,
  // the child (and grandchild) sheet rows remain in `workbook_sheet_data`,
  // silently still contributing to ancestor totals via rollup. "Clean orphaned
  // sheets" walks the tree from L1, and for every row that no longer looks like
  // a real line item, deletes that row's persisted sub-sheet (and everything
  // beneath it) — a no-op if nothing was ever saved there.

  const isLineItemRow = (row: (string | null)[] | undefined): boolean => {
    if (!row) return false;
    const code = row[COL_CODE];
    const desc = row[COL_DESC];
    return (code != null && code !== "") || (desc != null && desc !== "");
  };

  /** Fetch a sheet's source data — in-memory cache first, else SQLite, else empty. */
  async function fetchSheetSourceData(revisionId: number, path: string): Promise<(string | null)[][]> {
    const cached = sheetDataMap.current.get(path);
    if (cached) return cached;
    try {
      const json = await invoke<string>("load_workbook_sheet", { revisionId, sheetPath: path });
      return padData(JSON.parse(json) as (string | null)[][]);
    } catch {
      return createEmptyData();
    }
  }

  /**
   * Recursively walk the sheet tree from `path` (currently at `level`), deleting
   * the persisted sub-sheet for every row that no longer holds a real line item.
   * Collects the paths actually removed (rows_affected > 0) into `removed`.
   */
  async function pruneOrphansUnder(
    revisionId: number,
    path: string,
    level: Level,
    removed: string[],
  ): Promise<void> {
    const data = await fetchSheetSourceData(revisionId, path);
    for (let r = 0; r < NUM_ROWS; r++) {
      const childPath = `${path}/R${r}`;
      // Level 2 rows can additionally spawn a Quantity Build-up sheet ("/Q<row>",
      // sibling to the Rate Build-up "/R<row>") — prune it alongside the rate one.
      const qtyChildPath = level === 2 ? `${path}/Q${r}` : null;
      if (!isLineItemRow(data[r])) {
        const rowsAffected = await invoke<number>("delete_workbook_sheet_subtree", {
          revisionId,
          sheetPath: childPath,
        });
        if (rowsAffected > 0) removed.push(childPath);
        if (qtyChildPath != null) {
          const qtyRowsAffected = await invoke<number>("delete_workbook_sheet_subtree", {
            revisionId,
            sheetPath: qtyChildPath,
          });
          if (qtyRowsAffected > 0) removed.push(qtyChildPath);
        }
      } else if (level < 3) {
        await pruneOrphansUnder(revisionId, childPath, (level + 1) as Level, removed);
      }
    }
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
   * Clones a row's child Rate Build-up sheet onto another row's, completely
   * independent of the original — invoked from afterPaste when a copied E:Rate
   * value is pasted into a different row's E:Rate cell. Rate Build-up sheets are
   * leaves (level 3 has no drill columns — see isDrillColumn), so this is a
   * single-level deep clone of data + styles + links + exclusions; no recursive
   * descendant walk is needed.
   *
   * A no-op if the source row was never drilled into — nothing exists to clone,
   * so the plain pasted number is left to stand on its own.
   */
  async function maybeCloneRateBuildupSheet(srcPath: string, dstPath: string): Promise<void> {
    if (srcPath === dstPath) return;
    const revId = revIdRef.current;

    let srcData = sheetDataMap.current.get(srcPath);
    if (!srcData) {
      if (revId == null) return;
      try {
        const json = await invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: srcPath });
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
      invoke("delete_workbook_sheet_subtree", { revisionId: revId, sheetPath: dstPath }).catch(() => {/* non-fatal */});
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

    if (revId != null) persistSheet(revId, dstPath, cloned);

    // Live-update the parent row's I/K/M/O (Lab/Mat/Sub/Sum) and J/L/N/P (…-Total)
    // columns right now — the same pull-through rollup drillUp performs on leaving
    // a Rate Build-up sheet — so the paste shows up immediately instead of only
    // after the user manually drills into the new row and back out again.
    const parentPath  = dstPath.slice(0, dstPath.lastIndexOf("/"));
    const rowInParent  = pathLastRow(dstPath);
    const hot = hotRef.current?.hotInstance;
    if (hot && rowInParent != null && curSheetPath() === parentPath) {
      const computedRows = evaluateClonedRows(cloned);
      const pullThroughCols: Array<[number, number]> = [
        [COL_LAB, COL_LAB_TOTAL],
        [COL_MAT, COL_MAT_TOTAL],
        [COL_SUB, COL_SUB_TOTAL],
        [COL_SUM, COL_SUM_TOTAL],
      ];
      const pass: Array<[number, number, string | null]> = [];
      for (const [src, total] of pullThroughCols) {
        const s = sumComputedCol(computedRows, src);
        if (!isCellExcluded(parentPath, rowInParent, src)) pass.push([rowInParent, src, s !== null ? String(s) : null]);
        if (!isCellExcluded(parentPath, rowInParent, total)) {
          pass.push([rowInParent, total, s !== null ? `=${COLUMNS[src].letter}${rowInParent + 1}*C${rowInParent + 1}` : null]);
        }
      }
      if (pass.length) {
        isAutoUpdatingRef.current = true;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hot.setDataAtCell(pass as any);
        } finally {
          isAutoUpdatingRef.current = false;
        }
        propagateLiveRollupRef.current();
        refreshProjectTotal();
      }
    }
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
      invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: path })
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

      const removed: string[] = [];
      await pruneOrphansUnder(revId, "L1", 1, removed);
      for (const p of removed) purgeCachedSubtree(p);

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
      await invoke<number>("clear_workbook_revision_data", { revisionId: revId });
      sheetDataMap.current = new Map([["L1", createEmptyData()]]);
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
    const isDrill = isDrillColumn(levelRef.current, col) && !excluded;
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
    colHeaders: COL_HEADERS,
    colWidths: COL_WIDTHS,
    manualColumnResize: true,
    manualRowResize: true,
    contextMenu: false,
    fillHandle: false,
    autoColumnSize: false,
    stretchH: "none",
    height: 400,

    // ── Formula engine ──────────────────────────────────────────────────
    formulas: {
      engine: HyperFormula,
      sheetName: "Sheet1",
    },

    afterSelection(row: number, col: number, row2: number, col2: number) {
      if (row < 0 || col < 0) return;
      lastSelectedCellRef.current = { row, col };
      const letter = COLUMNS[col]?.letter ?? "A";
      setActiveCell(`${letter}${row + 1}`);
      // Show formula string (source data), not the computed value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hot = (hotRef.current?.hotInstance) as any;
      const val = hot?.getSourceDataAtCell(row, col);
      setActiveCellValue(val != null ? String(val) : "");
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

    // Remembers the copied selection so afterPaste can tell whether an E:Rate
    // cell was part of it — see lastRateCopyRef / maybeCloneRateBuildupSheet.
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

    // Pasting a copied E:Rate value into another row's E:Rate cell clones the
    // source row's Rate Build-up sheet onto the destination row, so the rate
    // (and its full Lab/Mat/Sub/Sum build-up) comes along independently of the
    // original — rather than leaving the destination with just a bare number.
    afterPaste(
      _data: unknown[][],
      coords: Array<{ startRow: number; startCol: number; endRow: number; endCol: number }>,
    ) {
      const copy = lastRateCopyRef.current;
      if (!copy || copy.level !== 2 || levelRef.current !== 2) return;
      const srcColOffset = COL_RATE - copy.startCol;
      if (srcColOffset < 0 || srcColOffset >= copy.colCount) return;

      const dstPath = curSheetPath();
      for (const range of coords ?? []) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            if (c !== COL_RATE) continue;
            const colOffsetInRange = ((c - range.startCol) % copy.colCount + copy.colCount) % copy.colCount;
            if (colOffsetInRange !== srcColOffset) continue;
            const rowOffsetInRange = ((r - range.startRow) % copy.rowCount + copy.rowCount) % copy.rowCount;
            const srcRow = copy.startRow + rowOffsetInRange;
            const srcChildPath = `${copy.path}/R${srcRow}`;
            const dstChildPath = `${dstPath}/R${r}`;
            if (srcChildPath === dstChildPath) continue;
            void maybeCloneRateBuildupSheet(srcChildPath, dstChildPath);
          }
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
        setActiveCellValue(val != null ? String(val) : "");
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
              invoke("save_workbook_sheet_links", {
                revisionId: revId,
                sheetPath: path,
                linksJson: JSON.stringify(Object.fromEntries(links)),
              }).catch(() => {/* non-fatal */});
            }
          }
        }

        const kind = sheetKindForPath(curSheetPath());
        const excludedSet = cellExclusionMap.current.get(curSheetPath());
        const isExcluded = (r: number, c: number) => excludedSet != null && excludedSet.has(styleKey(r, c));

        if (kind === "qty") {
          // ── Quantity Build-up auto-derivation: H = C×D×E×F×G, G auto-populate=1 ──
          const rowsToProcess = new Set<number>();
          for (const ch of changes) {
            const row = ch[0];
            const col = typeof ch[1] === "number" ? ch[1] : -1;
            if (row < 0 || col < 0) continue;
            if (col === COL_COUNT || col === COL_LENGTH || col === COL_WIDTH
              || col === COL_HEIGHT || col === COL_FACTOR) rowsToProcess.add(row);
          }
          if (rowsToProcess.size > 0) {
            isAutoUpdatingRef.current = true;
            try {
              const pass: Array<[number, number, string]> = [];
              for (const r of rowsToProcess) {
                const vals = [COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT].map(c => hot.getDataAtCell(r, c));
                if (!vals.some(v => v != null && v !== "")) continue;

                if (!isExcluded(r, COL_FACTOR)) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
                  if (gSrc == null || String(gSrc) === "") {
                    pass.push([r, COL_FACTOR, "1"]);
                  }
                }
                if (!isExcluded(r, COL_TOTAL)) pass.push([r, COL_TOTAL, qtyTotalFormula(r)]);
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (pass.length) hot.setDataAtCell(pass as any);
            } finally {
              isAutoUpdatingRef.current = false;
            }
          }
        } else {
          // Collect rows where C/E changed (need F rewrite) and rows where F/G
          // changed (need G auto-populate check + H rewrite).
          const cOrERows = new Set<number>();
          const fOrGRows = new Set<number>();
          for (const ch of changes) {
            const row = ch[0];
            const col = typeof ch[1] === "number" ? ch[1] : -1;
            if (row < 0 || col < 0) continue;
            if (col === COL_QTY || col === COL_RATE)          cOrERows.add(row);
            if (col === COL_SUBTOTAL || col === COL_FACTOR)   fOrGRows.add(row);
          }
          const rowsToProcess = new Set([...cOrERows, ...fOrGRows]);

          if (rowsToProcess.size > 0) {
            isAutoUpdatingRef.current = true;
            try {
              // Pass 1: write F = E×C for rows where C or E changed (levels 2 & 3 only —
              // at level 1, F is populated by the level-2 drill-up rollup, not from C×E).
              const pass1: Array<[number, number, string]> = [];
              if (levelRef.current >= 2) {
                for (const r of cOrERows) {
                  if (isExcluded(r, COL_SUBTOTAL)) continue;
                  pass1.push([r, COL_SUBTOTAL, `=E${r + 1}*C${r + 1}`]);
                }
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (pass1.length) hot.setDataAtCell(pass1 as any);

              // Pass 2: for every affected row, conditionally set G=1 and write H=F×G.
              const pass2: Array<[number, number, string]> = [];
              for (const r of rowsToProcess) {
                const fRaw = hot.getDataAtCell(r, COL_SUBTOTAL);
                const f = typeof fRaw === "number" ? fRaw : parseFloat(String(fRaw ?? "")) || 0;

                if (!isExcluded(r, COL_FACTOR)) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
                  if (f > 0 && (gSrc == null || String(gSrc) === "")) {
                    pass2.push([r, COL_FACTOR, "1"]);
                  }
                }

                if (!isExcluded(r, COL_TOTAL)) pass2.push([r, COL_TOTAL, `=F${r + 1}*G${r + 1}`]);
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (pass2.length) hot.setDataAtCell(pass2 as any);

              // Pass 3 (Level 2 only): J/L/N/P = (I/K/M/O) × C — rewrite the formula for any
              // row where the pulled-through Lab/Mat/Sub/Sum value or the Quantity changed.
              if (levelRef.current === 2) {
                const pullThroughCols: Array<[number, number]> = [
                  [COL_LAB, COL_LAB_TOTAL],
                  [COL_MAT, COL_MAT_TOTAL],
                  [COL_SUB, COL_SUB_TOTAL],
                  [COL_SUM, COL_SUM_TOTAL],
                ];
                const pass3: Array<[number, number, string]> = [];
                for (const ch of changes) {
                  const row = ch[0];
                  const col = typeof ch[1] === "number" ? ch[1] : -1;
                  if (row < 0 || col < 0) continue;
                  if (col === COL_QTY) {
                    for (const [src, total] of pullThroughCols) {
                      if (isExcluded(row, total)) continue;
                      pass3.push([row, total, `=${COLUMNS[src].letter}${row + 1}*C${row + 1}`]);
                    }
                  } else {
                    const match = pullThroughCols.find(([src]) => src === col);
                    if (match) {
                      const [src, total] = match;
                      if (!isExcluded(row, total)) pass3.push([row, total, `=${COLUMNS[src].letter}${row + 1}*C${row + 1}`]);
                    }
                  }
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (pass3.length) hot.setDataAtCell(pass3 as any);
              }
            } finally {
              isAutoUpdatingRef.current = false;
            }
          }
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
      const lv = levelRef.current;
      const isDrill =
        (lv === 1 && coords.col === COL_SUBTOTAL) ||
        (lv === 2 && (coords.col === COL_RATE || coords.col === COL_QTY));
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
      if (col === COL_SUBTOTAL || col === COL_TOTAL) {
        props.className = "ht-yellow-cell";
      }
      return props;
    },

    // Standard text-format shortcuts: Ctrl+B / Ctrl+U / Ctrl+I toggle bold,
    // underline and italic on the current selection.
    beforeKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const api = formatApiRef.current;
      if (key === "b") { event.preventDefault(); api.toggleBold(); }
      else if (key === "u") { event.preventDefault(); api.toggleUnderline(); }
      else if (key === "i") { event.preventDefault(); api.toggleItalic(); }
    },

    afterGetColHeader(col: number, TH: HTMLTableCellElement) {
      if (col === COL_SUBTOTAL || col === COL_TOTAL) {
        (TH as HTMLTableCellElement).style.background = "#fffff0";
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
    const matches = matchingFunctions(token);
    setCompletions(matches.slice(0, 8));
    setCompletionIdx(0);
  }

  function insertCompletion(fnName: string) {
    const input = formulaBarRef.current;
    if (!input) return;
    const cursorPos = input.selectionStart ?? activeCellValue.length;
    const val = activeCellValue;
    const before = val.slice(0, cursorPos);
    const after  = val.slice(cursorPos);
    const tokenMatch = before.match(/([A-Za-z]+)$/);
    if (!tokenMatch) return;
    const tokenStart = cursorPos - tokenMatch[1].length;
    const newValue   = val.slice(0, tokenStart) + fnName + "(" + after;
    const newCursor  = tokenStart + fnName.length + 1;

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
        hot.setDataAtCell(cell.row, cell.col, activeCellValue);
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

          <div style={{ display: "flex", marginLeft: 12 }}>
            <button
              type="button"
              onClick={() => { setMasterView("L1"); jumpToSheet("L1", 1); }}
              style={{
                height: 24, padding: "0 10px", fontSize: 12, fontWeight: masterView === "L1" ? 600 : 400,
                background: masterView === "L1" ? "#fff" : "rgba(255,255,255,0.15)",
                color: masterView === "L1" ? "#d32f2f" : "#fff",
                border: "1px solid rgba(255,255,255,0.6)", borderRight: "none", cursor: "pointer",
              }}
            >
              Master Takeoff (L1)
            </button>
            <button
              type="button"
              onClick={() => { setMasterView("L2"); jumpToSheet(TEMPLATE_MASTER_L2_PATH, 2); }}
              style={{
                height: 24, padding: "0 10px", fontSize: 12, fontWeight: masterView === "L2" ? 600 : 400,
                background: masterView === "L2" ? "#fff" : "rgba(255,255,255,0.15)",
                color: masterView === "L2" ? "#d32f2f" : "#fff",
                border: "1px solid rgba(255,255,255,0.6)", borderRight: "none", cursor: "pointer",
              }}
            >
              Master Takeoff (L2)
            </button>
            <button
              type="button"
              onClick={() => { setMasterView("L3"); jumpToSheet(TEMPLATE_MASTER_L3_PATH, 3); }}
              style={{
                height: 24, padding: "0 10px", fontSize: 12, fontWeight: masterView === "L3" ? 600 : 400,
                background: masterView === "L3" ? "#fff" : "rgba(255,255,255,0.15)",
                color: masterView === "L3" ? "#d32f2f" : "#fff",
                border: "1px solid rgba(255,255,255,0.6)", borderRight: "none", cursor: "pointer",
              }}
            >
              Master Rate Build-up (L3)
            </button>
            <button
              type="button"
              onClick={() => { setMasterView("LQ"); jumpToSheet(TEMPLATE_MASTER_LQ_PATH, 3); }}
              style={{
                height: 24, padding: "0 10px", fontSize: 12, fontWeight: masterView === "LQ" ? 600 : 400,
                background: masterView === "LQ" ? "#fff" : "rgba(255,255,255,0.15)",
                color: masterView === "LQ" ? "#d32f2f" : "#fff",
                border: "1px solid rgba(255,255,255,0.6)", cursor: "pointer",
              }}
            >
              Master Quantity Build-up
            </button>
          </div>

          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => { setMasterView("L1"); void handleClearWorkbook(); }}
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
              // Flush the currently displayed sheet immediately so the master
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
        .ht-yellow-cell { background: #fffff0 !important; }
        .handsontable .ht-yellow-cell { background: #fffff0 !important; }
        .handsontable .ht-project-total-cell { background: #ffe27a !important; }
        .handsontable th { white-space: nowrap; overflow: hidden; }
        .handsontable td { font-size: 12px; }
        .handsontable th { font-size: 12px; }
      `}</style>

      {/* ─────────────────────────────────────────────────────────────────
          Toolbar row 1: active cell | formula bar | Total
      ──────────────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", height: 28, borderBottom: TB_BORDER, background: "#f0f0f0", flexShrink: 0, position: "relative" }}>

        {/* Active cell reference box */}
        <div style={tbCell({ width: 64, fontWeight: 600, color: "#333", justifyContent: "center" })}>
          {activeCell}
        </div>

        {/* "Cell =" label */}
        <div style={tbCell({ width: 48, color: "#666" })}>
          Cell =
        </div>

        {/* Formula input + autocomplete dropdown */}
        <div style={{ flex: 1, position: "relative", height: "100%", display: "flex", alignItems: "center" }}>
          <input
            ref={formulaBarRef}
            value={activeCellValue}
            onChange={handleFormulaBarChange}
            onKeyDown={handleFormulaBarKeyDown}
            onBlur={handleFormulaBarBlur}
            placeholder=""
            style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 12, padding: "0 6px", color: "#333", fontFamily: "inherit", height: "100%" }}
          />
          <FormulaAutocomplete
            completions={completions}
            selectedIndex={completionIdx}
            onSelect={insertCompletion}
            onHover={setCompletionIdx}
          />
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

      {/* ─────────────────────────────────────────────────────────────────
          Toolbar row 2 (Level 2+): Level-1 row context + back arrow
      ──────────────────────────────────────────────────────────────────── */}
      {level >= 2 && breadcrumb.length >= 1 && (
        <BreadcrumbRow ctx={breadcrumb[0]} onBack={drillUp} showCode />
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Toolbar row 3 (Level 3): Level-2 row context + back arrow
      ──────────────────────────────────────────────────────────────────── */}
      {level >= 3 && breadcrumb.length >= 2 && (
        <BreadcrumbRow ctx={breadcrumb[1]} onBack={drillUp} showCode={false} />
      )}

      {/* ─────────────────────────────────────────────────────────────────
          Spreadsheet grid
      ──────────────────────────────────────────────────────────────────── */}
      <div
        ref={gridWrapperRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        onDragOver={handleGridDragOver}
        onDrop={handleGridDrop}
        onContextMenu={handleGridContextMenu}
      >
        <GridCore hotRef={hotRef} settings={hotSettings} />
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
    </div>
  );
}
