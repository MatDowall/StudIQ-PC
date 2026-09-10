// Tests for the multi-sheet WorkbookEngine (M1).
//
// The headline test ("declarative rollup") is the keystone of the whole re-architecture: it
// proves — headlessly, against the real HyperFormula engine — that live cross-sheet formulas
// reproduce the SAME totals the current baked-literal rollups produce in workbook.test.ts's
// golden fixture (£6,000). That is the equivalence the M4 upgrade must preserve.

import { describe, it, expect } from "vitest";
import { WorkbookEngine } from "./workbookEngine";
import {
  COL_QTY, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL,
  COL_COUNT, COL_LENGTH, COL_WIDTH, COL_HEIGHT,
} from "./workbookCalc";

const NUM_COLS = 16;
function emptyRow(): (string | null)[] { return Array<string | null>(NUM_COLS).fill(null); }
function sheet(rows: number): (string | null)[][] { return Array.from({ length: rows }, emptyRow); }

describe("WorkbookEngine — sheet lifecycle", () => {
  it("adds, reports, and round-trips sheet content", () => {
    const eng = new WorkbookEngine();
    eng.addSheet("L1", sheet(1));
    expect(eng.has("L1")).toBe(true);
    expect(eng.paths()).toContain("L1");

    const s = sheet(1);
    s[0][COL_TOTAL] = "=2+3";
    eng.setSheet("L1", s);
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBe(5);
    eng.destroy();
  });

  it("loadAll seeds every sheet at once", () => {
    const eng = new WorkbookEngine();
    eng.loadAll([
      { path: "L1", data: sheet(1) },
      { path: "L1/R3", data: sheet(1) },
      { path: "L1/R3/Q5", data: sheet(1) },
    ]);
    expect(eng.paths()).toEqual(["L1", "L1/R3", "L1/R3/Q5"]);
    eng.destroy();
  });

  it("removeSheet drops the sheet", () => {
    const eng = new WorkbookEngine();
    eng.addSheet("L1/R3", sheet(1));
    eng.removeSheet("L1/R3");
    expect(eng.has("L1/R3")).toBe(false);
    eng.removeSheet("L1/R3"); // no-op, must not throw
    eng.destroy();
  });

  it("getEvaluatedSheet / getCellValue return empty/null for unknown sheets", () => {
    const eng = new WorkbookEngine();
    expect(eng.getEvaluatedSheet("nope")).toEqual([]);
    expect(eng.getCellValue("nope", 0, 0)).toBeNull();
    eng.destroy();
  });
});

describe("WorkbookEngine — cross-sheet references", () => {
  it("cellRef / rangeRef produce absolute qualified references", () => {
    const eng = new WorkbookEngine();
    eng.addSheet("L1/R3");
    expect(eng.cellRef("L1/R3", 6, COL_TOTAL)).toBe("L1_sR3!$H$7");
    expect(eng.rangeRef("L1/R3", COL_TOTAL, 0, 199)).toBe("L1_sR3!$H$1:$H$200");
    eng.destroy();
  });

  it("a parent formula reads a child sheet's live values", () => {
    const eng = new WorkbookEngine();
    const child = sheet(2);
    child[0][COL_TOTAL] = "100";
    child[1][COL_TOTAL] = "250";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R3", data: child }]);

    const parent = sheet(1);
    parent[0][COL_SUBTOTAL] = `=SUM(${eng.rangeRef("L1/R3", COL_TOTAL, 0, 99)})`;
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(350);

    // Editing the child re-drives the parent with no manual recalculate.
    child[1][COL_TOTAL] = "300";
    eng.setSheet("L1/R3", child);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(400);
    eng.destroy();
  });
});

describe("WorkbookEngine — named cells are live references, not snapshots", () => {
  it("a named cell tracks its bound cell across edits", () => {
    const eng = new WorkbookEngine();
    const s = sheet(1);
    s[0][COL_FACTOR] = "1.1";
    eng.loadAll([{ path: "L1", data: s }]);
    eng.setNamedCellRef("margin", "L1", 0, COL_FACTOR);
    expect(eng.namedValue("margin")).toBeCloseTo(1.1, 10);

    s[0][COL_FACTOR] = "1.25";
    eng.setSheet("L1", s);
    expect(eng.namedValue("margin")).toBeCloseTo(1.25, 10); // no re-registration needed
    eng.destroy();
  });

  it("a formula on another sheet resolves the name", () => {
    const eng = new WorkbookEngine();
    const l1 = sheet(1); l1[0][COL_FACTOR] = "1.15";
    eng.loadAll([{ path: "L1", data: l1 }, { path: "L1/R3", data: sheet(1) }]);
    eng.setNamedCellRef("margin", "L1", 0, COL_FACTOR);

    const child = sheet(1);
    child[0][COL_TOTAL] = "=1000*margin";
    eng.setSheet("L1/R3", child);
    expect(eng.getCellValue("L1/R3", 0, COL_TOTAL)).toBeCloseTo(1150, 10);
    eng.destroy();
  });
});

