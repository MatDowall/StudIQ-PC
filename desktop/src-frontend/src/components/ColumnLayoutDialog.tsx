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
 *  resized by dragging in the grid); this dialog is about names only — a user column carries no
 *  formula of its own (see UserColumn's doc comment in lib/workbookLayout.ts): what a cell
 *  computes is always whatever an estimator typed into it, or brought along by copying a row
 *  that already had it. */
export function ColumnLayoutDialog({ layout, onClose, onSave }: ColumnLayoutDialogProps) {
  const [labels, setLabels] = useState<string[]>(layout.userColumns.map((c) => c.label));

  const commit = () => {
    const userColumns = layout.userColumns.map((c, i) => ({ ...c, label: labels[i] ?? c.label }));
    onSave({ userColumns });
    onClose();
  };

  const resetToDefault = () => {
    onSave({ userColumns: DEFAULT_WORKBOOK_LAYOUT.userColumns.map((c) => ({ ...c })) });
    onClose();
  };

  const edited = labels.some((l, i) => l !== (layout.userColumns[i]?.label ?? ""));
  const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, height: 26 };
  const letterCell: React.CSSProperties = { width: 28, textAlign: "center", color: theme.text.muted, fontVariantNumeric: "tabular-nums" };

  return (
    <DialogShell title="Column Layout" width={480} zIndex={1240} onClose={onClose}>
      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: theme.text.secondary, lineHeight: 1.5 }}>
          Columns <strong>A–H are fixed</strong> by role. Everything from column <strong>I</strong> onward
          is yours to name. Applies to every sheet in this workbook.
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
          <div style={{ maxHeight: 320, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
            {labels.map((label, i) => (
              <div key={i} style={rowStyle}>
                <span style={letterCell}>{columnLetterForIndex(FIRST_USER_COL + i)}</span>
                <input
                  value={label}
                  placeholder="(blank)"
                  onChange={(e) => setLabels((prev) => prev.map((l, j) => (j === i ? e.target.value : l)))}
                  onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
                  style={{
                    flex: 1, minWidth: 0, height: 24, padding: "0 8px", fontSize: 12,
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
