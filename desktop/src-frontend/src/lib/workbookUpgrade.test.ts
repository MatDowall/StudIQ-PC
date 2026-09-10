// Tests for the v1→v2 upgrade (M4). Builds a realistic BAKED (v1) three-level workbook — the exact
// shape drillUp produces — upgrades it, and proves: the right cells became XSUM* formulas, the
// declarative result is cell-for-cell equivalent to the baked one, excluded/linked cells are left
// alone, and the equivalence gate ABORTS on a deliberately corrupted transform.

import { describe, it, expect } from "vitest";
import {
  transformSheetsToV2, verifyEquivalence, upgradeWorkbook,
} from "./workbookUpgrade";
import { WorkbookEngine, type SheetPayload } from "./workbookEngine";
import {
  COL_QTY, COL_RATE, COL_SUBTOTAL, COL_FACTOR, COL_TOTAL,
  COL_COUNT, COL_LENGTH, COL_LAB, COL_LAB_TOTAL,
} from "./workbookCalc";

const NUM_COLS = 16;
function row(): (string | null)[] { return Array<string | null>(NUM_COLS).fill(null); }
function sheet(n: number): (string | null)[][] { return Array.from({ length: n }, row); }

// ── A realistic v1 (baked) fixture ─────────────────────────────────────────
// L1 (summary): one row; F:Subtotal + J (Lab-Total) are BAKED literals rolled up from L2.
// L1/R0 (takeoff): 2 rows.
//   row0 Slab: C:Quantity BAKED from qty child; E:Rate + I (Lab) BAKED from rate child;
//              F=E*C, H=F*G, J=I*C are formulas.
//   row1 Beams: hand-typed C/E, no children.
// L1/R0/Q0 (qty build-up): 25 m³.  L1/R0/R0 (rate build-up): $200/unit, 2.0 labour hrs.
function bakedV1Fixture(): SheetPayload[] {
  const slabQty = sheet(1);
  slabQty[0][COL_COUNT] = "1"; slabQty[0][COL_LENGTH] = "10";
  slabQty[0][4] = "5"; slabQty[0][5] = "0.5"; // Width, Height (qty layout E,F)
  slabQty[0][COL_TOTAL] = "=PRODUCT(C1,D1,E1,F1,G1)"; // 25

  const slabRate = sheet(2);
  slabRate[0][COL_RATE] = "180"; slabRate[0][COL_QTY] = "1";
  slabRate[0][COL_SUBTOTAL] = "=E1*C1"; slabRate[0][COL_FACTOR] = "1"; slabRate[0][COL_TOTAL] = "=F1*G1";
  slabRate[0][COL_LAB] = "1.5";
  slabRate[1][COL_RATE] = "20"; slabRate[1][COL_QTY] = "1";
  slabRate[1][COL_SUBTOTAL] = "=E2*C2"; slabRate[1][COL_FACTOR] = "1"; slabRate[1][COL_TOTAL] = "=F2*G2";
  slabRate[1][COL_LAB] = "0.5";

  const takeoff = sheet(2);
  // Slab: baked C=25, E=200, I=2.0 (from children); formula F/H/J.
  takeoff[0][COL_QTY] = "25"; takeoff[0][COL_RATE] = "200"; takeoff[0][COL_LAB] = "2";
  takeoff[0][COL_SUBTOTAL] = "=E1*C1"; takeoff[0][COL_FACTOR] = "1"; takeoff[0][COL_TOTAL] = "=F1*G1";
  takeoff[0][COL_LAB_TOTAL] = "=I1*C1";
  // Beams: hand-typed, no children.
  takeoff[1][COL_QTY] = "8"; takeoff[1][COL_RATE] = "125";
  takeoff[1][COL_SUBTOTAL] = "=E2*C2"; takeoff[1][COL_FACTOR] = "1"; takeoff[1][COL_TOTAL] = "=F2*G2";

  const summary = sheet(1);
  // L1: F + J baked from L2; G/H formulas.
  summary[0][COL_SUBTOTAL] = "6000"; summary[0][COL_FACTOR] = "1"; summary[0][COL_TOTAL] = "=F1*G1";
  summary[0][COL_LAB_TOTAL] = "50"; // 2.0*25 = 50 labour-hours rolled up

  return [
    { path: "L1", data: summary },
    { path: "L1/R0", data: takeoff },
    { path: "L1/R0/Q0", data: slabQty },
    { path: "L1/R0/R0", data: slabRate },
  ];
}

