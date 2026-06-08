import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";
import { formatQuantity, type Quantity } from "../lib/quantity";

export interface ImportDisplayOption {
  /** One of "count" | "length" | "area" | "wall_area" | "volume" — the derived display the
   *  dimension group's geometry can be brought into the workbook as. */
  key: string;
  label: string;
  quantity: Quantity;
}

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

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.48)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: 380,
          maxWidth: "calc(100vw - 40px)",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            height: 38,
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            background: theme.bg.ribbon,
            borderBottom: `1px solid ${theme.border.subtle}`,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Import dimension group
        </div>
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
      </div>
    </div>,
    document.body,
  );
}
