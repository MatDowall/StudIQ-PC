// The CostX-style XSUM* workbook function family, as a HyperFormula FunctionPlugin.
//
// Each function sums the child-sheet column given as its RANGE argument, optionally rounding to
// `dp` decimals:  =XSUMRATE(<childRange>[, dp]).  The range is an explicit argument so HyperFormula
// builds a real dependency edge child→parent — which is REQUIRED for correctness: a dependency-less
// (positional) function is scheduled before the child's own formula cells (F=E*C, H=F*G) are
// computed and reads them blank, and iterating does not fix it (each recalc resets with the same
// ordering). The range edge forces the child to be evaluated first, and makes a multi-level chain
// converge in one pass.
//
// All XSUM* are the same operation — ROUND(SUM(range), dp) — the distinct names are the CostX
// vocabulary and document intent at the call site (XSUMTOT/XSUMRATE/XSUMQTY = a Total/Quantity
// column; XSUMUSER/XSUMRATEUSER/XSUMQTYUSER = a user column). `dp` omitted (or negative) means no
// rounding, which the upgrade relies on so a declarative value matches the baked full-precision one.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { HyperFormula, FunctionPlugin, FunctionArgumentType } from "hyperformula";

function roundTo(value: number, dp: number): number {
  if (!isFinite(dp) || dp < 0) return value;
  const f = Math.pow(10, Math.floor(dp));
  return Math.round(value * f) / f;
}

export class WorkbookFunctionsPlugin extends FunctionPlugin {
  /** Sum the numeric cells of the range in arg 0, rounded to the optional `dp` in arg 1. */
  private sumRange(ast: any, state: any): number {
    const self = this as any;
    let total = 0;
    // Blank cells come back as HyperFormula's EmptyValue (a Symbol) and cells can hold CellError
    // objects — only fold in real numbers and numeric strings; never call Number() on a Symbol.
    const add = (v: unknown) => {
      if (typeof v === "number") { if (isFinite(v)) total += v; return; }
      if (typeof v === "string" && v !== "") { const n = parseFloat(v); if (isFinite(n)) total += n; }
    };
    if (ast.args && ast.args.length > 0) {
      const val = self.evaluateAst(ast.args[0], state);
      if (val && typeof val === "object" && Array.isArray((val as any).data)) {
        for (const r of (val as any).data) for (const c of r) add(c);
      } else {
        add(val);
      }
    }
    let dp = NaN;
    if (ast.args && ast.args.length > 1) {
      const d = self.evaluateAst(ast.args[1], state);
      const n = typeof d === "number" ? d : Number(d);
      if (isFinite(n)) dp = n;
    }
    return roundTo(total, dp);
  }

  xsumtot(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumtotqty(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumuser(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumrate(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumrateuser(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumqty(ast: any, state: any) { return this.sumRange(ast, state); }
  xsumqtyuser(ast: any, state: any) { return this.sumRange(ast, state); }
}

const PARAMS = [
  { argumentType: FunctionArgumentType.RANGE },
  { argumentType: FunctionArgumentType.NUMBER, optionalArg: true },
];

(WorkbookFunctionsPlugin as any).implementedFunctions = {
  XSUMTOT:      { method: "xsumtot",      parameters: PARAMS },
  XSUMTOTQTY:   { method: "xsumtotqty",   parameters: PARAMS },
  XSUMUSER:     { method: "xsumuser",     parameters: PARAMS },
  XSUMRATE:     { method: "xsumrate",     parameters: PARAMS },
  XSUMRATEUSER: { method: "xsumrateuser", parameters: PARAMS },
  XSUMQTY:      { method: "xsumqty",      parameters: PARAMS },
  XSUMQTYUSER:  { method: "xsumqtyuser",  parameters: PARAMS },
};

export const XSUM_FUNCTION_NAMES = [
  "XSUMTOT", "XSUMTOTQTY", "XSUMUSER", "XSUMRATE", "XSUMRATEUSER", "XSUMQTY", "XSUMQTYUSER",
] as const;

const TRANSLATIONS = {
  enGB: Object.fromEntries(XSUM_FUNCTION_NAMES.map((n) => [n, n])),
  enUS: Object.fromEntries(XSUM_FUNCTION_NAMES.map((n) => [n, n])),
};

let registered = false;

/** Register the XSUM* family globally (idempotent). Must run BEFORE any engine that uses the
 *  functions is built — the registration is static and reaches every engine. */
export function registerWorkbookFunctions(): void {
  if (registered) return;
  try {
    HyperFormula.registerFunctionPlugin(WorkbookFunctionsPlugin as any, TRANSLATIONS as any);
    registered = true;
  } catch {
    registered = true; // already registered (e.g. HMR re-import)
  }
}
