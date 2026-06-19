import { useEffect, useState } from "react";
import { theme } from "../theme";
import { formatQuantity } from "../lib/quantity";
import { DialogShell } from "./DialogShell";
import type { ImportDisplayOption } from "../lib/groupImport";

export type { ImportDisplayOption };

interface ImportDimensionDialogProps {
  groupName: string;
  options: ImportDisplayOption[];
  defaultKey: string;
  onCancel: () => void;
  onConfirm: (option: ImportDisplayOption) => void;
}

/**
 * CostX-style "bring dimension into workbook" prompt. Shown when a dimension group with more
 * than one possible derived display (driven by its default width/height settings — e.g. a
 * length measure with a height can come in as Length or Wall surface area) is dropped onto
 * a Level 2/3 quantity cell. Not shown for timber framing (lineal metres only) or groups that
 * only have a single possible display (e.g. count).
 */
export function ImportDimensionDialog({ groupName, options, defaultKey, onCancel, onConfirm }: ImportDimensionDialogProps) {
  const [selectedKey, setSelectedKey] = useState(defaultKey);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const selected = options.find((o) => o.key === selectedKey) ?? options[0];

  return (
    <DialogShell title="Import dimension group" width={380} zIndex={1300} onClose={onCancel}>
      <div style={{ padding: 12, fontSize: 12, lineHeight: 1.5 }}>
        <div style={{ marginBottom: 10, color: theme.text.secondary }}>
          <strong style={{ color: theme.text.primary }}>{groupName}</strong> can be brought into this
          quantity cell as:
        </div>
        {options.map((option) => (
          <label
            key={option.key}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "6px 8px",
              marginBottom: 4,
              cursor: "pointer",
              background: option.key === selectedKey ? theme.bg.active : "transparent",
              color: option.key === selectedKey ? "#FFFFFF" : theme.text.primary,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="radio"
                name="import-display"
                checked={option.key === selectedKey}
                onChange={() => setSelectedKey(option.key)}
              />
              {option.label}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatQuantity(option.quantity)}</span>
          </label>
        ))}
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
          onClick={() => selected && onConfirm(selected)}
          disabled={!selected}
          style={{
            height: 28,
            padding: "0 12px",
            background: theme.accent,
            color: "#FFFFFF",
            border: `1px solid ${theme.accent}`,
            cursor: selected ? "pointer" : "default",
            opacity: selected ? 1 : 0.5,
          }}
        >
          Import
        </button>
      </div>
    </DialogShell>
  );
}
