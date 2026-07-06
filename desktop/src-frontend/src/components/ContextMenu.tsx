import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

export interface ContextMenuItem {
  label: string;
  action?: () => void;
  danger?: boolean;
  /** Greys the item out and makes it non-interactive — e.g. column insert/delete
   *  within the fixed A–P workbook columns. */
  disabled?: boolean;
  /** When set, hovering this item opens a nested panel — action is ignored. */
  submenu?: { label: string; action: () => void; danger?: boolean }[];
}

/** A thin divider between groups of items — pass in place of a ContextMenuItem. */
export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return "separator" in entry;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  // Stable refs to each submenu row's DOM element — read at render, never setState.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const panelRef = useRef<HTMLDivElement>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  // The panel's height depends on how many items it has (this menu can run to
  // 15+ rows), so a click near the bottom/right of the window would otherwise
  // push later rows off-screen — invisible and unclickable except for whatever
  // sliver of text happens to peek back into the viewport. Measure after mount
  // and clamp before paint so there's no visible jump.
  //
  // Width is measured and pinned to an explicit pixel value for the same
  // reason: leaving the panel to size itself via shrink-to-fit while its rows
  // are `width: 100%` is a circular layout (the panel's width depends on its
  // widest row's content, and each row's width depends on the panel) — most
  // engines resolve it fine, but pinning an explicit width removes any doubt
  // and guarantees every row's clickable area spans the full panel width.
  const [pos, setPos] = useState<{ top: number; left: number; width: number | undefined }>({ top: y, left: x, width: undefined });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    setPos({ top, left, width: rect.width });
  }, [x, y, items]);

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

  const activeSubmenuItems = openSubmenu
    ? items.find((i): i is ContextMenuItem => !isSeparator(i) && i.label === openSubmenu)?.submenu
    : null;

  return createPortal(
    <div
      onMouseDown={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000 }}
    >
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: pos.width,
          minWidth: 170,
          boxSizing: "border-box",
          padding: "4px 0",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
          fontSize: 12,
        }}
      >
        {items.map((entry, i) =>
          isSeparator(entry) ? (
            // eslint-disable-next-line react/no-array-index-key
            <div key={`sep-${i}`} style={{ height: 1, margin: "4px 0", background: theme.border.divider }} />
          ) : entry.submenu ? (
            <div
              key={entry.label}
              ref={(el) => {
                if (el) rowRefs.current.set(entry.label, el);
                else rowRefs.current.delete(entry.label);
              }}
              onMouseEnter={() => setOpenSubmenu(entry.label)}
              onMouseLeave={(e) => {
                // Keep open if the cursor moves into the submenu panel.
                const related = e.relatedTarget as Node | null;
                const panel = document.getElementById(`submenu-panel-${entry.label}`);
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
                  background: openSubmenu === entry.label ? "var(--hover-overlay)" : "transparent",
                  color: theme.text.primary,
                  textAlign: "left",
                  cursor: "default",
                  pointerEvents: "none",
                }}
              >
                <span>{entry.label}</span>
                <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 8 }}>›</span>
              </button>
            </div>
          ) : (
            <button
              key={entry.label}
              disabled={entry.disabled}
              onMouseEnter={() => setHoveredKey(entry.label)}
              onMouseLeave={() => setHoveredKey(k => (k === entry.label ? null : k))}
              onClick={() => {
                if (entry.disabled) return;
                entry.action?.();
                onClose();
              }}
              style={{
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: 26,
                padding: "0 12px",
                border: "none",
                background: !entry.disabled && hoveredKey === entry.label ? "var(--hover-overlay)" : "transparent",
                color: entry.disabled ? theme.text.secondary : entry.danger ? theme.danger : theme.text.primary,
                opacity: entry.disabled ? 0.5 : 1,
                textAlign: "left",
                cursor: entry.disabled ? "default" : "pointer",
              }}
            >
              {entry.label}
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
              onMouseEnter={() => setHoveredKey(item.label)}
              onMouseLeave={() => setHoveredKey(k => (k === item.label ? null : k))}
              onClick={() => {
                item.action();
                onClose();
              }}
              style={{
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                width: "100%",
                height: 26,
                padding: "0 12px",
                border: "none",
                background: hoveredKey === item.label ? "var(--hover-overlay)" : "transparent",
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
