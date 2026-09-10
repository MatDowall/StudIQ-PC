// The CostX-style XSUM* workbook function family (M3), as a HyperFormula FunctionPlugin.
//
// These are the declarative rollup primitives: a parent cell holds e.g. `=XSUMTOT(2)` and the
// function reads the child sheet implied by its own position, instead of a literal being baked in
// by drillUp. The spike (see the roadmap) proved this works and is cheap: the functions are
// VOLATILE and derive their child sheet from `state.formulaAddress`, so HyperFormula recomputes
// them whenever anything changes — no explicit AST dependency on the child is needed, and ~200 of
// them recompute in a few ms.
//
// Child-sheet convention (matches WorkbookView's drill paths):
//   parent path P, parent row r →  Rate/Cost build-up = `P/R{r}`,  Quantity build-up = `P/Q{r}`.
//
// The plugin is self-contained per engine: it maps sheet id ↔ name through its own
// `dependencyGraph.sheetMapping`, so it is safe to register globally (once, at startup) and works
// against every engine — the live grid's and any standalone WorkbookEngine.
//
// Column indices are the fixed A–H roles plus the user block; kept in step with workbookCalc /
// workbookLayout (A–H never vary; user column n is FIRST_USER_COL + n − 1).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { HyperFormula, FunctionPlugin, FunctionArgumentType } from "hyperformula";
import { sheetNameToPath, pathToSheetName } from "./workbookSheetNames";
import { COL_QTY, COL_TOTAL } from "./workbookCalc";
import { FIRST_USER_COL } from "./workbookLayout";

const MAX_CHILD_ROWS = 1000; // upper bound when summing a child column (sheets grow in 50-row chunks)

type ChildKind = "R" | "Q"; // rate/cost build-up vs quantity build-up

/** Rounds to `dp` decimals (CostX's XSUM* second/last argument). When `dp` is omitted (NaN) or
 *  negative, returns the raw sum unrounded — this is what the v1→v2 upgrade emits (`=XSUMTOT()`)
 *  so the declarative value matches the full-precision literal drillUp used to bake in. */
function roundTo(value: number, dp: number): number {
  if (!isFinite(dp) || dp < 0) return value;
  const f = Math.pow(10, Math.floor(dp));
  return Math.round(value * f) / f;
}

export class WorkbookFunctionsPlugin extends FunctionPlugin {
  /** Core: from the calling cell, resolve the child sheet (`<parentPath>/<kind><row>`) and sum
   *  one of its columns, rounded to `dp`. Returns 0 when the child sheet doesn't exist yet
   *  (an un-built-up cell), matching the "empty build-up contributes nothing" rule. */
  private sumChildColumn(state: any, kind: ChildKind, col: number, dp: number): number {
    const self = this as any;
    const addr = state.formulaAddress as { sheet: number; row: number; col: number };
    const parentName: string | undefined = self.dependencyGraph.sheetMapping.getSheetName(addr.sheet);
    if (parentName == null) return 0;
    const childName = pathToSheetName(`${sheetNameToPath(parentName)}/${kind}${addr.row}`);
    let childId: number;
    try { childId = self.dependencyGraph.getSheetId(childName); } catch { return 0; }
    if (childId == null || childId < 0) return 0;
    let total = 0;
    for (let r = 0; r < MAX_CHILD_ROWS; r++) {
      const v = self.dependencyGraph.getScalarValue({ sheet: childId, row: r, col });
      const n = typeof v === "number" ? v : NaN;
      if (isFinite(n)) total += n;
    }
    return roundTo(total, dp);
  }

  /** dp argument: the first arg for XSUMTOT/XSUMRATE/XSUMQTY/XSUMTOTQTY, the SECOND for the
   *  *USER variants (first there is the 1-based user-column number). Defaults to NaN so an omitted
   *  `dp` means "no rounding" (see roundTo). */
  private argNum(state: any, ast: any, index: number, fallback = NaN): number {
    if (!ast.args || ast.args.length <= index) return fallback;
    const v = (this as any).evaluateAst(ast.args[index], state);
    const n = typeof v === "number" ? v : Number(v);
    return isFinite(n) ? n : fallback;
  }

