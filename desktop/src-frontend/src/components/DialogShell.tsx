import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

interface DialogShellProps {
  title: ReactNode;
  titleStyle?: CSSProperties;
  panelStyle?: CSSProperties;
  width?: number;
  zIndex?: number;
  role?: string;
  onClose?: () => void;
  children: ReactNode;
}

export function DialogShell({
  title,
  titleStyle,
  panelStyle,
  width = 430,
  zIndex = 1300,
  role = "dialog",
  onClose,
  children,
}: DialogShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    function onMouseMove(ev: MouseEvent) {
      setPos({ x: ev.clientX - offsetX, y: ev.clientY - offsetY });
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const panelPosition: CSSProperties = pos
    ? { position: "fixed", left: pos.x, top: pos.y }
    : { position: "fixed", left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex, background: "rgba(0, 0, 0, 0.46)" }} />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        style={{
          ...panelPosition,
          zIndex: zIndex + 1,
          width,
          maxWidth: "calc(100vw - 40px)",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
          ...panelStyle,
        }}
      >
        <div
          onMouseDown={onTitleMouseDown}
          style={{
            height: 38,
            display: "flex",
            alignItems: "center",
            padding: "0 6px 0 12px",
            background: theme.bg.ribbon,
            borderBottom: `1px solid ${theme.border.subtle}`,
            fontSize: 13,
            fontWeight: 600,
            cursor: "move",
            userSelect: "none",
            flexShrink: 0,
            gap: 8,
            ...titleStyle,
          }}
        >
          <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>{title}</span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              tabIndex={-1}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 26,
                background: "transparent",
                border: "none",
                color: theme.text.secondary,
                cursor: "pointer",
                borderRadius: 3,
                padding: 0,
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--hover-overlay)";
                (e.currentTarget as HTMLButtonElement).style.color = theme.text.primary;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = theme.text.secondary;
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16, lineHeight: 1 }}>close</span>
            </button>
          )}
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}
