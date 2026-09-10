// v1 → v2 workbook upgrade (M4): turn the baked-literal rollups into declarative XSUM* formulas,
// with a cell-by-cell equivalence gate that ABORTS on any disagreement.
//
// v1 (legacy): drillUp bakes a literal number into each parent rollup cell (E:Rate, C:Quantity,
// L1 F:Subtotal and its J/L/N/P totals, the I/K/M/O pull-through). v2 (declarative): those cells
// hold `=XSUMRATE()` / `=XSUMQTY()` / `=XSUMTOT()` / `=XSUMUSER(n)` / `=XSUMRATEUSER(n)` and read
// their child live. Everything else (F=E*C, H=F*G, J=I*C, hand-typed rates, summary formulas) is
// already a formula and is left untouched.
//
// This module is PURE (no React/Handsontable/Tauri) and tested headlessly — the equivalence gate
// is what makes the upgrade safe to run on a live tender: if the declarative result doesn't match
// the baked result to a tight tolerance for every cell, the upgrade reports the offending cells
// and the caller rolls back rather than persisting anything.
//
// Existing workbooks being upgraded are strictly three levels (L1 cost summary → L2 takeoff → L3
// leaves), so the transform keys off sheet-path DEPTH; leaves (depth ≥ 3) are never rewritten.
// The pull-through user columns follow the shipped default layout (I..P = user 1..8).

import { WorkbookEngine, type SheetPayload } from "./workbookEngine";
import { COL_QTY, COL_RATE, COL_SUBTOTAL, COL_TOTAL, legacyColLetter } from "./workbookCalc";
import { FIRST_USER_COL } from "./workbookLayout";
import { pathToSheetName } from "./workbookSheetNames";

// Upper bound of rows summed from a child column (sheets grow in 50-row chunks).
const CHILD_ROWS = 1000;

/** A CostX-named XSUM over one column of a child sheet, e.g. `=XSUMRATE(L1_sR3!H1:H1000)`. The
 *  child range is an explicit argument, so HyperFormula builds a real dependency edge child→parent
 *  and a multi-level rollup chain converges in one recalc (a volatile function deriving its child
 *  implicitly does not — see the roadmap). `fn` is the CostX function whose name documents intent
 *  (XSUMTOT/XSUMRATE/XSUMQTY/XSUMUSER/XSUMRATEUSER); all are ROUND(SUM(range), dp). */
function childColSum(fn: string, childPath: string, col: number): string {
  const name = pathToSheetName(childPath);
  const c = legacyColLetter(col);
  return `=${fn}(${name}!${c}1:${c}${CHILD_ROWS})`;
}

/** User-column *totals* rolled from a child COST sheet at L1 (J,L,N,P → user 2,4,6,8). */
const COST_TOTAL_USER_NS = [2, 4, 6, 8];
/** User-column *rates* pulled from a child RATE build-up at a takeoff row (I,K,M,O → user 1,3,5,7). */
const RATE_USER_NS = [1, 3, 5, 7];

function userCol(n: number): number {
  return FIRST_USER_COL + (n - 1);
}

export interface UpgradeOptions {
  /** True for a cell the estimator excluded from auto-calc — leave its hand-built content alone. */
  isExcluded?: (path: string, row: number, col: number) => boolean;
  /** True for a cell driven by a live dimension-group link — its child build-up is a one-shot
   *  snapshot, so keep the live literal rather than rolling up a stale child. */
  hasLink?: (path: string, row: number, col: number) => boolean;
}

function depthOf(path: string): number {
  return path.split("/").length;
}

function cloneSheets(sheets: SheetPayload[]): Map<string, (string | null)[][]> {
  return new Map(sheets.map((s) => [s.path, s.data.map((r) => [...r])]));
}

/** Produce the v2 (declarative) sheet set from a v1 (baked) one. Pure — returns a new map and a
 *  count of cells rewritten; does not evaluate or verify (see `upgradeWorkbook`). */
