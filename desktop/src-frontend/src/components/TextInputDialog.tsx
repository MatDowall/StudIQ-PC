import { useEffect, useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

interface TextInputDialogProps {
  title: string;
  label: string;
  initialValue: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function TextInputDialog({ title, label, initialValue, confirmLabel, onCancel, onConfirm }: TextInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const canConfirm = value.trim().length > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm) onConfirm(value.trim());
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, onCancel, onConfirm, value]);

  return (
    <DialogShell title={title} width={420} zIndex={1250} onClose={onCancel}>
      <div style={{ padding: 12 }}>
        <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>{label}</label>
        <input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          style={{
            boxSizing: "border-box",
            width: "100%",
            height: 30,
            padding: "0 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            outline: "none",
            fontSize: 13,
          }}
        />
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
          disabled={!canConfirm}
          onClick={() => onConfirm(value.trim())}
          style={{
            height: 28,
            padding: "0 12px",
            background: canConfirm ? theme.bg.active : theme.bg.input,
            color: canConfirm ? "#FFFFFF" : theme.text.disabled,
            border: `1px solid ${canConfirm ? theme.accent : theme.border.divider}`,
            cursor: canConfirm ? "pointer" : "default",
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
