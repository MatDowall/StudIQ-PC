// Tests for the per-workbook column layout (M2).
//
// The critical test is DEFAULT-EQUIVALENCE: standardColumns(default) and qtyColumns(default)
// must reproduce, byte-for-byte, the exact { letter, label, width } arrays WorkbookView shipped
// with — otherwise "columns as data" would silently change every existing workbook's appearance.
// The literals below are copied verbatim from the pre-M2 COLUMNS / QTY_COLUMNS.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_WORKBOOK_LAYOUT, standardColumns, qtyColumns, parseLayout, serializeLayout,
  isDefaultLayout, columnLetterForIndex, FIRST_USER_COL, type WorkbookLayout,
} from "./workbookLayout";

// ── Verbatim copies of the shipped arrays (label + width only; letter checked separately) ──
const SHIPPED_STANDARD = [
  ["A", "Code", 80], ["B", "Description", 220], ["C", "Quantity", 90], ["D", "Unit", 65],
  ["E", "Rate", 85], ["F", "Subtotal", 95], ["G", "Factor", 75], ["H", "Total", 95],
  ["I", "Lab", 75], ["J", "Lab - Total", 95], ["K", "Mat", 75], ["L", "Mat - Total", 95],
  ["M", "Sub", 75], ["N", "Sub - Total", 95], ["O", "Sum", 75], ["P", "Sum - Total", 95],
  ["Q", "", 90], ["R", "", 90], ["S", "", 90], ["T", "", 90], ["U", "", 90],
  ["V", "", 90], ["W", "", 90], ["X", "", 90], ["Y", "", 90], ["Z", "", 90],
] as const;

const SHIPPED_QTY = [
  ["A", "Code", 80], ["B", "Description", 220], ["C", "Count", 80], ["D", "Length", 80],
  ["E", "Width", 80], ["F", "Height", 80], ["G", "Factor", 75], ["H", "Quantity", 95],
  ["I", "Lab", 75], ["J", "Lab - Total", 95], ["K", "Mat", 75], ["L", "Mat - Total", 95],
  ["M", "Sub", 75], ["N", "Sub - Total", 95], ["O", "Sum", 75], ["P", "Sum - Total", 95],
  ["Q", "", 90], ["R", "", 90], ["S", "", 90], ["T", "", 90], ["U", "", 90],
  ["V", "", 90], ["W", "", 90], ["X", "", 90], ["Y", "", 90], ["Z", "", 90],
] as const;

describe("default layout is byte-identical to the shipped columns", () => {
  it("standardColumns(default) matches shipped COLUMNS", () => {
    const got = standardColumns(DEFAULT_WORKBOOK_LAYOUT).map((c) => [c.letter, c.label, c.width]);
    expect(got).toEqual(SHIPPED_STANDARD.map((r) => [...r]));
  });
  it("qtyColumns(default) matches shipped QTY_COLUMNS", () => {
    const got = qtyColumns(DEFAULT_WORKBOOK_LAYOUT).map((c) => [c.letter, c.label, c.width]);
    expect(got).toEqual(SHIPPED_QTY.map((r) => [...r]));
  });
  it("both kinds share the same 26-column count and identical I-onward user block", () => {
    const std = standardColumns(DEFAULT_WORKBOOK_LAYOUT);
    const qty = qtyColumns(DEFAULT_WORKBOOK_LAYOUT);
    expect(std.length).toBe(26);
    expect(qty.length).toBe(26);
    expect(std.slice(FIRST_USER_COL)).toEqual(qty.slice(FIRST_USER_COL));
  });
  it("A–H carry the expected fixed roles", () => {
    const roles = standardColumns(DEFAULT_WORKBOOK_LAYOUT).slice(0, 8).map((c) => c.role);
    expect(roles).toEqual(["code", "description", "quantity", "unit", "rate", "subtotal", "factor", "total"]);
    const qtyRoles = qtyColumns(DEFAULT_WORKBOOK_LAYOUT).slice(0, 8).map((c) => c.role);
    expect(qtyRoles).toEqual(["code", "description", "count", "length", "width", "height", "factor", "total"]);
  });
  it("every user column has role 'user'", () => {
    expect(standardColumns(DEFAULT_WORKBOOK_LAYOUT).slice(FIRST_USER_COL).every((c) => c.role === "user")).toBe(true);
  });

  it("user columns carry no formula of their own — label/width only", () => {
    const u = DEFAULT_WORKBOOK_LAYOUT.userColumns;
    expect(Object.keys(u[0])).toEqual(["label", "width"]);
    expect(Object.keys(u[8])).toEqual(["label", "width"]);
  });
});

describe("columnLetterForIndex", () => {
  it("A–Z then AA, AB", () => {
    expect(columnLetterForIndex(0)).toBe("A");
    expect(columnLetterForIndex(25)).toBe("Z");
    expect(columnLetterForIndex(26)).toBe("AA");
    expect(columnLetterForIndex(27)).toBe("AB");
  });
});

describe("parse / serialize round-trip and legacy default", () => {
  it("NULL layout_json resolves to the shipped default", () => {
    expect(isDefaultLayout(parseLayout(null))).toBe(true);
    expect(isDefaultLayout(parseLayout(undefined))).toBe(true);
    expect(isDefaultLayout(parseLayout(""))).toBe(true);
  });
  it("garbage resolves to default rather than throwing", () => {
    expect(isDefaultLayout(parseLayout("not json"))).toBe(true);
    expect(isDefaultLayout(parseLayout("{}"))).toBe(true);
  });
  it("round-trips a custom layout", () => {
    const custom: WorkbookLayout = {
      userColumns: [
        { label: "Hours", width: 70 },
        { label: "Hours - Total", width: 90 },
        { label: "", width: 90 },
      ],
    };
    const back = parseLayout(serializeLayout(custom));
    expect(back.userColumns).toEqual(custom.userColumns);
    expect(isDefaultLayout(back)).toBe(false);
  });

  it("a renamed label alone makes a layout non-default", () => {
    const layout = parseLayout(null);
    layout.userColumns[0].label = "Hours"; // was the default "Lab"
    expect(isDefaultLayout(layout)).toBe(false);
  });

  it("a legacy blob still carrying rowFormula/rollupFormula keys parses to label/width only", () => {
    const legacy = JSON.stringify({
      userColumns: [{ label: "Lab", width: 75, rowFormula: "=XSUMRATEUSER(1)", rollupFormula: "=XSUMUSER(1)" }],
    });
    expect(parseLayout(legacy).userColumns).toEqual([{ label: "Lab", width: 75 }]);
  });
  it("a renamed user column reaches the built columns while A–H stay fixed", () => {
    const custom = parseLayout(serializeLayout({
      userColumns: [{ label: "Man Hours", width: 80 }],
    }));
    const cols = standardColumns(custom);
    expect(cols).toHaveLength(9);              // A–H + one user column
    expect(cols[8]).toEqual({ letter: "I", label: "Man Hours", width: 80, role: "user" });
    expect(cols[2]).toEqual({ letter: "C", label: "Quantity", width: 90, role: "quantity" });
  });
  it("coerces bad widths/labels defensively", () => {
    const parsed = parseLayout(JSON.stringify({ userColumns: [{ label: 5, width: -3 }, { foo: 1 }] }));
    expect(parsed.userColumns).toEqual([{ label: "", width: 90 }, { label: "", width: 90 }]);
  });
});
