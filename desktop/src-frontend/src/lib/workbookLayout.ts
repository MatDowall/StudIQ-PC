// Per-workbook column layout (M2).
//
// Today the A–P column meanings are hardcoded in WorkbookView. The CostX model fixes A–H by
// role and lets everything from column I onward be user-defined and renameable. This module is
// that model: A–H are built-in (their roles never change), and the layout stores only the
// *user columns* (I onward). A workbook persists its layout as `layout_json` on its revision;
// NULL means "the legacy default", so every existing project is already correct with no backfill.
//
// The builders below emit column descriptors shaped exactly like WorkbookView's existing COLUMNS
// entries ({ letter, label, width, role }) so they are drop-in, and workbookLayout.test.ts pins
// the default output byte-for-byte against the layout StudIQ shipped with.

// ─── Roles ─────────────────────────────────────────────────────────────────
// Fixed A–H roles for the two sheet kinds, plus "user" for everything from I onward.
export type ColumnRole =
  | "code" | "description" | "quantity" | "unit" | "rate" | "subtotal" | "factor" | "total" // standard A–H
  | "count" | "length" | "width" | "height"                                                  // qty-sheet C–F
  | "user";

export interface ColumnDef {
  letter: string;      // positional display letter (A, B, … AA) — never varies by layout
  label: string;       // header label ("Code", "Lab", "" for a blank freeform column)
  width: number;
  role: ColumnRole;
}

/** One user-defined column (index ≥ 8 / column I onward). Only these are stored per workbook.
 *  A user column carries no formula of its own — matching CostX, a formula only ever exists in
 *  a cell because a human typed it there (or it arrived via a row copy/paste that carries an
 *  existing formula's data along — see afterPaste/maybeCloneChildSheet in WorkbookView.tsx). A
 *  Lab/Mat/Sub/Sum convention (or any other) is something the estimator sets up once, in one
 *  example row, and copies as needed — there is no separate master-template mechanism. */
export interface UserColumn {
  label: string;       // "" for a blank freeform column (renders as just the letter)
  width: number;
}

export interface WorkbookLayout {
  /** Columns from I onward, in order. A–H are fixed and not stored here. */
  userColumns: UserColumn[];
}

const EXTRA_COLUMN_WIDTH = 90;
const NUM_BLANK_TRAILING = 10; // Q–Z, matching the shipped layout

// Fixed A–H for the standard (takeoff / rate build-up / trade summary) sheet kind.
const STANDARD_FIXED: ReadonlyArray<Omit<ColumnDef, "letter">> = [
  { label: "Code",        width: 80,  role: "code" },
  { label: "Description", width: 220, role: "description" },
  { label: "Quantity",    width: 90,  role: "quantity" },
  { label: "Unit",        width: 65,  role: "unit" },
  { label: "Rate",        width: 85,  role: "rate" },
  { label: "Subtotal",    width: 95,  role: "subtotal" },
  { label: "Factor",      width: 75,  role: "factor" },
  { label: "Total",       width: 95,  role: "total" },
];

// Fixed A–H for the Quantity Build-up sheet kind (C–F are Count/Length/Width/Height,
// G/H are Factor/Quantity; A/B match the standard kind).
const QTY_FIXED: ReadonlyArray<Omit<ColumnDef, "letter">> = [
  { label: "Code",        width: 80,  role: "code" },
  { label: "Description", width: 220, role: "description" },
  { label: "Count",       width: 80,  role: "count" },
  { label: "Length",      width: 80,  role: "length" },
  { label: "Width",       width: 80,  role: "width" },
  { label: "Height",      width: 80,  role: "height" },
  { label: "Factor",      width: 75,  role: "factor" },
  { label: "Quantity",    width: 95,  role: "total" },
];

