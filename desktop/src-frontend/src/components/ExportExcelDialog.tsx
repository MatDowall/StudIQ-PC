import { useEffect, useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import type { FlattenExportLevels } from "../store/appStore";

interface ExportExcelDialogProps {
  onCancel: () => void;
  onConfirm: (levels: FlattenExportLevels) => void;
}

export function ExportExcelDialog({ onCancel, onConfirm }: ExportExcelDialogProps) {
  const [l1, setL1] = useState(true);
  const [l2, setL2] = useState(true);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const canExport = l1 || l2;

  const row = (
    checked: boolean,
    onChange: (v: boolean) => void,
    label: string,
    description: string,
  ) => (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", padding: "6px 0" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 2 }}
      />
      <span>
        <span style={{ fontWeight: 600, display: "block" }}>{label}</span>
        <span style={{ fontSize: 11, color: theme.text.secondary }}>{description}</span>
      </span>
    </label>
  );

  return (
    <DialogShell title="Export to Excel" width={420} zIndex={1300} onClose={onCancel}>
      <div style={{ padding: 12, color: theme.text.primary, fontSize: 12 }}>
        <div style={{ marginBottom: 8, color: theme.text.secondary }}>
          Choose which levels to flatten into the exported sheet:
        </div>
        {row(l1, setL1, "Sections (Level 1)", "Include each section's row in the output. With Items also selected, a section is shown as leading columns tagging its child items.")}
        {row(l2, setL2, "Items (Level 2)", "Include each section's take-off line items. A section with no item breakdown exports as a single row using the section's own values.")}
        {!canExport ? (
          <div style={{ marginTop: 8, fontSize: 11, color: theme.danger }}>Select at least one level.</div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "10px 12px",
          borderTop: `1px solid ${theme.border.subtle}`,
        }}
      >
        <button
          onClick={onCancel}
          style={{
            height: 28,
            padding: "0 12px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={() => canExport && onConfirm({ l1, l2 })}
          disabled={!canExport}
          style={{
            height: 28,
            padding: "0 12px",
            background: canExport ? theme.accent : theme.bg.input,
            color: canExport ? "#FFFFFF" : theme.text.disabled,
            border: `1px solid ${canExport ? theme.accent : theme.border.divider}`,
            cursor: canExport ? "pointer" : "not-allowed",
          }}
        >
          Export...
        </button>
      </div>
    </DialogShell>
  );
}
