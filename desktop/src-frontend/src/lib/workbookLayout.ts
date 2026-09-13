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

/** One user-defined column (index ≥ 8 / column I onward). Only these are stored per workbook. */
export interface UserColumn {
  label: string;       // "" for a blank freeform column (renders as just the letter)
  width: number;
  /** DETAIL formula — what a priced/leaf row computes. Per-row, with an `{r}` placeholder for the
   *  1-based row (e.g. `=I{r}*C{r}`, or the positional `=XSUMRATEUSER(1)` pulling from the row's
   *  rate build-up). `deriveLevelFormulas` fills an EMPTY cell on an active row with this; it never
   *  overwrites a cell that already holds a formula or a value, so a user edit (or a stamped
   *  rollup) always wins. Empty/undefined = a plain input column. */
  rowFormula?: string;
  /** ROLLUP (subtotal) formula — what to STAMP into this column when the row gains a `/S` cost
   *  child (a drill on F:Subtotal makes it a summary row), e.g. the positional `=XSUMUSER(2)`
   *  summing the cost child's own column 2. Stamped once at drill time (exactly as `F=XSUMTOT`
   *  is), then it's an ordinary editable cell — the app never re-derives or overrides it. This is
   *  the CostX model: the template, not the app, decides how a summary row rolls up its child.
   *  Empty/undefined = nothing is stamped for this column on drill. */
  rollupFormula?: string;
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
// freeform columns (Q–Z). This is what a NULL layout_json resolves to. Each column owns TWO
// template formulae (nothing about Lab/Mat/Sub/Sum is hardcoded in the app):
//   • rowFormula (DETAIL): a priced row's value — per-unit columns pull from the row's rate
//     build-up (=XSUMRATEUSER(n)); each "- Total" is per-unit × Quantity (=I{r}*C{r}).
//   • rollupFormula (SUMMARY): stamped when the row drills a /S cost child — every computed column
//     sums the cost child's OWN same column (=XSUMUSER(n)). Both per-unit and total roll up this
//     way, so a summary row reports the child's totals rather than re-multiplying by its own Qty.
const DEFAULT_USER_COLUMNS: ReadonlyArray<UserColumn> = [
  { label: "Lab",         width: 75, rowFormula: "=XSUMRATEUSER(1)", rollupFormula: "=XSUMUSER(1)" },
  { label: "Lab - Total", width: 95, rowFormula: "=I{r}*C{r}",       rollupFormula: "=XSUMUSER(2)" },
  { label: "Mat",         width: 75, rowFormula: "=XSUMRATEUSER(3)", rollupFormula: "=XSUMUSER(3)" },
  { label: "Mat - Total", width: 95, rowFormula: "=K{r}*C{r}",       rollupFormula: "=XSUMUSER(4)" },
  { label: "Sub",         width: 75, rowFormula: "=XSUMRATEUSER(5)", rollupFormula: "=XSUMUSER(5)" },
  { label: "Sub - Total", width: 95, rowFormula: "=M{r}*C{r}",       rollupFormula: "=XSUMUSER(6)" },
  { label: "Sum",         width: 75, rowFormula: "=XSUMRATEUSER(7)", rollupFormula: "=XSUMUSER(7)" },
  { label: "Sum - Total", width: 95, rowFormula: "=O{r}*C{r}",       rollupFormula: "=XSUMUSER(8)" },
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
    const userColumns: UserColumn[] = raw.userColumns.map((c) => ({
      label: typeof c?.label === "string" ? c.label : "",
      width: typeof c?.width === "number" && isFinite(c.width) && c.width > 0 ? c.width : EXTRA_COLUMN_WIDTH,
      ...(typeof c?.rowFormula === "string" && c.rowFormula.trim() !== "" ? { rowFormula: c.rowFormula } : {}),
      ...(typeof c?.rollupFormula === "string" && c.rollupFormula.trim() !== "" ? { rollupFormula: c.rollupFormula } : {}),
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
  return layout.userColumns.every((c, i) =>
    c.label === d[i].label && c.width === d[i].width
    && (c.rowFormula ?? "") === (d[i].rowFormula ?? "")
    && (c.rollupFormula ?? "") === (d[i].rollupFormula ?? ""));
}
