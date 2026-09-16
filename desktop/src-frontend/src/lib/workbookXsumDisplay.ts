// Display/input transform for the XSUM* rollup formulas.
//
// The engine needs the child REFERENCE to evaluate correctly (see workbookFunctions.ts), so a
// rollup cell STORES e.g.  =XSUMRATE(L1_sR6!H1:H1000)  or  =XSUMRATEUSER(L1_sR6!I1:I1000,2).
// But the estimator wants CostX's clean positional syntax, so the formula bar SHOWS and ACCEPTS:
//   =XSUMRATE()        =XSUMRATE(2)        =XSUMRATEUSER(1)        =XSUMRATEUSER(1,2)
// This module converts between the two, purely as strings — cheap, and only run on cell-select
// (toDisplay) and on formula commit (toStored), never per-render or per-recalc.
//
// The reference is redundant with the cell's own position: a rollup cell at (path,row) reads its
// child <path>/R<row> (or /Q<row> for the QTY family) — so `toStored` rebuilds the exact reference
// from the cell position, and `toDisplay` throws it away, keeping only the CostX-visible args
// (the user-column number for *USER, and the decimal places).

import { pathToSheetName } from "./workbookSheetNames";
import { COL_QTY, COL_TOTAL, legacyColLetter } from "./workbookCalc";
import { FIRST_USER_COL } from "./workbookLayout";

/** Row bound baked into a stored reference (child build-ups are small; sheets grow in 50s). */
export const XSUM_ROW_BOUND = 1000;

const XSUM_FNS = new Set(["XSUMTOT", "XSUMTOTQTY", "XSUMUSER", "XSUMRATE", "XSUMRATEUSER", "XSUMQTY", "XSUMQTYUSER"]);

function isUserFn(fn: string): boolean { return /USER$/.test(fn); }
/** Child suffix by function family (M5 unlimited depth): the Sub-Total/cost family drills to a
 *  recursive cost sheet (/S), the Rate family to a rate build-up leaf (/R), the Qty family to a
 *  quantity build-up leaf (/Q). This is what makes XSUMUSER (cost child) and XSUMRATEUSER (rate
 *  child) target genuinely different sheets. */
function childSuffix(fn: string): "S" | "R" | "Q" {
  if (fn === "XSUMQTY" || fn === "XSUMQTYUSER") return "Q";
  if (fn === "XSUMRATE" || fn === "XSUMRATEUSER") return "R";
  return "S"; // XSUMTOT, XSUMTOTQTY, XSUMUSER
}
/** 0-based column a non-USER function reads (Quantity for XSUMTOTQTY, Total otherwise). */
function baseCol(fn: string): number { return fn === "XSUMTOTQTY" ? COL_QTY : COL_TOTAL; }

/** 0-based column index for an "A".."Z".."AA" letter. */
function colIndexFromLetter(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// A STORED rollup: FN( <sheet>!<col><rows>[:<col><rows>] [, dp] ) — anchored, whole-cell form,
// used by isStoredRollup. toDisplay uses the unanchored STORED_CALL_RE below so a rollup can also
// be found nested inside a larger formula (e.g. wrapped in IF(...)).
const STORED_RE = /^=\s*(XSUM[A-Z]+)\s*\(\s*[A-Za-z0-9_]+!\$?([A-Za-z]+)\$?\d+(?::\$?[A-Za-z]+\$?\d+)?\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)\s*$/i;

// The same two call shapes, unanchored and global, so toDisplay/toStored can find and rewrite a
// rollup call wherever it sits inside a larger formula (e.g. =IF(H5>0,XSUMRATEUSER(2),0)) rather
// than only when it is the cell's entire content. A cell only ever drills to one child sheet, so
// every occurrence in one formula resolves against the same (parentPath, row).
const STORED_CALL_RE = /(XSUM[A-Z]+)\s*\(\s*[A-Za-z0-9_]+!\$?([A-Za-z]+)\$?\d+(?::\$?[A-Za-z]+\$?\d+)?\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)/gi;
const POSITIONAL_CALL_RE = /(XSUM[A-Z]+)\s*\(\s*(-?\d+(?:\.\d+)?)?\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)/gi;

/** Stored reference form → clean positional form for display. Rewrites every XSUM* call found
 *  anywhere in the formula (bare, or nested inside IF/other wrappers); returns the input unchanged
 *  when it contains no recognized stored rollup call (a hand-typed formula, plain text, a number, …). */
export function toDisplay(source: string): string {
  if (typeof source !== "string") return source;
  const trimmed = source.trim();
  if (trimmed.charAt(0) !== "=" || !/XSUM/i.test(trimmed)) return source;
  let changed = false;
  const result = trimmed.replace(STORED_CALL_RE, (whole: string, fnRaw: string, colLetter: string, dp: string | undefined) => {
    const fn = fnRaw.toUpperCase();
    if (!XSUM_FNS.has(fn)) return whole;
    changed = true;
    if (isUserFn(fn)) {
      const n = colIndexFromLetter(colLetter) - FIRST_USER_COL + 1;
      return dp != null ? `${fn}(${n},${dp})` : `${fn}(${n})`;
    }
    return dp != null ? `${fn}(${dp})` : `${fn}()`;
  });
  return changed ? result : source;
}

/** Clean positional form the user typed → stored reference form, using the cell's own position to
 *  rebuild the child reference. Rewrites every XSUM* call found anywhere in the formula (bare, or
 *  nested inside IF/other wrappers). Returns the input unchanged when it contains no recognized
 *  positional rollup call (so ordinary formulas/values pass straight through). */
export function toStored(input: string, parentPath: string, row: number): string {
  if (typeof input !== "string") return input;
  const trimmed = input.trim();
  if (trimmed.charAt(0) !== "=" || !/XSUM/i.test(trimmed)) return input;
  let changed = false;
  const result = trimmed.replace(POSITIONAL_CALL_RE, (whole: string, fnRaw: string, a: string | undefined, b: string | undefined) => {
    const fn = fnRaw.toUpperCase();
    if (!XSUM_FNS.has(fn)) return whole;
    changed = true;
    let col: number;
    let dp: string | undefined;
    if (isUserFn(fn)) {
      const n = a != null ? Math.max(1, Math.floor(Number(a))) : 1;
      col = FIRST_USER_COL + (n - 1);
      dp = b;
    } else {
      col = baseCol(fn);
      dp = a;
    }
    const childName = pathToSheetName(`${parentPath}/${childSuffix(fn)}${row}`);
    const c = legacyColLetter(col);
    const range = `${childName}!${c}1:${c}${XSUM_ROW_BOUND}`;
    return dp != null ? `${fn}(${range},${dp})` : `${fn}(${range})`;
  });
  return changed ? result : input;
}

/** True if `source` is a stored XSUM* rollup (so the caller knows the transform applies). */
export function isStoredRollup(source: unknown): boolean {
  return typeof source === "string" && STORED_RE.test(source.trim()) && XSUM_FNS.has((STORED_RE.exec(source.trim())![1]).toUpperCase());
}
