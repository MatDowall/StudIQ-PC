import { useState } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

interface NewTemplateDialogProps {
  onCancel: () => void;
  onConfirm: (name: string, description: string) => void;
}

export function NewTemplateDialog({ onCancel, onConfirm }: NewTemplateDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const canConfirm = name.trim().length > 0;

  return (
    <DialogShell title="New Template" width={420} zIndex={1260} onClose={onCancel}>
      <div style={{ padding: 12 }}>
        <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>Name</label>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
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
            marginBottom: 10,
          }}
        />
        <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>Description</label>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          style={{
            boxSizing: "border-box",
            width: "100%",
            padding: "6px 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            outline: "none",
            fontSize: 13,
            fontFamily: "inherit",
            resize: "vertical",
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
          onClick={() => onConfirm(name.trim(), description.trim())}
          style={{
            height: 28,
            padding: "0 12px",
            background: canConfirm ? theme.bg.active : theme.bg.input,
            color: canConfirm ? "#FFFFFF" : theme.text.disabled,
            border: `1px solid ${canConfirm ? theme.accent : theme.border.divider}`,
            cursor: canConfirm ? "pointer" : "default",
          }}
        >
          Create
        </button>
      </div>
    </DialogShell>
  );
}
