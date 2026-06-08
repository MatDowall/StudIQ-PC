import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";

interface NewFromTemplateDialogProps {
  defaultName: string;
  onCancel: () => void;
  onConfirm: (templateId: number, name: string) => void;
}

export function NewFromTemplateDialog({ defaultName, onCancel, onConfirm }: NewFromTemplateDialogProps) {
  const templates = useAppStore((s) => s.templates);
  const loadTemplates = useAppStore((s) => s.loadTemplates);

  const [templateId, setTemplateId] = useState<number | null>(null);
  const [name, setName] = useState(defaultName);

  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const canConfirm = templateId !== null && name.trim().length > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm) onConfirm(templateId!, name.trim());
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, name, onCancel, onConfirm, templateId]);

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
          width: 420,
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
          New Revision from Template
        </div>
        <div style={{ padding: 12 }}>
          <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>Template</label>
          <div
            style={{
              height: 140,
              overflow: "auto",
              border: `1px solid ${theme.border.subtle}`,
              background: theme.bg.shell,
              marginBottom: 10,
            }}
          >
            {templates.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No templates available</div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTemplateId(t.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    height: 26,
                    padding: "0 8px",
                    border: "none",
                    background: t.id === templateId ? theme.bg.active : "transparent",
                    color: t.id === templateId ? "#FFFFFF" : theme.text.primary,
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: 12,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.name}
                </button>
              ))
            )}
          </div>
          <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>Revision name</label>
          <input
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
            onClick={() => onConfirm(templateId!, name.trim())}
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
      </div>
    </div>,
    document.body,
  );
}
