import { useEffect } from "react";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

interface ErrorDialogProps {
  title: string;
  body: string;
  onDismiss: () => void;
}

export function ErrorDialog({ title, body, onDismiss }: ErrorDialogProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Enter") onDismiss();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss]);

  return (
    <DialogShell
      title={<><span className="material-symbols-outlined" style={{ fontSize: 18, lineHeight: 1 }}>error</span>{title}</>}
      titleStyle={{ color: theme.danger }}
      width={430}
      zIndex={1300}
      role="alertdialog"
      onClose={onDismiss}
    >
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
          autoFocus
          onClick={onDismiss}
          style={{
            height: 28,
            padding: "0 16px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
          }}
        >
          OK
        </button>
      </div>
    </DialogShell>
  );
}
