// Golden-workbook regression suite — the equivalence oracle for the workbook
// re-architecture (see the CostX roadmap). It pins TWO things:
//
//  1. The pure rollup arithmetic extracted into workbookCalc.ts — the "engine v1"
//     behaviour where a parent cell holds a baked literal rolled up from its child.
//  2. A full end-to-end drill-up of a fixture three-level workbook, evaluated through
//     the *real* HyperFormula engine the app uses, asserting the numbers that reach
//     the L1 grand total.
//
// Every later milestone (multi-sheet engine, columns-as-data, the XSUM* family, the
// declarative rollup) must keep this suite green. When the engine becomes declarative,
// the v2 path should reproduce these same totals — that is what "no silent drift" means.

import { describe, it, expect } from "vitest";
import { HyperFormula } from "hyperformula";
import {
  COL_QTY, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL,
  COL_LAB, COL_LAB_TOTAL, COL_MAT, COL_MAT_TOTAL,
  COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT,
  legacyColLetter, qtyTotalFormula, toNum, numOrUndefined, textOrBlank,
  sumComputedCol, rollupRateIntoL2, rollupQtyIntoL2, rollupL2IntoL1, deriveFactorTotal,
} from "./workbookCalc";

// ─── Test helpers mirroring WorkbookView's engine usage ────────────────────

const NUM_COLS = 16; // A–P

function emptyRow(): (string | null)[] {
  return Array<string | null>(NUM_COLS).fill(null);
}
function emptySheet(rows: number): (string | null)[][] {
  return Array.from({ length: rows }, emptyRow);
}
/** Same null→"" mapping WorkbookView's dataForHot applies before building the engine. */
function dataForHot(data: (string | null)[][]): string[][] {
  return data.map((row) => row.map((cell) => cell ?? ""));
}
/** Evaluate a sheet's source rows through the real engine — the exact shape of
 *  WorkbookView.evaluateClonedRows, so the suite exercises the app's own maths. */
function evaluate(data: (string | null)[][]): unknown[][] {
  const hf = HyperFormula.buildFromArray(dataForHot(data), { licenseKey: "gpl-v3" });
  try {
    return hf.getSheetValues(0);
  } finally {
    hf.destroy();
  }
}
const noneExcluded = () => false;

// ─── Column-letter contract ────────────────────────────────────────────────

describe("legacyColLetter", () => {
  it("maps 0–15 to A–P", () => {
    expect([0, 1, 2, 5, 7, 8, 15].map(legacyColLetter)).toEqual(["A", "B", "C", "F", "H", "I", "P"]);
  });
  it("grows to double letters past Z", () => {
    expect(legacyColLetter(26)).toBe("AA");
    expect(legacyColLetter(27)).toBe("AB");
  });
});

// ─── Numeric coercion ──────────────────────────────────────────────────────

describe("toNum / numOrUndefined / textOrBlank", () => {
  it("toNum coerces numbers, numeric strings, and defaults the rest to 0", () => {
    expect(toNum(3.5)).toBe(3.5);
    expect(toNum("12.25")).toBe(12.25);
    expect(toNum("")).toBe(0);
    expect(toNum(null)).toBe(0);
    expect(toNum("abc")).toBe(0);
    expect(toNum(Infinity)).toBe(0);
  });
  it("numOrUndefined keeps blanks blank", () => {
    expect(numOrUndefined(null)).toBeUndefined();
    expect(numOrUndefined("")).toBeUndefined();
    expect(numOrUndefined("7")).toBe(7);
    expect(numOrUndefined(0)).toBe(0); // a real zero is not blank
    expect(numOrUndefined("x")).toBeUndefined();
  });
  it("textOrBlank stringifies non-empty and blanks null/empty", () => {
    expect(textOrBlank("hi")).toBe("hi");
    expect(textOrBlank(42)).toBe("42");
    expect(textOrBlank(null)).toBe("");
    expect(textOrBlank("")).toBe("");
  });
});

