// Path ↔ HyperFormula sheet-name mapping for the multi-sheet workbook engine (M1).
//
// Today the workbook keeps exactly one HyperFormula sheet, always named "Sheet1",
// cleared and reloaded on every drill. M1 loads every sheet of a revision into one
// engine at once, so each sheet path ("L1", "L1/R3", "L1/R3/Q5", "TEMPLATE_MASTER_L2")
// needs its own HyperFormula sheet — and HF sheet names cannot contain "/". This module
// is the single, pure, testable translation between the two namespaces.
//
// The transform is DETERMINISTIC and REVERSIBLE (not order-dependent): a given path always
// maps to the same HF name, so a cross-sheet reference stays valid regardless of the order
// sheets were added to the engine. `SheetNameRegistry` keeps the authoritative bidirectional
// map at runtime; the pure functions below generate its entries.
//
// This module intentionally does NOT import hyperformula — it is pure string logic, so its
// tests run without touching the (GPL) engine.

// Path segment grammar in use: "L1", "R3", "Q5", and the reserved template masters
// ("TEMPLATE_MASTER_L2" / "_L3" / "_LQ"), joined by "/". Segments are [A-Za-z0-9_].
// We escape existing underscores before using an underscore-based separator, so the
// mapping round-trips even for the underscore-bearing TEMPLATE_MASTER_* paths:
//   "_"  in a segment → "_u"   (escape first, so no bare "_" survives except ours)
//   "/"  between segs  → "_s"
// Reversal replaces "_s" → "/" then "_u" → "_". Unambiguous because, after escaping,
// the only character ever following a bare "_" is "u" or "s" (both introduced by us).

const SLASH_TOKEN = "_s";
const USCORE_TOKEN = "_u";

/** Deterministic HyperFormula sheet name for a workbook sheet path. Reversible via
 *  `sheetNameToPath`. Same path ⇒ same name, independent of insertion order. */
export function pathToSheetName(path: string): string {
  if (path === "") throw new Error("sheet path must not be empty");
  return path
    .split("/")
    .map((seg) => seg.replace(/_/g, USCORE_TOKEN))
    .join(SLASH_TOKEN);
}

/** Inverse of `pathToSheetName`. */
export function sheetNameToPath(name: string): string {
  return name
    .split(SLASH_TOKEN)
    .map((seg) => seg.replace(/_u/g, "_"))
    .join("/");
}

/** Authoritative runtime map between sheet paths and the HF sheet names an engine holds.
 *  The engine layer registers each path here as it adds the sheet, then translates in both
 *  directions through this registry rather than re-deriving strings ad hoc. Names are still
 *  generated deterministically by `pathToSheetName`, so the map only ever confirms what the
 *  transform already guarantees — but it is the single place the "which paths are loaded"
 *  question is answered. */
export class SheetNameRegistry {
  private pathToName = new Map<string, string>();
  private nameToPath = new Map<string, string>();

  /** Registers a path (idempotent) and returns its HF sheet name. */
  register(path: string): string {
    const existing = this.pathToName.get(path);
    if (existing !== undefined) return existing;
    const name = pathToSheetName(path);
    this.pathToName.set(path, name);
    this.nameToPath.set(name, path);
    return name;
  }

  /** HF sheet name for a path, or undefined if never registered. */
  nameFor(path: string): string | undefined {
    return this.pathToName.get(path);
  }

  /** Workbook path for an HF sheet name, or undefined if never registered. */
  pathFor(name: string): string | undefined {
    return this.nameToPath.get(name);
  }

  has(path: string): boolean {
    return this.pathToName.has(path);
  }

  /** Drops a path (and its name) from the registry — used when a sheet subtree is deleted. */
  unregister(path: string): void {
    const name = this.pathToName.get(path);
    if (name === undefined) return;
    this.pathToName.delete(path);
    this.nameToPath.delete(name);
  }

  /** Every registered path, in insertion order. */
  paths(): string[] {
    return [...this.pathToName.keys()];
  }

  clear(): void {
    this.pathToName.clear();
    this.nameToPath.clear();
  }
}
