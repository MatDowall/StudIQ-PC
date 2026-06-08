import React, { useRef, useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { HotTable } from "@handsontable/react-wrapper";
import type { HotTableRef } from "@handsontable/react-wrapper";
import { registerAllModules } from "handsontable/registry";
import { textRenderer } from "handsontable/renderers";
import "handsontable/styles/handsontable.css";
import "handsontable/styles/ht-theme-classic.css";
import type Handsontable from "handsontable";
import { HyperFormula } from "hyperformula";
import { useAppStore, DEFAULT_WORKBOOK_FORMAT } from "../store/appStore";
import type { WorkbookFormatApi, MeasurementDto, DimensionGroupPropsDto, PageScaleDto } from "../store/appStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { TemplateManagerDialog } from "./TemplateManagerDialog";
import { ContextMenu } from "./ContextMenu";
import { ImportDimensionDialog, type ImportDisplayOption } from "./ImportDimensionDialog";
import { groupNetQuantity, quantityValueText, type GroupProps, type PagePoint, type Quantity } from "../lib/quantity";
import {
  aggregateFramingGroup,
  parseFramingSettings,
  parseWallFraming,
  type FramingGroupBreakdown,
  type FramingWallInput,
} from "../lib/framing";

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

const LINK_FONT_COLOUR = "#489c35";
const DIMENSION_DRAG_MIME = "application/x-studiq-dimension-group";

const IMPORT_DISPLAY_LABELS: Record<string, string> = {
  count: "Count",
  length: "Length",
  area: "Area",
  wall_area: "Wall surface area",
  volume: "Volume",
};

/**
 * All derived displays a dimension group's geometry can possibly be brought into the
 * workbook as, given its measurement type and default width/height settings — mirrors
 * the derivation matrix in lib/quantity.ts (`deriveQuantity`). E.g. a length measure
 * with a default height can come in as Length or Wall surface area; with both width
 * and height it can also come in as Volume.
 */
function possibleImportDisplays(props: GroupProps): string[] {
  switch (props.measurement_type) {
    case "count":
      return ["count"];
    case "length": {
      const out = ["length"];
      if (props.default_width > 0) out.push("area");
      if (props.default_height > 0) out.push("wall_area");
      if (props.default_width > 0 && props.default_height > 0) out.push("volume");
      return out;
    }
    case "area": {
      const out = ["area"];
      if (props.default_height > 0) out.push("wall_area", "volume");
      return out;
    }
    default:
      return [];
  }
}

interface GroupImportContext {
  props: GroupProps;
  measurements: MeasurementDto[];
  scaleFor: (drawingId: number, pageIndex: number) => number | null;
  framingBreakdown: FramingGroupBreakdown | null;
}

/** Loads everything needed to derive a dimension group's quantity outside of the
 *  Dimensions sidebar (which only keeps this in memory for the selected groups). */
async function loadGroupImportContext(groupId: number): Promise<GroupImportContext> {
  const [measurements, props] = await Promise.all([
    invoke<MeasurementDto[]>("get_measurements_for_group", { groupId }),
    invoke<DimensionGroupPropsDto>("get_dimension_group_props", { nodeId: groupId }),
  ]);

  const pageKeys = Array.from(new Set(measurements.map((m) => `${m.drawing_id}:${m.page_index}`)));
  const scaleEntries = await Promise.all(
    pageKeys.map(async (key) => {
      const [drawingId, pageIndex] = key.split(":").map(Number);
      const scale = await invoke<PageScaleDto | null>("get_page_scale", { drawingId, pageIndex });
      return [key, scale?.mm_per_point ?? null] as const;
    }),
  );
  const scaleMap = new Map(scaleEntries);
  const scaleFor = (drawingId: number, pageIndex: number) => scaleMap.get(`${drawingId}:${pageIndex}`) ?? null;

  let framingBreakdown: FramingGroupBreakdown | null = null;
  if (props.measurement_type === "timber_framing") {
    const walls: FramingWallInput[] = measurements.map((m) => {
      let points: PagePoint[] = [];
      try {
        const parsed = JSON.parse(m.geometry_json);
        if (Array.isArray(parsed)) points = parsed;
      } catch { /* ignore malformed geometry */ }
      return {
        id: m.id,
        points,
        mmPerPoint: scaleFor(m.drawing_id, m.page_index),
        framing: parseWallFraming(m.framing_json),
      };
    });
    framingBreakdown = aggregateFramingGroup(walls, parseFramingSettings(props.framing_props_json));
  }

  return { props, measurements, scaleFor, framingBreakdown };
}

/** Builds the dialog's option list — one entry per possible derived display that
 *  actually yields a quantity for this group's current measurements. */
function buildImportOptions(ctx: GroupImportContext): ImportDisplayOption[] {
  const out: ImportDisplayOption[] = [];
  for (const display of possibleImportDisplays(ctx.props)) {
    const quantity = groupNetQuantity(ctx.measurements, { ...ctx.props, default_display: display }, ctx.scaleFor);
    if (!quantity) continue;
    out.push({ key: display, label: IMPORT_DISPLAY_LABELS[display] ?? display, quantity });
  }
  return out;
}

/** Re-derives a linked cell's current quantity, for the chosen display. */
function deriveLinkedQuantity(ctx: GroupImportContext, display: string): Quantity | null {
  if (ctx.props.measurement_type === "timber_framing") {
    const value = ctx.framingBreakdown?.matchingTotalM ?? 0;
    return value > 0 ? { value, uom: "m" } : null;
  }
  return groupNetQuantity(ctx.measurements, { ...ctx.props, default_display: display }, ctx.scaleFor);
}

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
): void {
  if (guardRef.current) return;
  guardRef.current = true;
  try {
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
        if (gSrc == null || String(gSrc) === "") {
          pass.push([r, COL_FACTOR, "1"]);
        }
        pass.push([r, COL_TOTAL, qtyTotalFormula(r)]);
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
      if (f > 0 && (gSrc == null || String(gSrc) === "")) {
        pass2.push([r, COL_FACTOR, "1"]);
      }
      pass2.push([r, COL_TOTAL, `=F${r + 1}*G${r + 1}`]);
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
  hot.loadData(dataForHot(data));
  deriveLevelFormulas(hot, level, guardRef, kind);
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

/** Coerce a cell value (number, numeric string, formula string, null) to a finite number, defaulting to 0. */
function toNum(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string" && v !== "") { const n = parseFloat(v); if (isFinite(n)) return n; }
  return 0;
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

  // Format toolbar bridge (ribbon ⇄ grid) — see appStore.ts
  const setWorkbookFormat    = useAppStore(s => s.setWorkbookFormat);
  const setWorkbookFormatApi = useAppStore(s => s.setWorkbookFormatApi);

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

  // Workbook maintenance: "clean orphaned sheets" / "clear whole workbook".
  // `cleanupBusy` disables the toolbar buttons while a maintenance op runs;
  // `cleanupMessage` is a short transient status shown beside them; `confirmAction`
  // drives the shared ConfirmDialog (clearing the workbook is destructive).
  const [cleanupBusy,    setCleanupBusy]    = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [confirmAction,  setConfirmAction]  = useState<"clean" | "clear" | null>(null);
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

  // Drag-and-drop import dialog (shown when more than one derived display is possible)
  // and the "Show dimension group" context menu for already-linked cells.
  const [importPrompt, setImportPrompt] = useState<{
    row: number; groupId: number; groupName: string; options: ImportDisplayOption[]; defaultKey: string;
  } | null>(null);
  const [linkContextMenu, setLinkContextMenu] = useState<{ x: number; y: number; link: CellLink } | null>(null);
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

    // Regenerate F/H/J/L/N/P for every row (cheap, idempotent) now that the moved
    // rows' inputs sit at their new positions.
    deriveLevelFormulas(hot, levelRef.current, isAutoUpdatingRef, "standard");
  }

  /** Inserts plain `Description`/`Quantity`/`Unit` line items directly below `afterRow` on
   *  the current (Level 2) sheet — used for the framing group's "<size> Lintel to last" rows.
   *  These are independent sub-quantities (a different framing size to the group's own — see
   *  CLAUDE.md "Timber framing: one quantity per framing size"), so they're placed as plain
   *  takeoff-level values rather than Quantity Build-up drilldowns or dimension-group links.
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
    }
    hot.render();
    scheduleSaveRef.current();
  }

  /** On dropping a timber-framing group: seeds the row's Quantity Build-up sub-sheet
   *  (`<path>/Q<row>`) with one Description/Length row per matching-size component (so
   *  drilling into C:Quantity immediately shows the framing makeup, no manual entry needed),
   *  and inserts a plain "<size> Lintel to last" line item directly below the group's row
   *  for every distinct lintel-size override present.
   *
   *  Lintels of a different size are deliberately NOT folded into the Quantity Build-up —
   *  they're a separate sub-quantity that must not roll into the group's own matchingTotalM
   *  (see CLAUDE.md "Timber framing: one quantity per framing size"); a plain takeoff-level
   *  value is all that's needed since there's nothing to drill into. */
  function populateFramingRollup(row: number, breakdown: FramingGroupBreakdown): void {
    const hot = hotRef.current?.hotInstance;
    const revId = revIdRef.current;
    if (!hot || revId == null) return;
    const path = curSheetPath();

    const matching  = breakdown.components.filter(c => !c.sizeOverride);
    const overrides = breakdown.components.filter(c => !!c.sizeOverride);

    if (matching.length > 0) {
      const qtyPath = `${path}/Q${row}`;
      const qtyData = createEmptyData();
      matching.forEach((c, i) => {
        if (i >= NUM_ROWS) return;
        qtyData[i][COL_DESC]   = c.label;
        qtyData[i][COL_LENGTH] = c.totalM.toFixed(3);
      });
      sheetDataMap.current.set(qtyPath, qtyData);
      persistSheet(revId, qtyPath, qtyData);
    }

    if (overrides.length > 0) {
      // aggregateFramingGroup already groups lintels by size (framingComponentKey
      // includes sizeOverride), so each entry here is one distinct override size.
      const items = overrides.map(c => ({
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
  function handleGridContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const hot = hotRef.current?.hotInstance;
    if (!hot) return;
    const td = (event.target as HTMLElement | null)?.closest("td");
    if (!td) return;
    const coords = hot.getCoords(td);
    if (!coords || coords.row < 0 || (coords.col !== COL_QTY && coords.col !== COL_UNIT)) return;
    const link = getCellLink(curSheetPath(), coords.row, COL_QTY);
    if (!link) return;
    event.preventDefault();
    setLinkContextMenu({ x: event.clientX, y: event.clientY, link });
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

    invoke<string>("load_workbook_sheet", { revisionId: revId, sheetPath: "L1" })
      .then(json => {
        let data: (string | null)[][];
        try { data = padData(JSON.parse(json) as (string | null)[][]); }
        catch { data = createEmptyData(); }
        sheetDataMap.current = new Map([["L1", data]]);
        const hot = hotRef.current?.hotInstance;
        if (hot) loadLevelData(hot, data, 1, isAutoUpdatingRef, "L1");
        syncSheetLinks("L1");
      })
      .catch(() => {
        const empty = createEmptyData();
        sheetDataMap.current = new Map([["L1", empty]]);
        const hot = hotRef.current?.hotInstance;
        if (hot) loadLevelData(hot, empty, 1, isAutoUpdatingRef, "L1");
        syncSheetLinks("L1");
      });
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
      if (hot2) loadLevelData(hot2, data, newLevel, isAutoUpdatingRef, newPath);
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

      if (lv === 2) {
        // Leaving Level 2 → Level 1:
        //   F:Subtotal              = SUM of Level-2 H:Total
        //   J/L/N/P (…-Total)       = SUM of their matching Level-2 columns (pulled through)
        const sumH = sumComputedCol(computed, COL_TOTAL);
        parentData[rowInParent][COL_SUBTOTAL] = sumH !== null ? String(sumH) : null;
        for (const total of [COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL]) {
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
        parentData[rowInParent][COL_QTY] = sumH !== null ? String(sumH) : null;
        sheetDataMap.current.set(parentPath, parentData);
      } else if (lv === 3) {
        // Leaving Level 3 → Level 2:
        //   E:Rate           = SUM of Level-3 H:Total
        //   I/K/M/O (Lab/Mat/Sub/Sum) = SUM of their matching Level-3 columns (pulled through)
        //   J/L/N/P (…-Total)         = formula: pulled-through rate × this row's Quantity (C)
        const sumH = sumComputedCol(computed, COL_TOTAL);
        parentData[rowInParent][COL_RATE] = sumH !== null ? String(sumH) : null;
        const pullThroughCols: Array<[number, number]> = [
          [COL_LAB, COL_LAB_TOTAL],
          [COL_MAT, COL_MAT_TOTAL],
          [COL_SUB, COL_SUB_TOTAL],
          [COL_SUM, COL_SUM_TOTAL],
        ];
        for (const [src, total] of pullThroughCols) {
          const s = sumComputedCol(computed, src);
          parentData[rowInParent][src] = s !== null ? String(s) : null;
          parentData[rowInParent][total] =
            (s !== null) ? `=${COLUMNS[src].letter}${rowInParent + 1}*C${rowInParent + 1}` : null;
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
      if (hot2) loadLevelData(hot2, parentData, newLevel, isAutoUpdatingRef, parentPath);
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

        if (curLevel === 2) {
          // Leaving L2 → L1 rollup: F = SUM(child H); J/L/N/P = SUM(child J/L/N/P)
          // (pulled through); G auto-populate; H = F×G
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const f = sumH ?? 0;
          liveRow[COL_SUBTOTAL] = f !== 0 ? String(f) : null;

          for (const total of [COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL]) {
            const s = sumComputedCol(childComputed, total);
            liveRow[total] = s !== null ? String(s) : null;
          }

          let gRaw: string | null = liveRow[COL_FACTOR];
          if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
          liveRow[COL_FACTOR] = gRaw;
          const g = toNum(gRaw);
          liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
        } else if (curLevel === 3 && isQtyBuildupPath(childPath)) {
          // Leaving a Quantity Build-up sheet → L2 rollup: C:Quantity = SUM(child
          // H:Quantity); I/K/M/O are untouched (they belong to the rate-buildup
          // relationship, not this one) but J/L/N/P = (existing I/K/M/O) × new C must
          // be re-derived; then F = E×C, G auto-populate, H = F×G for that L2 row.
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const cVal = sumH ?? 0;
          liveRow[COL_QTY] = sumH !== null ? String(sumH) : null;

          for (const [src, total] of [
            [COL_LAB, COL_LAB_TOTAL],
            [COL_MAT, COL_MAT_TOTAL],
            [COL_SUB, COL_SUB_TOTAL],
            [COL_SUM, COL_SUM_TOTAL],
          ] as Array<[number, number]>) {
            const srcRaw = liveRow[src];
            liveRow[total] = (srcRaw != null && srcRaw !== "") ? String(toNum(srcRaw) * cVal) : null;
          }

          const e = toNum(liveRow[COL_RATE]);
          const f = e * cVal;
          liveRow[COL_SUBTOTAL] = (e !== 0 || cVal !== 0) ? String(f) : null;

          let gRaw: string | null = liveRow[COL_FACTOR];
          if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
          liveRow[COL_FACTOR] = gRaw;
          const g = toNum(gRaw);
          liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
        } else if (curLevel === 3) {
          // Leaving L3 → L2 rollup: E = SUM(child H); I/K/M/O = SUM(child I/K/M/O) (pulled
          // through); J/L/N/P = pulled-through value × C; then F = E×C, G auto-populate,
          // H = F×G for that L2 row
          const sumH = sumComputedCol(childComputed, COL_TOTAL);
          const e = sumH ?? 0;
          liveRow[COL_RATE] = sumH !== null ? String(sumH) : null;

          const cValForTotals = toNum(liveRow[COL_QTY]);
          for (const [src, total] of [
            [COL_LAB, COL_LAB_TOTAL],
            [COL_MAT, COL_MAT_TOTAL],
            [COL_SUB, COL_SUB_TOTAL],
            [COL_SUM, COL_SUM_TOTAL],
          ] as Array<[number, number]>) {
            const s = sumComputedCol(childComputed, src);
            liveRow[src] = s !== null ? String(s) : null;
            liveRow[total] = s !== null ? String(s * cValForTotals) : null;
          }

          const cVal = toNum(liveRow[COL_QTY]);
          const f = e * cVal;
          liveRow[COL_SUBTOTAL] = (e !== 0 || cVal !== 0) ? String(f) : null;

          let gRaw: string | null = liveRow[COL_FACTOR];
          if (f > 0 && (gRaw == null || gRaw === "")) gRaw = "1";
          liveRow[COL_FACTOR] = gRaw;
          const g = toNum(gRaw);
          liveRow[COL_TOTAL] = (f !== 0 || g !== 0) ? String(f * g) : null;
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
  }

  /** Reset the whole view back to a blank Level 1 sheet (in-memory only). */
  /**
   * Switches the grid to an arbitrary fixed sheet path at a given level, with no
   * breadcrumb ancestry. Used by template-edit mode to jump between the master
   * Level 1 (takeoff) and master Level 2 (rate build-up) sheets — these are
   * standalone "roots" with no real parent rows, unlike normal drill-down targets.
   */
  function jumpToSheet(path: string, level: Level): void {
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
        if (hot2) loadLevelData(hot2, data, level, isAutoUpdatingRef, path);
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
      if (hot) loadLevelData(hot, sheetDataMap.current.get("L1") ?? createEmptyData(), 1, isAutoUpdatingRef, "L1");
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
    td.style.color = isLinked ? LINK_FONT_COLOUR : (isDrillColumn(levelRef.current, col) ? DRILL_FONT_COLOUR : "");
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

    afterSelection(row: number, col: number) {
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

      // ── Level 2/3 auto-derivation: F=E×C, G auto-populate=1, H=F×G ─────
      // Skipped when isAutoUpdatingRef is true — i.e. for the nested afterChange
      // calls fired by our own setDataAtCell writes below (prevents recursion).
      if (!isAutoUpdatingRef.current) {
        const kind = sheetKindForPath(curSheetPath());

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

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
                if (gSrc == null || String(gSrc) === "") {
                  pass.push([r, COL_FACTOR, "1"]);
                }
                pass.push([r, COL_TOTAL, qtyTotalFormula(r)]);
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

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const gSrc = (hot as any).getSourceDataAtCell(r, COL_FACTOR);
                if (f > 0 && (gSrc == null || String(gSrc) === "")) {
                  pass2.push([r, COL_FACTOR, "1"]);
                }

                pass2.push([r, COL_TOTAL, `=F${r + 1}*G${r + 1}`]);
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
                      pass3.push([row, total, `=${COLUMNS[src].letter}${row + 1}*C${row + 1}`]);
                    }
                  } else {
                    const match = pullThroughCols.find(([src]) => src === col);
                    if (match) {
                      const [src, total] = match;
                      pass3.push([row, total, `=${COLUMNS[src].letter}${row + 1}*C${row + 1}`]);
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

        {/* Separator dots */}
        <div style={tbCell({ color: "#aaa", letterSpacing: 2, borderLeft: TB_BORDER })}>···</div>

        {/* "Total =" label */}
        <div style={tbCell({ color: "#555", borderLeft: TB_BORDER })}>Total =</div>

        {/* Total value — placeholder (future milestone: named cell) */}
        <div style={tbCell({ width: 110, color: "#333", fontWeight: 500, justifyContent: "flex-end" })}>
          0
        </div>

        {/* Workbook maintenance: clean orphaned build-up sheets / clear whole workbook */}
        <button
          type="button"
          title="Remove orphaned build-up sheets left behind by deleted line items"
          onClick={() => setConfirmAction("clean")}
          disabled={cleanupBusy}
          style={{
            display: "flex", alignItems: "center", gap: 4, height: "100%", padding: "0 10px",
            border: "none", borderLeft: TB_BORDER, background: "transparent",
            color: cleanupBusy ? "#aaa" : "#555", cursor: cleanupBusy ? "default" : "pointer", fontSize: 11,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>cleaning_services</span>
          Clean orphaned sheets
        </button>
        <button
          type="button"
          title="Delete all sheet data in this workbook revision and start over"
          onClick={() => setConfirmAction("clear")}
          disabled={cleanupBusy}
          style={{
            display: "flex", alignItems: "center", gap: 4, height: "100%", padding: "0 10px",
            border: "none", borderLeft: TB_BORDER, borderRight: "none", background: "transparent",
            color: cleanupBusy ? "#aaa" : "#555", cursor: cleanupBusy ? "default" : "pointer", fontSize: 11,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete_sweep</span>
          Clear workbook
        </button>
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

      {linkContextMenu && (
        <ContextMenu
          x={linkContextMenu.x}
          y={linkContextMenu.y}
          items={[
            {
              label: "Show dimension group",
              action: () => { void goToDimensionGroup(linkContextMenu.link.groupId); },
            },
          ]}
          onClose={() => setLinkContextMenu(null)}
        />
      )}
    </div>
  );
}
