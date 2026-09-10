// Tests for the XSUM* display/input transform (clean positional in the formula bar ↔ stored
// child-reference form). Pure string logic.

import { describe, it, expect } from "vitest";
import { toDisplay, toStored, isStoredRollup } from "./workbookXsumDisplay";
import { FIRST_USER_COL } from "./workbookLayout";
import { legacyColLetter } from "./workbookCalc";

const I = legacyColLetter(FIRST_USER_COL);       // "I" (user col 1)
const K = legacyColLetter(FIRST_USER_COL + 2);   // "K" (user col 3)

describe("toDisplay: stored reference → clean positional", () => {
  it("XSUMTOT/RATE/QTY drop the reference (keep dp)", () => {
    expect(toDisplay("=XSUMTOT(L1_sR6!H1:H1000)")).toBe("=XSUMTOT()");
    expect(toDisplay("=XSUMRATE(L1_sR6_sR2!H1:H1000,2)")).toBe("=XSUMRATE(2)");
    expect(toDisplay("=XSUMQTY(L1_sR6_sQ2!H1:H1000,3)")).toBe("=XSUMQTY(3)");
  });
  it("XSUMUSER family recover the user-column number from the reference column", () => {
    expect(toDisplay(`=XSUMUSER(L1_sR6!${legacyColLetter(FIRST_USER_COL + 1)}1:${legacyColLetter(FIRST_USER_COL + 1)}1000)`)).toBe("=XSUMUSER(2)");
    expect(toDisplay(`=XSUMRATEUSER(L1_sR6_sR2!${I}1:${I}1000,2)`)).toBe("=XSUMRATEUSER(1,2)");
    expect(toDisplay(`=XSUMRATEUSER(L1_sR6_sR2!${K}1:${K}1000)`)).toBe("=XSUMRATEUSER(3)");
  });
  it("passes non-rollup content through unchanged", () => {
    expect(toDisplay("=E1*C1")).toBe("=E1*C1");
    expect(toDisplay("=SUM(A1:A9)")).toBe("=SUM(A1:A9)");
    expect(toDisplay("hello")).toBe("hello");
    expect(toDisplay("42")).toBe("42");
  });
});

describe("toStored: clean positional → stored reference (from cell position)", () => {
  it("rebuilds the /R child reference for XSUMTOT/RATE", () => {
    expect(toStored("=XSUMTOT()", "L1", 6)).toBe("=XSUMTOT(L1_sR6!H1:H1000)");
    expect(toStored("=XSUMRATE(2)", "L1/R6", 2)).toBe("=XSUMRATE(L1_sR6_sR2!H1:H1000,2)");
  });
  it("rebuilds the /Q child reference for the QTY family", () => {
    expect(toStored("=XSUMQTY(3)", "L1/R6", 2)).toBe("=XSUMQTY(L1_sR6_sQ2!H1:H1000,3)");
  });
  it("maps the user-column number back to the right column", () => {
    expect(toStored("=XSUMRATEUSER(1,2)", "L1/R6", 2)).toBe(`=XSUMRATEUSER(L1_sR6_sR2!${I}1:${I}1000,2)`);
    expect(toStored("=XSUMUSER(3)", "L1", 6)).toBe(`=XSUMUSER(L1_sR6!${K}1:${K}1000)`);
  });
  it("passes non-rollup content through unchanged", () => {
    expect(toStored("=E1*C1", "L1", 0)).toBe("=E1*C1");
    expect(toStored("123", "L1", 0)).toBe("123");
    expect(toStored("=XSUMTOT(L1_sR6!H1:H1000)", "L1", 6)).toBe("=XSUMTOT(L1_sR6!H1:H1000)"); // already stored → untouched
  });
});

describe("round-trip", () => {
  it("stored → display → stored is stable for the same cell position", () => {
    const cases: Array<[string, string, number]> = [
      ["=XSUMTOT(L1_sR6!H1:H1000)", "L1", 6],
      ["=XSUMRATE(L1_sR6_sR2!H1:H1000,2)", "L1/R6", 2],
      ["=XSUMQTY(L1_sR6_sQ2!H1:H1000,3)", "L1/R6", 2],
      [`=XSUMRATEUSER(L1_sR6_sR2!${I}1:${I}1000,2)`, "L1/R6", 2],
    ];
    for (const [stored, path, r] of cases) {
      expect(toStored(toDisplay(stored), path, r)).toBe(stored);
    }
  });
});

describe("isStoredRollup", () => {
  it("recognises stored rollups only", () => {
    expect(isStoredRollup("=XSUMTOT(L1_sR6!H1:H1000)")).toBe(true);
    expect(isStoredRollup("=XSUMTOT()")).toBe(false); // positional, not stored
    expect(isStoredRollup("=E1*C1")).toBe(false);
    expect(isStoredRollup(42)).toBe(false);
  });
});