// The shipped user columns: the Lab/Mat/Sub/Sum pull-through block (I–P) plus ten blank
// freeform columns (Q–Z). This is what a NULL layout_json resolves to. Label/width only — no
// formula lives here; an estimator sets up the actual Lab/Mat/Sub/Sum formulas
// (=XSUMRATEUSER(n) per-unit, =I{r}*C{r} etc. for the totals, =XSUMUSER(n) once a row's
// F:Subtotal is drilled) once, in an example row, and copies it as needed.
const DEFAULT_USER_COLUMNS: ReadonlyArray<UserColumn> = [
  { label: "Lab",         width: 75 },
  { label: "Lab - Total", width: 95 },
  { label: "Mat",         width: 75 },
  { label: "Mat - Total", width: 95 },
  { label: "Sub",         width: 75 },
  { label: "Sub - Total", width: 95 },
  { label: "Sum",         width: 75 },
  { label: "Sum - Total", width: 95 },
  ...Array.from({ length: NUM_BLANK_TRAILING }, () => ({ label: "", width: EXTRA_COLUMN_WIDTH })),
];

export const DEFAULT_WORKBOOK_LAYOUT: WorkbookLayout = {
  userColumns: DEFAULT_USER_COLUMNS.map((c) => ({ ...c })),
};

/** "A"/"AA"-style column letter for a 0-based index. */
export function columnLetterForIndex(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function buildColumns(fixed: ReadonlyArray<Omit<ColumnDef, "letter">>, userCols: ReadonlyArray<UserColumn>): ColumnDef[] {
  const out: ColumnDef[] = fixed.map((c, i) => ({ letter: columnLetterForIndex(i), ...c }));
  userCols.forEach((c, i) => {
    out.push({ letter: columnLetterForIndex(fixed.length + i), label: c.label, width: c.width, role: "user" });
  });
  return out;
}

/** Full A-onward column list for a standard sheet under `layout` (drop-in for the old COLUMNS). */
export function standardColumns(layout: WorkbookLayout): ColumnDef[] {
  return buildColumns(STANDARD_FIXED, layout.userColumns);
}

/** Full A-onward column list for a Quantity Build-up sheet under `layout` (drop-in for QTY_COLUMNS). */
export function qtyColumns(layout: WorkbookLayout): ColumnDef[] {
  return buildColumns(QTY_FIXED, layout.userColumns);
}

/** Index of the first user column (always 8 — A–H are fixed). */
export const FIRST_USER_COL = STANDARD_FIXED.length;

/** Resolve a persisted `layout_json` (or null/invalid) to a concrete layout. NULL ⇒ the shipped
 *  default, so existing projects need no migration. */
export function parseLayout(json: string | null | undefined): WorkbookLayout {
  if (!json) return { userColumns: DEFAULT_WORKBOOK_LAYOUT.userColumns.map((c) => ({ ...c })) };
  try {
    const raw = JSON.parse(json) as Partial<WorkbookLayout>;
    if (!Array.isArray(raw.userColumns)) return { userColumns: DEFAULT_WORKBOOK_LAYOUT.userColumns.map((c) => ({ ...c })) };
    // A persisted blob from before this field existed may still carry rowFormula/
    // rollupFormula keys — simply not read here, so they quietly drop out on next save.
    const userColumns: UserColumn[] = raw.userColumns.map((c) => ({
      label: typeof c?.label === "string" ? c.label : "",
      width: typeof c?.width === "number" && isFinite(c.width) && c.width > 0 ? c.width : EXTRA_COLUMN_WIDTH,
    }));
    return { userColumns };
  } catch {
    return { userColumns: DEFAULT_WORKBOOK_LAYOUT.userColumns.map((c) => ({ ...c })) };
  }
}

export function serializeLayout(layout: WorkbookLayout): string {
  return JSON.stringify({ userColumns: layout.userColumns });
}

/** True when a layout is the shipped default (used to persist NULL rather than a redundant blob). */
export function isDefaultLayout(layout: WorkbookLayout): boolean {
  const d = DEFAULT_WORKBOOK_LAYOUT.userColumns;
  if (layout.userColumns.length !== d.length) return false;
  return layout.userColumns.every((c, i) => c.label === d[i].label && c.width === d[i].width);
}