// ─── sumComputedCol ────────────────────────────────────────────────────────

describe("sumComputedCol", () => {
  it("sums numeric cells and ignores blanks/text", () => {
    const rows: unknown[][] = [
      [null, null, 10],
      [null, null, "5"],
      [null, null, ""],
      [null, null, "text"],
      [null, null, 2.5],
    ];
    expect(sumComputedCol(rows, 2)).toBeCloseTo(17.5, 10);
  });
  it("returns null (not 0) when the column has no numeric data — the 'do not overwrite' signal", () => {
    expect(sumComputedCol([[null, null, ""]], 2)).toBeNull();
    expect(sumComputedCol([], 2)).toBeNull();
  });
});

// ─── qtyTotalFormula uses PRODUCT so unused dimensions don't zero the row ───

describe("qtyTotalFormula", () => {
  it("emits PRODUCT(C..G) for the 0-based row", () => {
    expect(qtyTotalFormula(4)).toBe("=PRODUCT(C5,D5,E5,F5,G5)");
  });
  it("evaluated: Count×Length with blank Width/Height is not zeroed", () => {
    const sheet = emptySheet(1);
    sheet[0][COL_COUNT] = "3";
    sheet[0][COL_LENGTH] = "2.5";
    // Width/Height/Factor left blank
    sheet[0][COL_TOTAL] = qtyTotalFormula(0);
    const evaluated = evaluate(sheet);
    expect(evaluated[0][COL_TOTAL]).toBeCloseTo(7.5, 10);
  });
  it("evaluated: all four dimensions multiply", () => {
    const sheet = emptySheet(1);
    sheet[0][COL_COUNT] = "2";
    sheet[0][COL_LENGTH] = "3";
    sheet[0][COL_WIDTH] = "4";
    sheet[0][COL_HEIGHT] = "0.5";
    sheet[0][COL_TOTAL] = qtyTotalFormula(0);
    expect(evaluate(sheet)[0][COL_TOTAL]).toBeCloseTo(12, 10);
  });
});

// ─── deriveFactorTotal (the export/L1 default) ─────────────────────────────

describe("deriveFactorTotal", () => {
  it("defaults Factor to 1 the first time Subtotal is positive", () => {
    expect(deriveFactorTotal(100, undefined, undefined)).toEqual({ factor: 1, total: 100 });
  });
  it("respects an explicit factor", () => {
    const { factor, total } = deriveFactorTotal(100, 1.15, undefined);
    expect(factor).toBe(1.15);
    expect(total).toBeCloseTo(115, 10);
  });
  it("leaves everything alone when Subtotal is blank", () => {
    expect(deriveFactorTotal(undefined, undefined, undefined)).toEqual({ factor: undefined, total: undefined });
  });
  it("does not default Factor for a zero subtotal, and totals to 0", () => {
    expect(deriveFactorTotal(0, undefined, undefined)).toEqual({ factor: undefined, total: 0 });
  });
});

// ─── Rate Build-up → L2 rollup ─────────────────────────────────────────────

