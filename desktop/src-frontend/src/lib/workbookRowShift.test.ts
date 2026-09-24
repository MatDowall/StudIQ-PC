// Row insert/delete in the workbook is a native Handsontable `alter`, which the Formulas plugin
// forwards to HyperFormula's addRows/removeRows. These tests pin the HyperFormula behaviour that
// relies on — every reference to a moved row follows it, on the same sheet, from other sheets and
// in named expressions — plus what WorkbookView relies on around that: rollups reference a child's
// whole column (so a row op never shifts them), and sheet names of moved sub-sheets are retargeted.

import { describe, it, expect } from "vitest";
import { WorkbookEngine } from "./workbookEngine";
import { retargetSheetRefs } from "./workbookSheetNames";
import { toStored } from "./workbookXsumDisplay";
import { COL_DESC, COL_SUBTOTAL, COL_TOTAL } from "./workbookCalc";

const NUM_COLS = 16;
function sheet(rows: number): (string | null)[][] {
  return Array.from({ length: rows }, () => Array<string | null>(NUM_COLS).fill(null));
}

/** L1 with H1..H5 = 10..50, a total and a cross-row reference below, a child referencing a parent
 *  cell, and a named expression bound to H5. */
function fixture() {
  const eng = new WorkbookEngine();
  const l1 = sheet(20);
  for (let r = 0; r < 5; r++) l1[r][COL_TOTAL] = String((r + 1) * 10);
  l1[8][COL_DESC] = "=H3*2";
  l1[9][COL_TOTAL] = "=SUM(H1:H5)";
  const child = sheet(5);
  child[0][COL_TOTAL] = "=L1!H4";
  eng.loadAll([{ path: "L1", data: l1 }, { path: "L1/S3", data: child }]);
  eng.raw().addNamedExpression("PT", "=L1!$H$5");
  const hf = eng.raw();
  const l1Id = hf.getSheetId(eng.sheetName("L1"))!;
  const childId = hf.getSheetId(eng.sheetName("L1/S3"))!;
  return { eng, hf, l1Id, childId };
}

describe("native row insert/delete — references follow the moved rows", () => {
  it("an insert shifts same-sheet, cross-sheet and named references and grows spanning ranges", () => {
    const { eng, hf, l1Id, childId } = fixture();
    hf.addRows(l1Id, [2, 1]); // insert above H3

    expect(hf.getCellSerialized({ sheet: l1Id, row: 10, col: COL_TOTAL })).toBe("=SUM(H1:H6)");
    expect(hf.getCellSerialized({ sheet: l1Id, row: 9, col: COL_DESC })).toBe("=H4*2");
    expect(hf.getCellSerialized({ sheet: childId, row: 0, col: COL_TOTAL })).toBe("=L1!H5");
    expect(hf.getNamedExpressionFormula("PT")).toBe("=L1!$H$6");

    // Values are unchanged — the same data, just one row lower.
    expect(hf.getCellValue({ sheet: l1Id, row: 10, col: COL_TOTAL })).toBe(150);
    expect(hf.getCellValue({ sheet: childId, row: 0, col: COL_TOTAL })).toBe(40);
    expect(hf.getNamedExpressionValue("PT")).toBe(50);

    // A value typed into the new row is inside the grown total.
    hf.setCellContents({ sheet: l1Id, row: 2, col: COL_TOTAL }, [["5"]]);
    expect(hf.getCellValue({ sheet: l1Id, row: 10, col: COL_TOTAL })).toBe(155);
    eng.destroy();
  });

  it("a delete shifts references up, shrinks ranges, and #REFs a reference to the deleted row", () => {
    const { eng, hf, l1Id, childId } = fixture();
    hf.removeRows(l1Id, [1, 1]); // delete H2 (=20)

    expect(hf.getCellSerialized({ sheet: l1Id, row: 8, col: COL_TOTAL })).toBe("=SUM(H1:H4)");
    expect(hf.getCellValue({ sheet: l1Id, row: 8, col: COL_TOTAL })).toBe(130);
    expect(hf.getCellSerialized({ sheet: childId, row: 0, col: COL_TOTAL })).toBe("=L1!H3");
    expect(hf.getNamedExpressionFormula("PT")).toBe("=L1!$H$4");

    hf.removeRows(l1Id, [2, 1]); // delete what the child now points at (H3 = 40)
    const v = hf.getCellValue({ sheet: childId, row: 0, col: COL_TOTAL }) as { value?: string };
    expect(v?.value).toBe("#REF!");
    eng.destroy();
  });
});

describe("rollup references into a child sheet", () => {
  it("a whole-column rollup counts a row inserted above the child's first row, and rows past 1,000", () => {
    const eng = new WorkbookEngine();
    const parent = sheet(5);
    parent[3][COL_SUBTOTAL] = toStored("=XSUMTOT()", "L1", 3);
    expect(parent[3][COL_SUBTOTAL]).toBe("=XSUMTOT(L1_sS3!H:H)");
    const child = sheet(1200);
    child[0][COL_TOTAL] = "100";
    child[1100][COL_TOTAL] = "50"; // past the old H1:H1000 bound
    eng.loadAll([{ path: "L1", data: parent }, { path: "L1/S3", data: child }]);
    const hf = eng.raw();
    const pId = hf.getSheetId(eng.sheetName("L1"))!;
    const cId = hf.getSheetId(eng.sheetName("L1/S3"))!;
    expect(hf.getCellValue({ sheet: pId, row: 3, col: COL_SUBTOTAL })).toBe(150);

    hf.addRows(cId, [0, 1]);
    hf.setCellContents({ sheet: cId, row: 0, col: COL_TOTAL }, [["7"]]);
    expect(hf.getCellSerialized({ sheet: pId, row: 3, col: COL_SUBTOTAL })).toBe("=XSUMTOT(L1_sS3!H:H)");
    expect(hf.getCellValue({ sheet: pId, row: 3, col: COL_SUBTOTAL })).toBe(157);
    eng.destroy();
  });
});

describe("retargetSheetRefs", () => {
  it("rewrites the moved sheet and its descendants, and nothing that merely shares a prefix", () => {
    const f = "=XSUMTOT(L1_sS3!H1:H1000)+XSUMRATE(L1_sS3_sR2!H1:H1000)+XSUMTOT(L1_sS30!H1:H9)";
    expect(retargetSheetRefs(f, "L1/S3", "L1/S4")).toBe(
      "=XSUMTOT(L1_sS4!H1:H1000)+XSUMRATE(L1_sS4_sR2!H1:H1000)+XSUMTOT(L1_sS30!H1:H9)",
    );
  });

  it("leaves plain values and unrelated formulas untouched", () => {
    expect(retargetSheetRefs("L1_sS3!H1", "L1/S3", "L1/S4")).toBe("L1_sS3!H1"); // not a formula
    expect(retargetSheetRefs("=A1*2", "L1/S3", "L1/S4")).toBe("=A1*2");
    expect(retargetSheetRefs(null, "L1/S3", "L1/S4")).toBeNull();
  });
});
