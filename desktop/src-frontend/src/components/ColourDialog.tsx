import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

interface ColourDialogProps {
  title: string;
  initialColour: string;
  onCancel: () => void;
  onConfirm: (colour: string) => void;
}

export function ColourDialog({ title, initialColour, onCancel, onConfirm }: ColourDialogProps) {
  const [colour, setColour] = useState(initialColour);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter") onConfirm(colour);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [colour, onCancel, onConfirm]);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1250,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.45)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: 360,
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
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 12 }}>
          <input
            autoFocus
            type="color"
            value={colour}
            onChange={(event) => setColour(event.target.value)}
            style={{
              width: 48,
              height: 32,
              padding: 0,
              background: theme.bg.input,
              border: `1px solid ${theme.border.divider}`,
              cursor: "pointer",
            }}
          />
          <input
            value={colour}
            onChange={(event) => setColour(event.target.value)}
            style={{
              boxSizing: "border-box",
              flex: 1,
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
            onClick={() => onConfirm(colour)}
            style={{
              height: 28,
              padding: "0 12px",
              background: theme.bg.active,
              color: "#FFFFFF",
              border: `1px solid ${theme.accent}`,
              cursor: "pointer",
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
