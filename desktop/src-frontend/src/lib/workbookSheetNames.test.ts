// Tests for the path ↔ HyperFormula sheet-name mapping (M1 groundwork).
// Pure string logic — no engine, no GPL dependency touched.

import { describe, it, expect } from "vitest";
import { pathToSheetName, sheetNameToPath, SheetNameRegistry } from "./workbookSheetNames";

const SAMPLE_PATHS = [
  "L1",
  "L1/R3",
  "L1/R3/Q5",
  "L1/R3/R2/R7", // deep recursion (M5) — must already round-trip
  "TEMPLATE_MASTER_L2",
  "TEMPLATE_MASTER_L3",
  "TEMPLATE_MASTER_LQ",
  "L12/R100/Q0",
];

describe("pathToSheetName / sheetNameToPath", () => {
  it("produces HF-legal names — no '/', non-empty", () => {
    for (const p of SAMPLE_PATHS) {
      const name = pathToSheetName(p);
      expect(name).not.toContain("/");
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("round-trips every sample path", () => {
    for (const p of SAMPLE_PATHS) {
      expect(sheetNameToPath(pathToSheetName(p))).toBe(p);
    }
  });

  it("is deterministic — same path always yields the same name", () => {
    expect(pathToSheetName("L1/R3/Q5")).toBe(pathToSheetName("L1/R3/Q5"));
  });

  it("keeps distinct paths distinct — including the underscore-bearing masters", () => {
    const names = SAMPLE_PATHS.map(pathToSheetName);
    expect(new Set(names).size).toBe(SAMPLE_PATHS.length);
    // The failure mode this guards: an underscore-based separator colliding with the
    // literal underscores in TEMPLATE_MASTER_*.
    expect(pathToSheetName("TEMPLATE_MASTER_L2")).not.toBe(pathToSheetName("TEMPLATE/MASTER/L2"));
    expect(sheetNameToPath(pathToSheetName("TEMPLATE_MASTER_L2"))).toBe("TEMPLATE_MASTER_L2");
    expect(sheetNameToPath(pathToSheetName("TEMPLATE/MASTER/L2"))).toBe("TEMPLATE/MASTER/L2");
  });

  it("rejects an empty path", () => {
    expect(() => pathToSheetName("")).toThrow();
  });
});

describe("SheetNameRegistry", () => {
  it("registers, resolves both ways, and is idempotent", () => {
    const reg = new SheetNameRegistry();
    const name = reg.register("L1/R3");
    expect(reg.register("L1/R3")).toBe(name); // idempotent
    expect(reg.nameFor("L1/R3")).toBe(name);
    expect(reg.pathFor(name)).toBe("L1/R3");
    expect(reg.has("L1/R3")).toBe(true);
    expect(reg.has("L1/R9")).toBe(false);
  });

  it("tracks all registered paths in insertion order", () => {
    const reg = new SheetNameRegistry();
    reg.register("L1");
    reg.register("L1/R3");
    reg.register("L1/R3/Q5");
    expect(reg.paths()).toEqual(["L1", "L1/R3", "L1/R3/Q5"]);
  });

  it("unregister removes both directions", () => {
    const reg = new SheetNameRegistry();
    const name = reg.register("L1/R3");
    reg.unregister("L1/R3");
    expect(reg.has("L1/R3")).toBe(false);
    expect(reg.nameFor("L1/R3")).toBeUndefined();
    expect(reg.pathFor(name)).toBeUndefined();
    reg.unregister("L1/R3"); // no-op, must not throw
  });

  it("clear empties the registry", () => {
    const reg = new SheetNameRegistry();
    reg.register("L1");
    reg.clear();
    expect(reg.paths()).toEqual([]);
  });
});
