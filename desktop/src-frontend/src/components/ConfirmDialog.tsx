import { useEffect } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

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
          width: 430,
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
          {title}
        </div>
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
      </div>
    </div>,
    document.body,
  );
}