// ─── Keystone: declarative rollup reproduces the golden fixture (£6,000) ────
//
// Same three-level workbook as workbook.test.ts's "golden fixture", but instead of baking
// rolled-up literals into parent cells, the parents hold LIVE cross-sheet formulas. The L1
// grand total must come out identical — that equivalence is exactly what the M4 upgrade gate
// verifies on real workbooks.

describe("WorkbookEngine — declarative three-level rollup matches the baked golden fixture", () => {
  it("rolls quantity + rate build-ups up to £6,000 via cross-sheet formulas", () => {
    const eng = new WorkbookEngine();

    // L3a: Quantity Build-up for the slab (1×10×5×0.5 = 25 m³)
    const slabQty = sheet(1);
    slabQty[0][COL_COUNT] = "1"; slabQty[0][COL_LENGTH] = "10";
    slabQty[0][COL_WIDTH] = "5"; slabQty[0][COL_HEIGHT] = "0.5";
    slabQty[0][COL_TOTAL] = "=PRODUCT(C1,D1,E1,F1,G1)";

    // L3b: Rate Build-up for the slab ($200/unit = 180 supply + 20 place)
    const slabRate = sheet(2);
    slabRate[0][COL_QTY] = "1"; slabRate[0][COL_RATE] = "180";
    slabRate[0][COL_SUBTOTAL] = "=E1*C1"; slabRate[0][COL_FACTOR] = "1"; slabRate[0][COL_TOTAL] = "=F1*G1";
    slabRate[1][COL_QTY] = "1"; slabRate[1][COL_RATE] = "20";
    slabRate[1][COL_SUBTOTAL] = "=E2*C2"; slabRate[1][COL_FACTOR] = "1"; slabRate[1][COL_TOTAL] = "=F2*G2";

    // L2: the trade takeoff. Slab row's C/E come from the build-ups via cross-sheet formulas;
    // Beams row is hand-typed.
    const takeoff = sheet(2);
    takeoff[1][COL_QTY] = "8"; takeoff[1][COL_RATE] = "125";

    // L1: the trade summary. F = SUM of the takeoff's H column.
    const summary = sheet(1);

    eng.loadAll([
      { path: "L1", data: summary },
      { path: "L1/R0", data: takeoff },
      { path: "L1/R0/Q0", data: slabQty },
      { path: "L1/R0/R0", data: slabRate },
    ]);

    // Wire the declarative rollups (what M4's drillDown will write into parent cells):
    const takeoff2 = sheet(2);
    takeoff2[0][COL_QTY] = `=SUM(${eng.rangeRef("L1/R0/Q0", COL_TOTAL, 0, 99)})`;      // ← Qty build-up
    takeoff2[0][COL_RATE] = `=SUM(${eng.rangeRef("L1/R0/R0", COL_TOTAL, 0, 99)})`;      // ← Rate build-up
    takeoff2[0][COL_SUBTOTAL] = "=E1*C1"; takeoff2[0][COL_FACTOR] = "1"; takeoff2[0][COL_TOTAL] = "=F1*G1";
    takeoff2[1][COL_QTY] = "8"; takeoff2[1][COL_RATE] = "125";
    takeoff2[1][COL_SUBTOTAL] = "=E2*C2"; takeoff2[1][COL_FACTOR] = "1"; takeoff2[1][COL_TOTAL] = "=F2*G2";
    eng.setSheet("L1/R0", takeoff2);

    const summary2 = sheet(1);
    summary2[0][COL_SUBTOTAL] = `=SUM(${eng.rangeRef("L1/R0", COL_TOTAL, 0, 99)})`;      // ← L2 rollup
    summary2[0][COL_FACTOR] = "1"; summary2[0][COL_TOTAL] = "=F1*G1";
    eng.setSheet("L1", summary2);

    // Slab: 25 m³ × $200 = 5000 ; Beams: 8 × $125 = 1000
    expect(eng.getCellValue("L1/R0", 0, COL_QTY)).toBeCloseTo(25, 10);
    expect(eng.getCellValue("L1/R0", 0, COL_RATE)).toBeCloseTo(200, 10);
    expect(eng.getCellValue("L1/R0", 0, COL_TOTAL)).toBeCloseTo(5000, 10);
    expect(eng.getCellValue("L1/R0", 1, COL_TOTAL)).toBeCloseTo(1000, 10);

    // The L1 grand total — identical to workbook.test.ts's baked fixture.
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBeCloseTo(6000, 10);
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBeCloseTo(6000, 10);

    // And it is genuinely live: bump the slab thickness and the grand total follows with no
    // rollup pass — the entire point of going declarative.
    slabQty[0][COL_HEIGHT] = "1.0"; // 25 → 50 m³
    eng.setSheet("L1/R0/Q0", slabQty);
    expect(eng.getCellValue("L1/R0", 0, COL_TOTAL)).toBeCloseTo(10000, 10); // 50 × 200
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBeCloseTo(11000, 10);    // 10000 + 1000
    eng.destroy();
  });
});
