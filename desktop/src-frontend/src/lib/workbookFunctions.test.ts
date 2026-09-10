// Tests for the CostX XSUM* family — each sums the child-sheet column given as its RANGE argument
// (=XSUMRATE(child!H1:H50[, dp])). Run against the real engine via WorkbookEngine (which registers
// the plugin in its constructor). The explicit range gives the dependency edge that makes reads of
// formula-computed child cells correct and multi-level chains converge in one pass.

import { describe, it, expect } from "vitest";
import { WorkbookEngine } from "./workbookEngine";
import {
  COL_QTY, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL, COL_COUNT, COL_LENGTH,
} from "./workbookCalc";
import { FIRST_USER_COL } from "./workbookLayout";

const NUM_COLS = 16;
function row(): (string | null)[] { return Array<string | null>(NUM_COLS).fill(null); }
function sheet(n: number): (string | null)[][] { return Array.from({ length: n }, row); }

describe("XSUM* sum a child range, with rounding", () => {
  it("XSUMTOT sums a child H range, rounded", () => {
    const eng = new WorkbookEngine();
    const child = sheet(3);
    child[0][COL_TOTAL] = "100.126"; child[1][COL_TOTAL] = "250"; child[2][COL_TOTAL] = "";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);
    const parent = sheet(1);
    parent[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0!H1:H50,2)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBeCloseTo(350.13, 10);
    eng.destroy();
  });

  it("no dp arg ⇒ unrounded", () => {
    const eng = new WorkbookEngine();
    const child = sheet(2); child[0][COL_TOTAL] = "100.126"; child[1][COL_TOTAL] = "0.007";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);
    const parent = sheet(1); parent[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0!H1:H50)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBeCloseTo(100.133, 10);
    eng.destroy();
  });

  it("reads formula-computed child cells correctly (the dependency-edge case)", () => {
    // Rate build-up whose Total column is a formula chain H=F*G, F=E*C — the case a positional
    // (edge-less) function reads blank. With an explicit range it resolves in one pass.
    const eng = new WorkbookEngine();
    const rate = sheet(2);
    for (const r of [0, 1]) {
      rate[r][COL_RATE] = r === 0 ? "40" : "10"; rate[r][COL_QTY] = "1";
      rate[r][COL_SUBTOTAL] = `=E${r + 1}*C${r + 1}`; rate[r][COL_FACTOR] = "1"; rate[r][COL_TOTAL] = `=F${r + 1}*G${r + 1}`;
    }
    rate[0][FIRST_USER_COL] = "1.5"; rate[1][FIRST_USER_COL] = "0.5"; // labour hrs 2.0
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: rate }]);
    const parent = sheet(1);
    parent[0][COL_QTY] = "6";
    parent[0][COL_RATE] = "=XSUMRATE(L1_sR0!H1:H50,2)";
    parent[0][FIRST_USER_COL] = "=XSUMRATEUSER(L1_sR0!I1:I50)*C1";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_RATE)).toBeCloseTo(50, 10);       // 40 + 10
    expect(eng.getCellValue("L1", 0, FIRST_USER_COL)).toBeCloseTo(12, 10); // 2.0 hrs × 6
    eng.destroy();
  });

  it("XSUMQTY sums a /Q child's H (Quantity), incl. PRODUCT formulas", () => {
    const eng = new WorkbookEngine();
    const qty = sheet(2);
    qty[0][COL_COUNT] = "2"; qty[0][COL_LENGTH] = "3"; qty[0][COL_TOTAL] = "=PRODUCT(C1,D1,E1,F1,G1)";
    qty[1][COL_COUNT] = "1"; qty[1][COL_LENGTH] = "4"; qty[1][COL_TOTAL] = "=PRODUCT(C2,D2,E2,F2,G2)";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/Q0", data: qty }]);
    const parent = sheet(1); parent[0][COL_QTY] = "=XSUMQTY(L1_sQ0!H1:H50,3)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_QTY)).toBeCloseTo(10, 10);
    eng.destroy();
  });
});

describe("liveness, edges, multi-level convergence", () => {
  it("recomputes when the child changes", () => {
    const eng = new WorkbookEngine();
    const child = sheet(1); child[0][COL_TOTAL] = "100";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);
    const parent = sheet(1); parent[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0!H1:H50)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(100);
    child[0][COL_TOTAL] = "175"; eng.setSheet("L1/R0", child);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(175);
    eng.destroy();
  });

  it("empty range ⇒ 0 (un-built-up cell)", () => {
    const eng = new WorkbookEngine();
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: sheet(1) }]);
    const parent = sheet(1); parent[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0!H1:H50)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(0);
    eng.destroy();
  });

  it("a three-level chain converges in one pass (explicit-range edges)", () => {
    const eng = new WorkbookEngine();
    const grandchild = sheet(1); grandchild[0][COL_TOTAL] = "500";
    eng.loadAll([
      { path: "L1", data: sheet(1) },
      { path: "L1/R0", data: sheet(1) },
      { path: "L1/R0/R0", data: grandchild },
    ]);
    const mid = sheet(1);
    mid[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0_sR0!H1:H50)"; mid[0][COL_FACTOR] = "1"; mid[0][COL_TOTAL] = "=F1*G1";
    eng.setSheet("L1/R0", mid);
    const top = sheet(1);
    top[0][COL_SUBTOTAL] = "=XSUMTOT(L1_sR0!H1:H50)"; top[0][COL_FACTOR] = "1"; top[0][COL_TOTAL] = "=F1*G1";
    eng.setSheet("L1", top);
    expect(eng.getCellValue("L1/R0", 0, COL_TOTAL)).toBe(500);
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBe(500);
    eng.destroy();
  });
});