  /** 0-based grid column for a 1-based user-column number (user col 1 = column I). */
  private userCol(n: number): number {
    const idx = Math.max(1, Math.floor(n));
    return FIRST_USER_COL + (idx - 1);
  }

  // ── Cost sub-sheet (F:Subtotal drill → /R) ──────────────────────────────
  xsumtot(ast: any, state: any) { return this.sumChildColumn(state, "R", COL_TOTAL, this.argNum(state, ast, 0)); }
  xsumtotqty(ast: any, state: any) { return this.sumChildColumn(state, "R", COL_QTY, this.argNum(state, ast, 0)); }
  xsumuser(ast: any, state: any) {
    return this.sumChildColumn(state, "R", this.userCol(this.argNum(state, ast, 0, 1)), this.argNum(state, ast, 1));
  }

  // ── Rate build-up (E:Rate drill → /R). StudIQ has no "Include" column; the rate total is H. ──
  xsumrate(ast: any, state: any) { return this.sumChildColumn(state, "R", COL_TOTAL, this.argNum(state, ast, 0)); }
  xsumrateuser(ast: any, state: any) {
    return this.sumChildColumn(state, "R", this.userCol(this.argNum(state, ast, 0, 1)), this.argNum(state, ast, 1));
  }

  // ── Quantity build-up (C:Quantity drill → /Q). Its Quantity lives in H. ──
  xsumqty(ast: any, state: any) { return this.sumChildColumn(state, "Q", COL_TOTAL, this.argNum(state, ast, 0)); }
  xsumqtyuser(ast: any, state: any) {
    return this.sumChildColumn(state, "Q", this.userCol(this.argNum(state, ast, 0, 1)), this.argNum(state, ast, 1));
  }
}

// dp parameter: optional, and deliberately NO defaultValue — an omitted dp must reach the method
// as "absent" (ast.args.length check) so it means "no rounding", not "round to 0".
const NUM_OPT = { argumentType: FunctionArgumentType.NUMBER, optionalArg: true };

(WorkbookFunctionsPlugin as any).implementedFunctions = {
  XSUMTOT:     { method: "xsumtot",     isVolatile: true, parameters: [NUM_OPT] },
  XSUMTOTQTY:  { method: "xsumtotqty",  isVolatile: true, parameters: [NUM_OPT] },
  XSUMUSER:    { method: "xsumuser",    isVolatile: true, parameters: [{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1 }, NUM_OPT] },
  XSUMRATE:    { method: "xsumrate",    isVolatile: true, parameters: [NUM_OPT] },
  XSUMRATEUSER:{ method: "xsumrateuser",isVolatile: true, parameters: [{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1 }, NUM_OPT] },
  XSUMQTY:     { method: "xsumqty",     isVolatile: true, parameters: [NUM_OPT] },
  XSUMQTYUSER: { method: "xsumqtyuser", isVolatile: true, parameters: [{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 1 }, NUM_OPT] },
};

const FUNCTION_NAMES = ["XSUMTOT", "XSUMTOTQTY", "XSUMUSER", "XSUMRATE", "XSUMRATEUSER", "XSUMQTY", "XSUMQTYUSER"] as const;

const TRANSLATIONS = {
  enGB: Object.fromEntries(FUNCTION_NAMES.map((n) => [n, n])),
  enUS: Object.fromEntries(FUNCTION_NAMES.map((n) => [n, n])),
};

let registered = false;

/** Register the XSUM* family globally (idempotent). Must run BEFORE any engine that uses the
 *  functions is built — the registration is static and reaches every engine, including the live
 *  grid's. Safe to call from module load and from tests. */
export function registerWorkbookFunctions(): void {
  if (registered) return;
  try {
    HyperFormula.registerFunctionPlugin(WorkbookFunctionsPlugin as any, TRANSLATIONS as any);
    registered = true;
  } catch {
    // Already registered (e.g. HMR re-import) — treat as done.
    registered = true;
  }
}
