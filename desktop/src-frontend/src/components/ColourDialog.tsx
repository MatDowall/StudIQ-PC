import { useEffect, useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

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

  return (
    <DialogShell title={title} width={360} zIndex={1250} onClose={onCancel}>
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
    </DialogShell>
  );
}
