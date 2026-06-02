import { useEffect } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

interface ContextMenuProps {
  x: number;
  y: number;
  items: { label: string; action: () => void; danger?: boolean }[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      onMouseDown={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
      }}
    >
      <div
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          position: "fixed",
          top: y,
          left: x,
          minWidth: 150,
          padding: "4px 0",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
          fontSize: 12,
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            onClick={() => {
              item.action();
              onClose();
            }}
            style={{
              display: "block",
              width: "100%",
              height: 26,
              padding: "0 12px",
              border: "none",
              background: "transparent",
              color: item.danger ? theme.danger : theme.text.primary,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
