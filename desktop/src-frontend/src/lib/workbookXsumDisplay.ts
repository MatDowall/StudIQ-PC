// Display/input transform for the XSUM* rollup formulas.
//
// The engine needs the child REFERENCE to evaluate correctly (see workbookFunctions.ts), so a
// rollup cell STORES e.g.  =XSUMRATE(L1_sR6!H:H)  or  =XSUMRATEUSER(L1_sR6!I:I,2).
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

/** The stored child reference: the child sheet's WHOLE column (`L1_sS3!H:H`). A rollup means
 *  "everything in that column", so it must not carry a row bound — the old `H1:H1000` form silently
 *  dropped any build-up row past 1,000, and a row inserted above row 1 of the child shifted the
 *  range to `H2:H1001` and dropped the new row. A whole-column range has neither problem and is
 *  never rewritten by a row insert/delete. */
export function rollupRangeRef(childPath: string, col: number): string {
  const c = legacyColLetter(col);
  return `${pathToSheetName(childPath)}!${c}:${c}`;
}

// A child reference inside a stored rollup: whole-column (`H:H`, current) or row-bounded
// (`H1:H1000`, legacy — see normalizeLegacyRollups). Absolute `$` markers optional.
const CHILD_REF = String.raw`[A-Za-z0-9_]+!\$?([A-Za-z]+)(?:\$?\d+)?(?::\$?[A-Za-z]+(?:\$?\d+)?)?`;

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
const STORED_RE = new RegExp(String.raw`^=\s*(XSUM[A-Z]+)\s*\(\s*${CHILD_REF}\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)\s*$`, "i");

// The same two call shapes, unanchored and global, so toDisplay/toStored can find and rewrite a
// rollup call wherever it sits inside a larger formula (e.g. =IF(H5>0,XSUMRATEUSER(2),0)) rather
// than only when it is the cell's entire content. A cell only ever drills to one child sheet, so
// every occurrence in one formula resolves against the same (parentPath, row).
const STORED_CALL_RE = new RegExp(String.raw`(XSUM[A-Z]+)\s*\(\s*${CHILD_REF}\s*(?:,\s*(-?\d+(?:\.\d+)?)\s*)?\)`, "gi");
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
    const range = rollupRangeRef(`${parentPath}/${childSuffix(fn)}${row}`, col);
    return dp != null ? `${fn}(${range},${dp})` : `${fn}(${range})`;
  });
  return changed ? result : input;
}

/** True if `source` is a stored XSUM* rollup (so the caller knows the transform applies). */
export function isStoredRollup(source: unknown): boolean {
  return typeof source === "string" && STORED_RE.test(source.trim()) && XSUM_FNS.has((STORED_RE.exec(source.trim())![1]).toUpperCase());
}

// A legacy row-bounded child reference inside an XSUM* call: `XSUMRATE(L1_sS3!H1:H1000` → group 1
// is everything up to the `!`, group 2 the column. Only the range is rewritten; the rest of the
// call (decimal places, closing paren, any wrapper like IF(...)) is left exactly as it was.
const LEGACY_ROLLUP_REF_RE = /(XSUM[A-Z]+\s*\(\s*[A-Za-z0-9_]+!)\$?([A-Za-z]+)\$?\d+:\$?\2\$?\d+/gi;

/** Upgrades legacy row-bounded rollup references (`H1:H1000`) in one cell's text to the
 *  whole-column form (`H:H`). Applied to every sheet as it loads, so older workbooks stop capping
 *  their rollups at row 1,000 without a migration; the new text is saved with the sheet's next
 *  save. No-op for anything that isn't a formula containing a bounded rollup reference. */
export function normalizeLegacyRollups(text: string): string {
  if (text.charAt(0) !== "=" || !/XSUM/i.test(text)) return text;
  return text.replace(LEGACY_ROLLUP_REF_RE, (_m, head: string, col: string) => `${head}${col}:${col}`);
}
