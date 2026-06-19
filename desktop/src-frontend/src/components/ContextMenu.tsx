import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

export interface ContextMenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  /** When set, hovering this item opens a nested panel — action is ignored. */
  submenu?: { label: string; action: () => void; danger?: boolean }[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  // Stable refs to each submenu row's DOM element — read at render, never setState.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Compute submenu panel position directly from the stored row ref.
  const anchorEl = openSubmenu ? (rowRefs.current.get(openSubmenu) ?? null) : null;
  const anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
  const panelW = 170;
  const submenuLeft = anchorRect
    ? (anchorRect.right + panelW > window.innerWidth ? anchorRect.left - panelW : anchorRect.right)
    : x + 170;

  const activeSubmenuItems = openSubmenu ? items.find((i) => i.label === openSubmenu)?.submenu : null;

  return createPortal(
    <div
      onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000 }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: y,
          left: x,
          minWidth: 170,
          padding: "4px 0",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
          fontSize: 12,
        }}
      >
        {items.map((item) =>
          item.submenu ? (
            <div
              key={item.label}
              ref={(el) => {
                if (el) rowRefs.current.set(item.label, el);
                else rowRefs.current.delete(item.label);
              }}
              onMouseEnter={() => setOpenSubmenu(item.label)}
              onMouseLeave={(e) => {
                // Keep open if the cursor moves into the submenu panel.
                const related = e.relatedTarget as Node | null;
                const panel = document.getElementById(`submenu-panel-${item.label}`);
                if (panel && related && panel.contains(related)) return;
                setOpenSubmenu(null);
              }}
            >
              <button
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  height: 26,
                  padding: "0 12px",
                  border: "none",
                  background: openSubmenu === item.label ? "var(--hover-overlay)" : "transparent",
                  color: theme.text.primary,
                  textAlign: "left",
                  cursor: "default",
                  pointerEvents: "none",
                }}
              >
                <span>{item.label}</span>
                <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>›</span>
              </button>
            </div>
          ) : (
            <button
              key={item.label}
              onClick={() => {
                item.action?.();
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
          ),
        )}
      </div>

      {activeSubmenuItems && anchorRect && (
        <div
          id={`submenu-panel-${openSubmenu}`}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseLeave={() => setOpenSubmenu(null)}
          style={{
            position: "fixed",
            top: anchorRect.top,
            left: submenuLeft,
            minWidth: panelW,
            padding: "4px 0",
            background: theme.bg.pane,
            border: `1px solid ${theme.border.divider}`,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
            color: theme.text.primary,
            fontFamily: "Segoe UI, sans-serif",
            fontSize: 12,
            zIndex: 1001,
          }}
        >
          {activeSubmenuItems.map((item) => (
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
      )}
    </div>,
    document.body,
  );
}
