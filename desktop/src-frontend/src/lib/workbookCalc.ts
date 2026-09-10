// Pure workbook rollup/derivation arithmetic — the "engine maths" of the CostX-style
// drill-down workbook, extracted out of the 5285-line WorkbookView component so it can be
// unit-tested in isolation (see workbook.test.ts). WorkbookView imports every symbol here
// rather than defining its own, so there is one source of truth for both the live grid and
// the tests.
//
// These functions describe the CURRENT (legacy, "engine v1") behaviour, where a parent
// cell holds a baked literal number rolled up from its child sheet. The column *meanings*
// are the fixed A–P layout StudIQ shipped with; the re-architecture (see the roadmap) will
// make that layout per-workbook data, at which point these helpers take a layout descriptor
// instead of the module constants below. For now the constants ARE the contract.

// ─── Legacy column indices ────────────────────────────────────────────────
// Standard (Code/Description/Quantity/Unit/Rate/Subtotal/Factor/Total + Lab/Mat/Sub/Sum).
export const COL_CODE      = 0;   // A
export const COL_DESC      = 1;   // B
export const COL_QTY       = 2;   // C – drillable at Level 2 (→ Quantity Build-up)
export const COL_UNIT      = 3;   // D
export const COL_RATE      = 4;   // E – drillable at Level 2 (→ Rate Build-up)
export const COL_SUBTOTAL  = 5;   // F – drillable at Level 1 (→ Takeoff)
export const COL_FACTOR    = 6;   // G
export const COL_TOTAL     = 7;   // H
export const COL_LAB       = 8;   // I  – pulled through from rate build-up
export const COL_LAB_TOTAL = 9;   // J  = I×C
export const COL_MAT       = 10;  // K
export const COL_MAT_TOTAL = 11;  // L  = K×C
export const COL_SUB       = 12;  // M
export const COL_SUB_TOTAL = 13;  // N  = M×C
export const COL_SUM       = 14;  // O
export const COL_SUM_TOTAL = 15;  // P  = O×C

// Quantity Build-up sheets reuse the same column *indices* with different A–H meanings:
// C=Count, D=Length, E=Width, F=Height, G=Factor (still 6), H=Quantity (still 7).
export const COL_COUNT  = 2;   // C
export const COL_LENGTH = 3;   // D
export const COL_WIDTH  = 4;   // E
export const COL_HEIGHT = 5;   // F

/** "A"-style column letter for a 0-based index (A–Z then AA…). Used to emit the pull-through
 *  formulas (`=I{r}*C{r}` etc.) whose left operand is the column being totalled. Identical to
 *  the legacy `COLUMNS[i].letter` for every index the rollups touch (0–15 → A–P). */
export function legacyColLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Quantity Build-up H:Quantity formula for row `r` (0-based): C×D×E×F×G, via PRODUCT()
 * rather than `*` — PRODUCT ignores blank cells (same convention as SUM/AVERAGE) instead
 * of coercing them to 0, so leaving e.g. Width/Height unused doesn't zero out a row that
 * only needs Count×Length.
 */
export function qtyTotalFormula(r: number): string {
  const row = r + 1;
  return `=PRODUCT(C${row},D${row},E${row},F${row},G${row})`;
}

/** Coerce a cell value (number, numeric string, formula string, null) to a finite number, defaulting to 0. */
export function toNum(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v === "string" && v !== "") { const n = parseFloat(v); if (isFinite(n)) return n; }
  return 0;
}

/** Coerce an *evaluated* cell value to a number, or `undefined` if the cell is blank —
 *  used by the Excel flatten-export so empty cells stay empty rather than rendering as 0. */
export function numOrUndefined(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : undefined;
}

/** Coerce an evaluated cell value to display text, or "" if blank. */
export function textOrBlank(v: unknown): string {
  return v != null && v !== "" ? String(v) : "";
}

/**
 * Sum a column from Handsontable's computed (evaluated) data, skipping non-numeric cells.
 * Returns null when no numeric data is present (child sheet is blank).
 */
export function sumComputedCol(computedData: unknown[][], colIndex: number): number | null {
  let total = 0;
  let hasData = false;
  for (const row of computedData) {
    const v = (row as unknown[])[colIndex];
    const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? parseFloat(v) : NaN;
    if (isFinite(n)) { total += n; hasData = true; }
  }
  return hasData ? total : null;
}

