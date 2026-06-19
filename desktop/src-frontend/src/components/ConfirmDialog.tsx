import { useEffect } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <DialogShell title={title} width={430} zIndex={1300} onClose={onCancel}>
      <div style={{ padding: 12, color: theme.text.primary, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-line" }}>{body}</div>
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
          onClick={onConfirm}
          style={{
            height: 28,
            padding: "0 12px",
            background: theme.danger,
            color: "#FFFFFF",
            border: `1px solid ${theme.danger}`,
            cursor: "pointer",
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </DialogShell>
  );
}