export function transformSheetsToV2(
  sheets: SheetPayload[],
  opts: UpgradeOptions = {},
): { transformed: Map<string, (string | null)[][]>; changed: number } {
  const isExcluded = opts.isExcluded ?? (() => false);
  const hasLink = opts.hasLink ?? (() => false);
  const out = cloneSheets(sheets);
  const paths = new Set(out.keys());
  let changed = 0;

  const setCell = (path: string, row: number, col: number, formula: string) => {
    if (isExcluded(path, row, col) || hasLink(path, row, col)) return;
    const data = out.get(path)!;
    if (row >= data.length) return;
    data[row][col] = formula;
    changed++;
  };

  for (const [path, data] of out) {
    const depth = depthOf(path);
    if (depth >= 3) continue; // leaves: nothing rolls up

    for (let r = 0; r < data.length; r++) {
      const hasRateChild = paths.has(`${path}/R${r}`);
      const hasQtyChild = paths.has(`${path}/Q${r}`);

      const rateChild = `${path}/R${r}`;
      const qtyChild = `${path}/Q${r}`;

      if (depth === 1) {
        // Cost / trade-summary sheet: F:Subtotal (XSUMTOT) + the J/L/N/P totals (XSUMUSER) roll
        // from the L2 child's H and user 2/4/6/8 columns.
        if (hasRateChild) {
          setCell(path, r, COL_SUBTOTAL, childColSum("XSUMTOT", rateChild, COL_TOTAL));
          for (const n of COST_TOTAL_USER_NS) setCell(path, r, userCol(n), childColSum("XSUMUSER", rateChild, userCol(n)));
        }
      } else {
        // Takeoff sheet: E:Rate (XSUMRATE) + I/K/M/O (XSUMRATEUSER) from the rate build-up;
        // C:Quantity (XSUMQTY) from the qty build-up.
        if (hasRateChild) {
          setCell(path, r, COL_RATE, childColSum("XSUMRATE", rateChild, COL_TOTAL));
          for (const n of RATE_USER_NS) setCell(path, r, userCol(n), childColSum("XSUMRATEUSER", rateChild, userCol(n)));
        }
        if (hasQtyChild) {
          setCell(path, r, COL_QTY, childColSum("XSUMQTY", qtyChild, COL_TOTAL));
        }
      }
    }
  }

  return { transformed: out, changed };
}

export interface CellDiff {
  path: string;
  row: number;
  col: number;
  v1: unknown;
  v2: unknown;
}

/** Evaluate two sheet sets and compare every cell. Numbers must match within `tolerance`; other
 *  values must be strictly equal. Returns the disagreements (empty ⇒ equivalent). */
export function verifyEquivalence(
  original: SheetPayload[],
  transformed: Map<string, (string | null)[][]>,
  tolerance = 1e-6,
): CellDiff[] {
  const engA = new WorkbookEngine();
  const engB = new WorkbookEngine();
  try {
    engA.loadAll(original);
    engB.loadAll(original.map((s) => ({ path: s.path, data: transformed.get(s.path) ?? s.data })));
    const diffs: CellDiff[] = [];
    for (const { path, data } of original) {
      const a = engA.getEvaluatedSheet(path);
      const b = engB.getEvaluatedSheet(path);
      const rows = Math.max(a.length, b.length, data.length);
      for (let r = 0; r < rows; r++) {
        const cols = Math.max(a[r]?.length ?? 0, b[r]?.length ?? 0);
        for (let c = 0; c < cols; c++) {
          const va = a[r]?.[c];
          const vb = b[r]?.[c];
          const na = typeof va === "number" ? va : (va === "" || va == null ? 0 : NaN);
          const nb = typeof vb === "number" ? vb : (vb === "" || vb == null ? 0 : NaN);
          // Blank and 0 are the same figure in a rollup column: v1 leaves an all-empty child's
          // total blank, whereas SUM of an empty range is 0 — treat those as equal. Real
          // differences (0 vs 5, "abc" vs "abd") are still caught.
          const equal = (isFinite(na) && isFinite(nb))
            ? Math.abs(na - nb) <= tolerance
            : String(va ?? "") === String(vb ?? "");
          if (!equal) diffs.push({ path, row: r, col: c, v1: va, v2: vb });
        }
      }
    }
    return diffs;
  } finally {
    engA.destroy();
    engB.destroy();
  }
}

export interface UpgradeResult {
  ok: boolean;
  /** The v2 sheets to persist — only trust these when `ok` is true. */
  transformed: Map<string, (string | null)[][]>;
  changed: number;
  /** Cell-level disagreements; non-empty ⇒ upgrade must be aborted and rolled back. */
  diffs: CellDiff[];
}

/** Full upgrade: transform to v2, then verify the declarative result matches the baked one cell
 *  for cell. `ok` is true only when there are zero disagreements — the caller persists the v2
 *  sheets and flips engine_version only then; otherwise it discards them and keeps v1. */
export function upgradeWorkbook(sheets: SheetPayload[], opts: UpgradeOptions = {}): UpgradeResult {
  const { transformed, changed } = transformSheetsToV2(sheets, opts);
  const diffs = verifyEquivalence(sheets, transformed);
  return { ok: diffs.length === 0, transformed, changed, diffs };
}
