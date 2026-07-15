import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="material-symbols-outlined" style={{ fontSize: size, lineHeight: 1, userSelect: "none", flexShrink: 0 }}>
      {name}
    </span>
  );
}

export interface MenuItem {
  label: string;
  icon?: string;
  enabled: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
  divider?: boolean;
}

export function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [subOpen, setSubOpen] = useState(false);

  if (item.divider) {
    return <div style={{ borderTop: `1px solid ${theme.border.subtle}`, margin: "4px 0" }} />;
  }

  const hasSubmenu = !!item.submenu;

  return (
    <div
      onMouseEnter={() => {
        if (hasSubmenu && item.enabled) setSubOpen(true);
      }}
      onMouseLeave={() => {
        if (hasSubmenu) setSubOpen(false);
      }}
      style={{ position: "relative" }}
    >
      <button
        type="button"
        disabled={!item.enabled}
        onClick={() => {
          if (hasSubmenu) return;
          if (!item.enabled) return;
          item.onClick?.();
          onDone();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          height: 30,
          padding: "0 10px",
          border: "none",
          background: "transparent",
          color: item.enabled ? theme.text.primary : theme.text.disabled,
          textAlign: "left",
          cursor: item.enabled ? "pointer" : "not-allowed",
          fontSize: 12,
          whiteSpace: "nowrap",
        }}
        onMouseEnter={(e) => {
          if (item.enabled) e.currentTarget.style.background = theme.bg.input;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {item.icon ? <Icon name={item.icon} size={15} /> : <span style={{ width: 15, flexShrink: 0 }} />}
        <span style={{ flex: 1 }}>{item.label}</span>
        {hasSubmenu ? <Icon name="chevron_right" size={15} /> : null}
      </button>
      {hasSubmenu && subOpen ? (
        <div
          style={{
            position: "absolute",
            top: -4,
            left: "100%",
            zIndex: 1400,
            minWidth: 200,
            background: theme.bg.pane,
            border: `1px solid ${theme.border.divider}`,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
            padding: "4px 0",
          }}
        >
          {item.submenu!.map((sub, i) => <MenuRow key={i} item={sub} onDone={onDone} />)}
        </div>
      ) : null}
    </div>
  );
}

export function TopMenu({ label, items, statusText }: { label: string; items: MenuItem[]; statusText?: string }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function handleToggle() {
    if (!open && wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom, left: rect.left });
    }
    setOpen((v) => !v);
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative", height: "100%", display: "flex" }}>
      <button
        type="button"
        onClick={handleToggle}
        style={{
          height: "100%",
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          background: open ? theme.bg.hover : "transparent",
          color: theme.text.secondary,
          border: "none",
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "Segoe UI, sans-serif",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = theme.bg.hover;
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        {label}
      </button>
      {statusText ? (
        <div style={{ display: "flex", alignItems: "center", paddingLeft: 6, fontSize: 11, color: theme.text.secondary }}>
          {statusText}
        </div>
      ) : null}
      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              style={{
                position: "fixed",
                top: menuPos.top,
                left: menuPos.left,
                zIndex: 1300,
                minWidth: 200,
                background: theme.bg.pane,
                border: `1px solid ${theme.border.divider}`,
                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
                padding: "4px 0",
                color: theme.text.primary,
              }}
            >
              {items.map((item, i) => <MenuRow key={i} item={item} onDone={() => setOpen(false)} />)}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
