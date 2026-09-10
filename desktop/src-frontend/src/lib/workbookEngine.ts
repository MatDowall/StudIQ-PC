// The multi-sheet workbook calculation engine (M1).
//
// Today WorkbookView keeps exactly one HyperFormula sheet ("Sheet1"), cleared and reloaded
// on every drill, and evaluates every *other* sheet in throwaway `HyperFormula.buildFromArray`
// instances (evaluateClonedRows / evaluateWithNames) because those sheets aren't loaded. This
// class replaces that model: ONE long-lived engine holds every sheet of a revision at once, so
//   - any sheet's evaluated values are readable at any time (no throwaway instances), and
//   - a parent cell can hold a *live cross-sheet formula* (`=SUM(child!H1:H200)`) instead of a
//     baked literal — the declarative CostX rollup the re-architecture is heading toward.
//
// The engine is standalone (owns its own HyperFormula), so it is fully unit-testable headlessly
// — see workbookEngine.test.ts, which proves the declarative rollup reproduces the golden
// fixture's totals. Wiring it to the live Handsontable grid (switchSheet on drill) is a separate
// step done under GUI verification; this module carries no React/Handsontable dependency.

import { HyperFormula } from "hyperformula";
import { SheetNameRegistry, pathToSheetName } from "./workbookSheetNames";
import { registerWorkbookFunctions } from "./workbookFunctions";

export interface SheetPayload {
  path: string;
  /** Source rows — formula strings and all. `null`/absent cells are blanks. */
  data: (string | null)[][];
}

/** Same null→"" mapping the grid applies before feeding HyperFormula: HF clears a cell only
 *  on an explicit empty string, never on `null`/`undefined`. */
function toEngineRows(data: (string | null)[][]): string[][] {
  return data.map((row) => row.map((cell) => cell ?? ""));
}

export class WorkbookEngine {
  private hf: HyperFormula;
  private reg = new SheetNameRegistry();

  constructor() {
    // Register the XSUM* family before building — registration is static/global, so this makes
    // the functions available to this (and every) engine. Idempotent.
    registerWorkbookFunctions();
    // GPL key — StudIQ is non-distributed internal software (see the re-architecture roadmap).
    this.hf = HyperFormula.buildEmpty({ licenseKey: "gpl-v3" });
  }

  /** The underlying engine — for handing to Handsontable's formulas plugin
   *  (`formulas: { engine: workbookEngine.raw() }`) when wiring the live grid. */
  raw(): HyperFormula {
    return this.hf;
  }

  /** HF sheet name for a path (whether or not it is loaded). */
  sheetName(path: string): string {
    return this.reg.nameFor(path) ?? pathToSheetName(path);
  }

  has(path: string): boolean {
    return this.reg.has(path);
  }

  /** Loaded sheet paths, in the order they were added. */
  paths(): string[] {
    return this.reg.paths();
  }

  /** Load a whole revision at once (replaces any current content). */
  loadAll(sheets: SheetPayload[]): void {
    for (const s of sheets) this.setSheet(s.path, s.data);
  }

  /** Add a new (empty or seeded) sheet for `path`. No-op if it already exists. */
  addSheet(path: string, data?: (string | null)[][]): void {
    if (this.reg.has(path)) {
      if (data) this.setSheet(path, data);
      return;
    }
    const name = this.reg.register(path);
    this.hf.addSheet(name);
    if (data) this.setSheet(path, data);
  }

  /** Replace a sheet's entire content (adding the sheet first if new). */
  setSheet(path: string, data: (string | null)[][]): void {
    if (!this.reg.has(path)) {
      const name = this.reg.register(path);
      this.hf.addSheet(name);
    }
    const id = this.hf.getSheetId(this.reg.nameFor(path)!)!;
    this.hf.setSheetContent(id, toEngineRows(data));
  }

  /** Remove a sheet (and, when used by the grid layer, every descendant path). No-op if absent. */
  removeSheet(path: string): void {
    const name = this.reg.nameFor(path);
    if (name === undefined) return;
    const id = this.hf.getSheetId(name);
    if (id !== undefined) this.hf.removeSheet(id);
    this.reg.unregister(path);
  }

  /** Evaluated (computed) values for a whole sheet, or [] if the sheet isn't loaded. */
  getEvaluatedSheet(path: string): unknown[][] {
    const name = this.reg.nameFor(path);
    if (name === undefined) return [];
    const id = this.hf.getSheetId(name);
    if (id === undefined) return [];
    return this.hf.getSheetValues(id);
  }

  /** Evaluated value of one cell, or null if the sheet/cell isn't present. */
  getCellValue(path: string, row: number, col: number): unknown {
    const name = this.reg.nameFor(path);
    if (name === undefined) return null;
    const id = this.hf.getSheetId(name);
    if (id === undefined) return null;
    return this.hf.getCellValue({ sheet: id, row, col });
  }

  /** A1-style cross-sheet reference to one cell (`L1_sR3!$H$7`) — the building block for the
   *  declarative rollups and for live named-cell references. Absolute by default. */
  cellRef(path: string, row: number, col: number, absolute = true): string {
    const name = this.sheetName(path);
    const colLetters = columnLetter(col);
    const $ = absolute ? "$" : "";
    return `${name}!${$}${colLetters}${$}${row + 1}`;
  }

  /** A cross-sheet range reference (`L1_sR3!$H$1:$H$200`) — used to sum a child sheet's column. */
  rangeRef(path: string, col: number, rowStart: number, rowEnd: number, absolute = true): string {
    const name = this.sheetName(path);
    const c = columnLetter(col);
    const $ = absolute ? "$" : "";
    return `${name}!${$}${c}${$}${rowStart + 1}:${$}${c}${$}${rowEnd + 1}`;
  }

  /** Define/replace a global named expression bound to a live cell reference — the M1 form of a
   *  named cell (no more literal snapshots, since every sheet is loaded). Safe to call repeatedly. */
  setNamedCellRef(name: string, path: string, row: number, col: number): void {
    const formula = `=${this.cellRef(path, row, col)}`;
    try {
      if (this.hf.getNamedExpression(name) != null) this.hf.changeNamedExpression(name, formula);
      else this.hf.addNamedExpression(name, formula);
    } catch {
      // Fall back to tear-down + re-add so a name never sticks on a stale formula.
      try { this.hf.removeNamedExpression(name); } catch { /* wasn't there */ }
      try { this.hf.addNamedExpression(name, formula); } catch { /* invalid name — skip */ }
    }
  }

  namedValue(name: string): unknown {
    try { return this.hf.getNamedExpressionValue(name); } catch { return undefined; }
  }

  destroy(): void {
    try { this.hf.destroy(); } catch { /* already gone */ }
    this.reg.clear();
  }
}

/** "A"/"AA"-style column letter for a 0-based index. (Mirrors legacyColLetter in workbookCalc
 *  but kept local so the engine has no dependency on the layout module.) */
function columnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