describe("transformSheetsToV2", () => {
  it("rewrites exactly the baked rollup cells and leaves formulas / hand-typed cells alone", () => {
    const { transformed, changed } = transformSheetsToV2(bakedV1Fixture());
    const l1 = transformed.get("L1")!;
    const t = transformed.get("L1/R0")!;

    // L1 summary: F and J(Lab-Total) → explicit-range SUM of the L2 child's H and J columns.
    expect(l1[0][COL_SUBTOTAL]).toBe("=XSUMTOT(L1_sR0!H1:H1000)");
    expect(l1[0][COL_LAB_TOTAL]).toBe("=XSUMUSER(L1_sR0!J1:J1000)"); // J = user col 2
    expect(l1[0][COL_TOTAL]).toBe("=F1*G1");                     // H formula untouched

    // Takeoff slab row (has both children): C from the qty child, E + I from the rate child.
    expect(t[0][COL_QTY]).toBe("=XSUMQTY(L1_sR0_sQ0!H1:H1000)");
    expect(t[0][COL_RATE]).toBe("=XSUMRATE(L1_sR0_sR0!H1:H1000)");
    expect(t[0][COL_LAB]).toBe("=XSUMRATEUSER(L1_sR0_sR0!I1:I1000)"); // I = user col 1
    expect(t[0][COL_SUBTOTAL]).toBe("=E1*C1");               // F formula untouched
    expect(t[0][COL_LAB_TOTAL]).toBe("=I1*C1");              // J formula untouched

    // Beams row (no children): hand-typed C/E untouched
    expect(t[1][COL_QTY]).toBe("8");
    expect(t[1][COL_RATE]).toBe("125");

    // Leaves untouched
    expect(transformed.get("L1/R0/R0")![0][COL_RATE]).toBe("180");
    expect(changed).toBeGreaterThan(0);
  });

  it("skips excluded cells and dimension-linked cells", () => {
    const { transformed } = transformSheetsToV2(bakedV1Fixture(), {
      isExcluded: (p, r, c) => p === "L1" && r === 0 && c === COL_SUBTOTAL,
      hasLink: (p, r, c) => p === "L1/R0" && r === 0 && c === COL_QTY,
    });
    expect(transformed.get("L1")![0][COL_SUBTOTAL]).toBe("6000");   // excluded: literal kept
    expect(transformed.get("L1/R0")![0][COL_QTY]).toBe("25");        // linked: literal kept
    expect(transformed.get("L1/R0")![0][COL_RATE]).toBe("=XSUMRATE(L1_sR0_sR0!H1:H1000)"); // others still upgraded
  });
});

describe("equivalence gate", () => {
  it("the upgraded workbook evaluates identically to the baked one", () => {
    const v1 = bakedV1Fixture();
    const result = upgradeWorkbook(v1);
    expect(result.ok).toBe(true);
    expect(result.diffs).toEqual([]);

    // And the declarative version is genuinely live: the baked L1 total is 6000; after upgrade the
    // engine derives it from the children, and editing a child now flows through.
    const eng = new WorkbookEngine();
    eng.loadAll(v1.map((s) => ({ path: s.path, data: result.transformed.get(s.path)! })));
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBeCloseTo(6000, 6);   // 25*200 + 8*125
    expect(eng.getCellValue("L1", 0, COL_LAB_TOTAL)).toBeCloseTo(50, 6); // 2.0*25 labour hrs
    // bump slab thickness in the qty build-up (0.5 → 1.0 => 25 → 50 m³)
    const q = result.transformed.get("L1/R0/Q0")!;
    q[0][5] = "1.0";
    eng.setSheet("L1/R0/Q0", q);
    expect(eng.getCellValue("L1/R0", 0, COL_QTY)).toBeCloseTo(50, 6);
    expect(eng.getCellValue("L1", 0, COL_TOTAL)).toBeCloseTo(11000, 6);  // 50*200 + 8*125
    eng.destroy();
  });

  it("ABORTS when the transform is corrupted (the safety gate)", () => {
    const v1 = bakedV1Fixture();
    const { transformed } = transformSheetsToV2(v1);
    // Simulate a bad transform: point L1 F at the wrong child column (Quantity, not Total).
    transformed.get("L1")![0][COL_SUBTOTAL] = "=SUM(L1_sR0!C1:C1000)";
    const diffs = verifyEquivalence(v1, transformed);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.path === "L1")).toBe(true);
  });

  it("a workbook with no build-ups upgrades to a no-op that still verifies", () => {
    const flat: SheetPayload[] = [{ path: "L1", data: (() => {
      const s = sheet(1); s[0][COL_SUBTOTAL] = "1234"; s[0][COL_FACTOR] = "1"; s[0][COL_TOTAL] = "=F1*G1";
      return s;
    })() }];
    const result = upgradeWorkbook(flat);
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(0);
    expect(result.transformed.get("L1")![0][COL_SUBTOTAL]).toBe("1234");
  });
});