describe("rollupRateIntoL2", () => {
  it("rolls H:Total into E:Rate and pulls Lab/Mat through with =X*C totals", () => {
    // A rate build-up: two components, each with F=E*C and H=F*G, plus Lab/Mat inputs.
    const rate = emptySheet(2);
    for (const r of [0, 1]) {
      rate[r][COL_QTY] = "1";
      rate[r][COL_RATE] = r === 0 ? "40" : "10";
      rate[r][COL_SUBTOTAL] = `=${legacyColLetter(COL_RATE)}${r + 1}*${legacyColLetter(COL_QTY)}${r + 1}`;
      rate[r][COL_FACTOR] = "1";
      rate[r][COL_TOTAL] = `=${legacyColLetter(COL_SUBTOTAL)}${r + 1}*${legacyColLetter(COL_FACTOR)}${r + 1}`;
    }
    rate[0][COL_LAB] = "25";
    rate[1][COL_LAB] = "5";
    rate[0][COL_MAT] = "15";
    rate[1][COL_MAT] = "5";
    const computed = evaluate(rate);

    const parent = emptySheet(3);
    parent[2][COL_QTY] = "6"; // the takeoff quantity on the parent row
    rollupRateIntoL2(parent, 2, computed, noneExcluded);

    expect(toNum(parent[2][COL_RATE])).toBeCloseTo(50, 10);   // 40 + 10
    expect(toNum(parent[2][COL_LAB])).toBeCloseTo(30, 10);    // 25 + 5
    expect(toNum(parent[2][COL_MAT])).toBeCloseTo(20, 10);    // 15 + 5
    expect(parent[2][COL_LAB_TOTAL]).toBe("=I3*C3");          // =Lab*Qty for row 3
    expect(parent[2][COL_MAT_TOTAL]).toBe("=K3*C3");
  });

  it("leaves a hand-typed parent rate alone when the build-up sheet is empty", () => {
    const parent = emptySheet(1);
    parent[0][COL_RATE] = "99";
    rollupRateIntoL2(parent, 0, evaluate(emptySheet(2)), noneExcluded);
    expect(parent[0][COL_RATE]).toBe("99");
  });

  it("honours the exclusion predicate — an excluded E:Rate is not overwritten", () => {
    const rate = emptySheet(1);
    rate[0][COL_TOTAL] = "77";
    const parent = emptySheet(1);
    parent[0][COL_RATE] = "1";
    rollupRateIntoL2(parent, 0, evaluate(rate), (c) => c === COL_RATE);
    expect(parent[0][COL_RATE]).toBe("1");
  });
});

// ─── Quantity Build-up → L2 rollup ─────────────────────────────────────────

describe("rollupQtyIntoL2", () => {
  it("rolls summed H:Quantity into C:Quantity", () => {
    const qty = emptySheet(2);
    qty[0][COL_COUNT] = "2"; qty[0][COL_LENGTH] = "3"; qty[0][COL_TOTAL] = qtyTotalFormula(0);
    qty[1][COL_COUNT] = "1"; qty[1][COL_LENGTH] = "4"; qty[1][COL_TOTAL] = qtyTotalFormula(1);
    const parent = emptySheet(1);
    rollupQtyIntoL2(parent, 0, evaluate(qty), noneExcluded);
    expect(toNum(parent[0][COL_QTY])).toBeCloseTo(10, 10); // (2*3) + (1*4)
  });
  it("does not wipe a hand-typed quantity when the build-up is empty", () => {
    const parent = emptySheet(1);
    parent[0][COL_QTY] = "5";
    rollupQtyIntoL2(parent, 0, evaluate(emptySheet(2)), noneExcluded);
    expect(parent[0][COL_QTY]).toBe("5");
  });
});

// ─── L2 → L1 rollup ────────────────────────────────────────────────────────

describe("rollupL2IntoL1", () => {
  it("sums the L2 sheet's H:Total into the L1 F:Subtotal", () => {
    const l2 = emptySheet(3);
    l2[0][COL_TOTAL] = "100";
    l2[1][COL_TOTAL] = "250";
    l2[2][COL_TOTAL] = "";
    const l1 = emptySheet(1);
    rollupL2IntoL1(l1, 0, evaluate(l2), noneExcluded);
    expect(toNum(l1[0][COL_SUBTOTAL])).toBeCloseTo(350, 10);
  });
});

// ─── End-to-end: a full three-level fixture workbook ───────────────────────
//
// L1 row 0  (Concrete)   F:Subtotal ← Σ L2.H
//   └ L2 row 0  Slab      C:Qty ← Qty build-up;  E:Rate ← Rate build-up;  H = F×G
//       ├ Qty build-up:   Count×Length×Width  = the slab area/volume
//       └ Rate build-up:  labour + materials   = the composite $/unit
//     L2 row 1  Beams     hand-typed qty + rate (no build-ups)
//
// This is the whole drill-up chain the app performs, run through the real engine.

