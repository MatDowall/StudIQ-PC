// Tests for the CostX XSUM* family (M3), against the real engine via WorkbookEngine (which
// registers the plugin in its constructor). Proves each function reads the right child sheet and
// column, rounds correctly, recomputes live on a child edit, and handles missing children.

import { describe, it, expect } from "vitest";
import { WorkbookEngine } from "./workbookEngine";
import {
  COL_QTY, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL,
  COL_COUNT, COL_LENGTH,
} from "./workbookCalc";
import { FIRST_USER_COL } from "./workbookLayout";

const NUM_COLS = 16;
function row(): (string | null)[] { return Array<string | null>(NUM_COLS).fill(null); }
function sheet(n: number): (string | null)[][] { return Array.from({ length: n }, row); }

describe("XSUMTOT / XSUMTOTQTY / XSUMUSER — cost sub-sheet (/R)", () => {
  it("XSUMTOT sums the child's H (Total) column, rounded", () => {
    const eng = new WorkbookEngine();
    const child = sheet(3);
    child[0][COL_TOTAL] = "100.126";
    child[1][COL_TOTAL] = "250";
    child[2][COL_TOTAL] = ""; // blank ignored
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);

    const parent = sheet(1);
    parent[0][COL_SUBTOTAL] = "=XSUMTOT(2)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBeCloseTo(350.13, 10);
  });

  it("XSUMTOTQTY sums the child's C (Quantity) column", () => {
    const eng = new WorkbookEngine();
    const child = sheet(2);
    child[0][COL_QTY] = "4"; child[1][COL_QTY] = "6";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R2", data: child }]);
    const parent = sheet(3);
    parent[2][COL_SUBTOTAL] = "=XSUMTOTQTY(0)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 2, COL_SUBTOTAL)).toBe(10);
  });

  it("XSUMUSER(n, dp) sums the child's nth user column (1 = column I)", () => {
    const eng = new WorkbookEngine();
    const child = sheet(2);
    child[0][FIRST_USER_COL] = "12.5"; child[1][FIRST_USER_COL] = "7.5";      // user col 1 (I)
    child[0][FIRST_USER_COL + 2] = "3"; child[1][FIRST_USER_COL + 2] = "4";   // user col 3 (K)
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);
    const parent = sheet(1);
    parent[0][FIRST_USER_COL] = "=XSUMUSER(1,1)";
    parent[0][FIRST_USER_COL + 2] = "=XSUMUSER(3)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, FIRST_USER_COL)).toBeCloseTo(20, 10);
    expect(eng.getCellValue("L1", 0, FIRST_USER_COL + 2)).toBe(7);
    eng.destroy();
  });
});

describe("XSUMRATE / XSUMRATEUSER — rate build-up (/R)", () => {
  it("XSUMRATE sums the rate child's H, and XSUMRATEUSER(1,2)*C1 is the LPMS idiom", () => {
    const eng = new WorkbookEngine();
    // Rate build-up: two components with H = F×G and a user col 1 (labour hours).
    const rate = sheet(2);
    for (const r of [0, 1]) {
      rate[r][COL_RATE] = r === 0 ? "40" : "10";
      rate[r][COL_QTY] = "1";
      rate[r][COL_SUBTOTAL] = `=E${r + 1}*C${r + 1}`;
      rate[r][COL_FACTOR] = "1";
      rate[r][COL_TOTAL] = `=F${r + 1}*G${r + 1}`;
    }
    rate[0][FIRST_USER_COL] = "1.5"; rate[1][FIRST_USER_COL] = "0.5"; // 2.0 labour hours total
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: rate }]);

    const parent = sheet(1);
    parent[0][COL_QTY] = "6";                       // takeoff quantity
    parent[0][COL_RATE] = "=XSUMRATE(2)";           // composite rate → 50
    parent[0][FIRST_USER_COL] = "=XSUMRATEUSER(1,2)*C1"; // labour hours × qty → 2.0 × 6 = 12
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_RATE)).toBeCloseTo(50, 10);
    expect(eng.getCellValue("L1", 0, FIRST_USER_COL)).toBeCloseTo(12, 10);
    eng.destroy();
  });
});

describe("XSUMQTY / XSUMQTYUSER — quantity build-up (/Q)", () => {
  it("XSUMQTY sums the qty child's H (Quantity) column from a /Q child", () => {
    const eng = new WorkbookEngine();
    const qty = sheet(2);
    qty[0][COL_COUNT] = "2"; qty[0][COL_LENGTH] = "3"; qty[0][COL_TOTAL] = "=PRODUCT(C1,D1,E1,F1,G1)";
    qty[1][COL_COUNT] = "1"; qty[1][COL_LENGTH] = "4"; qty[1][COL_TOTAL] = "=PRODUCT(C2,D2,E2,F2,G2)";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/Q0", data: qty }]);
    const parent = sheet(1);
    parent[0][COL_QTY] = "=XSUMQTY(3)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_QTY)).toBeCloseTo(10, 10); // (2*3)+(1*4)
    eng.destroy();
  });
});

describe("liveness and edge cases", () => {
  it("recomputes when the child changes (volatile, no explicit dependency)", () => {
    const eng = new WorkbookEngine();
    const child = sheet(1); child[0][COL_TOTAL] = "100";
    eng.loadAll([{ path: "L1", data: sheet(1) }, { path: "L1/R0", data: child }]);
    const parent = sheet(1); parent[0][COL_SUBTOTAL] = "=XSUMTOT(2)";
    eng.setSheet("L1", parent);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(100);
    child[0][COL_TOTAL] = "175";
    eng.setSheet("L1/R0", child);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(175);
    eng.destroy();
  });

  it("returns 0 when the child sheet doesn't exist (un-built-up cell)", () => {
    const eng = new WorkbookEngine();
    const parent = sheet(1); parent[0][COL_SUBTOTAL] = "=XSUMTOT(2)";
    eng.loadAll([{ path: "L1", data: parent }]);
    expect(eng.getCellValue("L1", 0, COL_SUBTOTAL)).toBe(0);
    eng.destroy();
  });

  it("XSUMTOT works on a deeply nested cost sheet (recursion-ready)", () => {
    const eng = new WorkbookEngine();
    const grandchild = sheet(1); grandchild[0][COL_TOTAL] = "500";
    eng.loadAll([
      { path: "L1", data: sheet(1) },
      { path: "L1/R0", data: sheet(1) },
      { path: "L1/R0/R0", data: grandchild },
    ]);
    // Each cost row is F=XSUMTOT(child), G=1, H=F*G — so H (Total) carries the rolled-up value
    // that the PARENT's XSUMTOT then reads. L1/R0 rolls up L1/R0/R0; L1 rolls up L1/R0.
    const mid = sheet(1);
    mid[0][COL_SUBTOTAL] = "=XSUMTOT(2)"; mid[0][COL_FACTOR] = "1"; mid[0][COL_TOTAL] = "=F1*G1";
    eng.setSheet("L1/R0", mid);
    const top = sheet(1);
    top[0][COL_SUBTOTAL] = "=XSUMTOT(2)"; top[0][COL_FACTOR] = "1"; top[0][COL_TOTAL] = "=F1*G1";
    eng.setSheet("L1", top);
    expect(eng.getCellValue("L1/R0", 0, COL_TOTAL)).toBe(500);
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBe(500);
    eng.destroy();
  });
});
