import { useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import {
  FIRST_USER_COL, columnLetterForIndex, isDefaultLayout, DEFAULT_WORKBOOK_LAYOUT,
  type WorkbookLayout,
} from "../lib/workbookLayout";

interface ColumnLayoutDialogProps {
  layout: WorkbookLayout;
  onClose: () => void;
  /** Persist the edited layout (or the default when the user resets). */
  onSave: (layout: WorkbookLayout) => void;
}

// Fixed A–H, shown read-only so the estimator sees the whole column map. C–H differ between the
// two sheet kinds (standard takeoff vs. Quantity Build-up), so both are listed.
const FIXED_STANDARD = ["Code", "Description", "Quantity", "Unit", "Rate", "Subtotal", "Factor", "Total"];
const FIXED_QTY = ["Code", "Description", "Count", "Length", "Width", "Height", "Factor", "Quantity"];

/** Edit the workbook's user columns (I onward) — the CostX "columns from I are user-defined"
 *  model. A–H are fixed by role and shown read-only for context. Widths stay as-is (columns are
 *  resized by dragging in the grid); this dialog is about names. */
export function ColumnLayoutDialog({ layout, onClose, onSave }: ColumnLayoutDialogProps) {
  const [labels, setLabels] = useState<string[]>(layout.userColumns.map((c) => c.label));
  const [formulas, setFormulas] = useState<string[]>(layout.userColumns.map((c) => c.rowFormula ?? ""));
  const [rollups, setRollups] = useState<string[]>(layout.userColumns.map((c) => c.rollupFormula ?? ""));

  const commit = () => {
    const userColumns = layout.userColumns.map((c, i) => {
      const rowFormula = (formulas[i] ?? "").trim();
      const rollupFormula = (rollups[i] ?? "").trim();
      const next: typeof c = { ...c, label: labels[i] ?? c.label };
      if (rowFormula) next.rowFormula = rowFormula; else delete next.rowFormula;
      if (rollupFormula) next.rollupFormula = rollupFormula; else delete next.rollupFormula;
      return next;
    });
    onSave({ userColumns });
    onClose();
  };

  const resetToDefault = () => {
    onSave({ userColumns: DEFAULT_WORKBOOK_LAYOUT.userColumns.map((c) => ({ ...c })) });
    onClose();
  };

  const edited =
    labels.some((l, i) => l !== (layout.userColumns[i]?.label ?? "")) ||
    formulas.some((f, i) => f.trim() !== (layout.userColumns[i]?.rowFormula ?? "")) ||
    rollups.some((f, i) => f.trim() !== (layout.userColumns[i]?.rollupFormula ?? ""));
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, height: 26 };
  const letterCell: React.CSSProperties = { width: 28, textAlign: "center", color: theme.text.muted, fontVariantNumeric: "tabular-nums" };

  return (
    <DialogShell title="Column Layout" width={760} zIndex={1240} onClose={onClose}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: theme.text.secondary, lineHeight: 1.5 }}>
          Columns <strong>A–H are fixed</strong> by role. Everything from column <strong>I</strong> onward
          is yours. Each column owns two formulae: a <strong>Detail</strong> formula for a priced line
          (e.g. <code>=I{"{r}"}*C{"{r}"}</code> or <code>=XSUMRATEUSER(1)</code>, with <code>{"{r}"}</code>
          for the row), and a <strong>Rollup</strong> formula stamped when a row drills a Sub-Total into a
          cost sheet (e.g. <code>=XSUMUSER(2)</code> to sum that child's column 2). Leave a formula blank
          for none. Applies to every sheet in this workbook.
        </div>

        {/* Fixed A–H, read-only */}
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.text.muted, marginBottom: 4 }}>
            Fixed columns (A–H)
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 16px" }}>
            {FIXED_STANDARD.map((label, i) => (
              <div key={i} style={{ ...rowStyle, height: 22 }}>
                <span style={letterCell}>{columnLetterForIndex(i)}</span>
                <span style={{ fontSize: 12, color: theme.text.secondary }}>
                  {label}{FIXED_QTY[i] !== label ? ` / ${FIXED_QTY[i]}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Editable user columns (I onward) */}
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: theme.text.muted, marginBottom: 4 }}>
            User columns (I onward)
          </div>
          <div style={{ ...rowStyle, height: 18 }}>
            <span style={letterCell} />
            <span style={{ width: 120, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: theme.text.muted }}>Name</span>
            <span style={{ flex: 1, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: theme.text.muted }}>Detail formula (priced line)</span>
            <span style={{ flex: 1, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4, color: theme.text.muted }}>Rollup formula (on drill)</span>
          </div>
          <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
            {labels.map((label, i) => (
              <div key={i} style={rowStyle}>
                <span style={letterCell}>{columnLetterForIndex(FIRST_USER_COL + i)}</span>
                <input
                  value={label}
                  placeholder="(blank)"
                  onChange={(e) => setLabels((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                  style={{
                    width: 120, height: 24, padding: "0 8px", fontSize: 12,
                    background: theme.bg.input, color: theme.text.primary,
                    border: `1px solid ${theme.border.subtle}`, borderRadius: 4,
                  }}
                />
                <input
                  value={formulas[i]}
                  placeholder="e.g. =XSUMRATEUSER(1) or =I{r}*C{r}"
                  onChange={(e) => setFormulas((prev) => prev.map((f, j) => (j === i ? e.target.value : f)))}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                  spellCheck={false}
                  style={{
                    flex: 1, minWidth: 0, height: 24, padding: "0 8px", fontSize: 12, fontFamily: "monospace",
                    background: theme.bg.input, color: theme.text.primary,
                    border: `1px solid ${theme.border.subtle}`, borderRadius: 4,
                  }}
                />
                <input
                  value={rollups[i]}
                  placeholder="e.g. =XSUMUSER(2)"
                  onChange={(e) => setRollups((prev) => prev.map((f, j) => (j === i ? e.target.value : f)))}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                  spellCheck={false}
                  style={{
                    flex: 1, minWidth: 0, height: 24, padding: "0 8px", fontSize: 12, fontFamily: "monospace",
                    background: theme.bg.input, color: theme.text.primary,
                    border: `1px solid ${theme.border.subtle}`, borderRadius: 4,
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 }}>
          <button
            onClick={resetToDefault}
            disabled={isDefaultLayout(layout) && !edited}
            style={{
              fontSize: 12, padding: "5px 10px", background: "transparent",
              color: theme.text.secondary, border: `1px solid ${theme.border.subtle}`,
              borderRadius: 4, cursor: "pointer",
            }}
          >
            Reset to default
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              style={{
                fontSize: 12, padding: "5px 12px", background: "transparent",
                color: theme.text.secondary, border: `1px solid ${theme.border.subtle}`,
                borderRadius: 4, cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={commit}
              disabled={!edited}
              style={{
                fontSize: 12, padding: "5px 12px", background: edited ? theme.accent : theme.bg.active,
                color: edited ? "#fff" : theme.text.disabled,
                border: "none", borderRadius: 4, cursor: edited ? "pointer" : "default",
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}