describe("golden fixture: three-level rollup end to end", () => {
  it("rolls quantity + rate build-ups up to the L1 subtotal", () => {
    // --- Level 3a: Quantity Build-up for the slab (25 m³) ---
    const slabQty = emptySheet(1);
    slabQty[0][COL_COUNT] = "1";
    slabQty[0][COL_LENGTH] = "10";
    slabQty[0][COL_WIDTH] = "5";
    slabQty[0][COL_HEIGHT] = "0.5";
    slabQty[0][COL_TOTAL] = qtyTotalFormula(0); // 25

    // --- Level 3b: Rate Build-up for the slab ($/unit = 180 + 20) ---
    const slabRate = emptySheet(2);
    // concrete supply
    slabRate[0][COL_QTY] = "1"; slabRate[0][COL_RATE] = "180";
    slabRate[0][COL_SUBTOTAL] = "=E1*C1"; slabRate[0][COL_FACTOR] = "1"; slabRate[0][COL_TOTAL] = "=F1*G1";
    slabRate[0][COL_LAB] = "0";   slabRate[0][COL_MAT] = "180";
    // place & finish
    slabRate[1][COL_QTY] = "1"; slabRate[1][COL_RATE] = "20";
    slabRate[1][COL_SUBTOTAL] = "=E2*C2"; slabRate[1][COL_FACTOR] = "1"; slabRate[1][COL_TOTAL] = "=F2*G2";
    slabRate[1][COL_LAB] = "20";  slabRate[1][COL_MAT] = "0";

    // --- Level 2: the trade takeoff ---
    const takeoff = emptySheet(2);
    // Slab row: quantity + rate come from the two build-ups
    rollupQtyIntoL2(takeoff, 0, evaluate(slabQty), noneExcluded);
    rollupRateIntoL2(takeoff, 0, evaluate(slabRate), noneExcluded);
    // F = E×C, G defaults to 1, H = F×G (the grid's deriveLevelFormulas, expressed as formulas)
    takeoff[0][COL_SUBTOTAL] = "=E1*C1";
    takeoff[0][COL_FACTOR] = "1";
    takeoff[0][COL_TOTAL] = "=F1*G1";
    // Beams row: hand-typed, no build-ups
    takeoff[1][COL_QTY] = "8"; takeoff[1][COL_RATE] = "125";
    takeoff[1][COL_SUBTOTAL] = "=E2*C2"; takeoff[1][COL_FACTOR] = "1"; takeoff[1][COL_TOTAL] = "=F2*G2";

    const takeoffComputed = evaluate(takeoff);
    // slab: 25 m³ × $200 = 5000 ; beams: 8 × $125 = 1000
    expect(takeoffComputed[0][COL_QTY]).toBeCloseTo(25, 10);
    expect(takeoffComputed[0][COL_RATE]).toBeCloseTo(200, 10);
    expect(takeoffComputed[0][COL_TOTAL]).toBeCloseTo(5000, 10);
    expect(takeoffComputed[1][COL_TOTAL]).toBeCloseTo(1000, 10);

    // --- Level 1: the trade summary ---
    const summary = emptySheet(1);
    rollupL2IntoL1(summary, 0, takeoffComputed, noneExcluded);
    expect(toNum(summary[0][COL_SUBTOTAL])).toBeCloseTo(6000, 10); // 5000 + 1000

    // L1 Factor/Total default the same way the export does
    const { factor, total } = deriveFactorTotal(toNum(summary[0][COL_SUBTOTAL]), undefined, undefined);
    expect(factor).toBe(1);
    expect(total).toBeCloseTo(6000, 10);
  });

  it("a margin factor on the L1 row flows into the grand total", () => {
    const summary = emptySheet(1);
    summary[0][COL_SUBTOTAL] = "6000";
    summary[0][COL_FACTOR] = "1.15";
    summary[0][COL_TOTAL] = "=F1*G1";
    expect(evaluate(summary)[0][COL_TOTAL]).toBeCloseTo(6900, 10);
  });
});