/** Rolls a Rate Build-up sheet's evaluated H:Total (and Lab/Mat/Sub/Sum pull-through)
 *  into its Level-2 parent row's E:Rate / I,K,M,O / J,L,N,P — the same aggregation
 *  `drillUp` applies when leaving a Level-3 rate sheet. Shared so `recalculateWorkbook`
 *  can apply identical rollups without the user physically drilling through every row. */
export function rollupRateIntoL2(
  parentData: (string | null)[][],
  rowInParent: number,
  computed: unknown[][],
  excluded: (col: number) => boolean,
): void {
  const sumH = sumComputedCol(computed, COL_TOTAL);
  // An empty Rate Build-up sheet (no rows → sumH === null) must NOT overwrite a
  // rate the user entered directly on the parent row. Empty sub-sheets are orphans
  // left behind by drilling into an E:Rate cell without building anything up;
  // rolling their "null" total into E would wipe a real rate and zero the row.
  // Treat "no build-up content" as "no rollup at all" and leave the cell as-is.
  if (sumH === null) return;
  if (!excluded(COL_RATE)) parentData[rowInParent][COL_RATE] = String(sumH);
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
        (s !== null) ? `=${legacyColLetter(src)}${rowInParent + 1}*C${rowInParent + 1}` : null;
    }
  }
}

/** Rolls a Quantity Build-up sheet's evaluated H:Quantity into its Level-2 parent
 *  row's C:Quantity — mirrors `drillUp`'s "leaving a Quantity Build-up sheet" branch. */
export function rollupQtyIntoL2(
  parentData: (string | null)[][],
  rowInParent: number,
  computed: unknown[][],
  excluded: (col: number) => boolean,
): void {
  const sumH = sumComputedCol(computed, COL_TOTAL);
  // Same guard as rollupRateIntoL2: an empty Quantity Build-up sheet must not wipe
  // a quantity entered directly on the parent row (which would zero the whole row's
  // Subtotal/Total). See the comment there — empty orphan sub-sheets are common.
  if (sumH === null) return;
  if (!excluded(COL_QTY)) parentData[rowInParent][COL_QTY] = String(sumH);
}

/** Rolls a Level-2 sheet's evaluated H:Total (and …-Total pull-throughs) into its
 *  Level-1 parent row's F:Subtotal / J,L,N,P — mirrors `drillUp`'s "leaving Level 2"
 *  branch. */
export function rollupL2IntoL1(
  parentData: (string | null)[][],
  rowInParent: number,
  computed: unknown[][],
  excluded: (col: number) => boolean,
): void {
  const sumH = sumComputedCol(computed, COL_TOTAL);
  if (!excluded(COL_SUBTOTAL)) parentData[rowInParent][COL_SUBTOTAL] = sumH !== null ? String(sumH) : null;
  for (const total of [COL_LAB_TOTAL, COL_MAT_TOTAL, COL_SUB_TOTAL, COL_SUM_TOTAL]) {
    if (excluded(total)) continue;
    const s = sumComputedCol(computed, total);
    parentData[rowInParent][total] = s !== null ? String(s) : null;
  }
}

/** Applies the same Factor/Total defaulting `deriveLevelFormulas` (pass 2) applies live in the
 *  grid — auto-populate Factor=1 the first time Subtotal is positive and Factor is blank, and
 *  derive Total=Subtotal×Factor when Total itself is blank. A persisted L1 row's G/H are only
 *  ever written this way when the sheet has actually been displayed in the grid (recalculateWorkbook's
 *  rollupL2IntoL1 deliberately leaves them alone), so the export — which reads straight from
 *  SQLite — must re-apply the same default or Factor/Total show blank despite Subtotal being set. */
export function deriveFactorTotal(
  subtotal: number | undefined,
  factor: number | undefined,
  total: number | undefined,
): { factor?: number; total?: number } {
  if (subtotal == null) return { factor, total };
  if (factor == null && subtotal > 0) factor = 1;
  if (total == null) total = subtotal * (factor ?? 0);
  return { factor, total };
}
