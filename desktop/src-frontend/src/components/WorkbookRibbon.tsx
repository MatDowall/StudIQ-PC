import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { NewFromTemplateDialog } from "./NewFromTemplateDialog";

const BUTTON_ICONS: Record<string, string> = {
  "New Revision": "add_circle",
  "New from Template": "dashboard_customize",
  Delete: "delete",
  "Expand All": "unfold_more",
  "Collapse All": "unfold_less",
  "Add Row": "playlist_add",
  "Insert Above": "vertical_align_top",
  "Insert Below": "vertical_align_bottom",
  Export: "save_as",
  Print: "print",
  Settings: "settings",
};

const FONT_FAMILIES = ["Arial", "Calibri", "Segoe UI", "Times New Roman", "Courier New", "Verdana"];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];

function FormatToggleButton({
  icon,
  title,
  active,
  disabled,
  onClick,
}: {
  icon: string;
  title: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 22,
        height: 20,
        padding: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: `1px solid ${active ? theme.accent : theme.border.divider}`,
        background: active ? theme.bg.active : theme.bg.input,
        color: disabled ? theme.text.disabled : theme.text.primary,
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>
    </button>
  );
}

// Standard text-formatting controls for the active workbook cell selection —
// applies to the highlighted cell(s) via the WorkbookView format bridge
// (see appStore.workbookFormat / workbookFormatApi).
function FormatToolbar() {
  const format = useAppStore((s) => s.workbookFormat);
  const api = useAppStore((s) => s.workbookFormatApi);
  const disabled = !format.enabled || !api;

  const selectStyle: React.CSSProperties = {
    height: 20,
    fontSize: 10,
    background: theme.bg.input,
    color: disabled ? theme.text.disabled : theme.text.primary,
    border: `1px solid ${theme.border.divider}`,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", gap: 3 }}>
        <select
          title="Font"
          disabled={disabled}
          value={format.fontFamily}
          onChange={(e) => api?.setFontFamily(e.target.value)}
          style={{ ...selectStyle, width: 92 }}
        >
          {FONT_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select
          title="Font size"
          disabled={disabled}
          value={format.fontSize}
          onChange={(e) => api?.setFontSize(Number(e.target.value))}
          style={{ ...selectStyle, width: 40 }}
        >
          {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 3 }}>
        <FormatToggleButton icon="format_bold" title="Bold (Ctrl+B)" active={format.bold} disabled={disabled} onClick={() => api?.toggleBold()} />
        <FormatToggleButton icon="format_italic" title="Italic (Ctrl+I)" active={format.italic} disabled={disabled} onClick={() => api?.toggleItalic()} />
        <FormatToggleButton icon="format_underlined" title="Underline (Ctrl+U)" active={format.underline} disabled={disabled} onClick={() => api?.toggleUnderline()} />
        <FormatToggleButton icon="format_align_left" title="Align left" active={format.align === "left"} disabled={disabled} onClick={() => api?.setAlign("left")} />
        <FormatToggleButton icon="format_align_center" title="Centre" active={format.align === "center"} disabled={disabled} onClick={() => api?.setAlign("center")} />
        <FormatToggleButton icon="format_align_right" title="Align right" active={format.align === "right"} disabled={disabled} onClick={() => api?.setAlign("right")} />
        <FormatToggleButton icon="add" title="Increase decimal places" active={false} disabled={disabled} onClick={() => api?.adjustDecimals(1)} />
        <FormatToggleButton icon="remove" title="Decrease decimal places" active={false} disabled={disabled} onClick={() => api?.adjustDecimals(-1)} />
      </div>
    </div>
  );
}

function Icon({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, lineHeight: 1, userSelect: "none", flexShrink: 0 }}
    >
      {name}
    </span>
  );
}

function RibbonButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick?: () => void;
}) {
  const iconName = BUTTON_ICONS[label];
  return (
    <button
      disabled={disabled}
      title={label}
      onClick={onClick}
      style={{
        minWidth: 44,
        height: 50,
        padding: "4px 6px 3px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        overflow: "hidden",
        border: `1px solid ${theme.border.divider}`,
        background: theme.bg.input,
        color: disabled ? theme.text.disabled : theme.text.primary,
        fontSize: 9,
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      {iconName ? <Icon name={iconName} size={32} /> : null}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1 }}>
        {label}
      </span>
    </button>
  );
}

function SettingsDropdown() {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openTemplateManager = useAppStore((s) => s.openTemplateManager);

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
      setMenuPos({ top: rect.bottom + 2, left: rect.left });
    }
    setOpen((v) => !v);
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <RibbonButton label="Settings" disabled={false} onClick={handleToggle} />
      {open && menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: menuPos.top,
              left: menuPos.left,
              zIndex: 1300,
              minWidth: 160,
              background: theme.bg.pane,
              border: `1px solid ${theme.border.divider}`,
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
            }}
          >
            <button
              onClick={() => {
                setOpen(false);
                openTemplateManager();
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
                color: theme.text.primary,
                textAlign: "left",
                cursor: "pointer",
                fontSize: 12,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = theme.bg.input)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>dashboard_customize</span>
              Template Manager
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function WorkbookRibbon() {
  const workbooks = useAppStore((s) => s.workbooks);
  const createWorkbookRevision = useAppStore((s) => s.createWorkbookRevision);
  const createWorkbookRevisionFromTemplate = useAppStore((s) => s.createWorkbookRevisionFromTemplate);
  const [newFromTemplateOpen, setNewFromTemplateOpen] = useState(false);

  function handleNewRevision() {
    if (workbooks.length > 0) {
      const wb = workbooks[0];
      const nextNum = wb.revisions.length + 1;
      createWorkbookRevision(wb.id, `Revision ${nextNum}`);
    }
  }

  const hasWorkbook = workbooks.length > 0;
  const nextRevisionName = hasWorkbook ? `Revision ${workbooks[0].revisions.length + 1}` : "Revision 1";

  const groups = [
    { label: "Workbook", tools: ["New Revision", "New from Template", "Delete"] },
    { label: "Rows", tools: ["Add Row", "Insert Above", "Insert Below"] },
    { label: "View", tools: ["Expand All", "Collapse All"] },
    { label: "Format", tools: [] as string[] },
    { label: "Output", tools: ["Export", "Print"] },
    { label: "Settings", tools: ["Settings"] },
  ];

  const handlers: Record<string, (() => void) | undefined> = {
    "New Revision": hasWorkbook ? handleNewRevision : undefined,
    "New from Template": hasWorkbook ? () => setNewFromTemplateOpen(true) : undefined,
  };

  const enabled: Record<string, boolean> = {
    "New Revision": hasWorkbook,
    "New from Template": hasWorkbook,
  };

  return (
    <>
      {newFromTemplateOpen && (
        <NewFromTemplateDialog
          defaultName={nextRevisionName}
          onCancel={() => setNewFromTemplateOpen(false)}
          onConfirm={(templateId, name) => {
            setNewFromTemplateOpen(false);
            if (workbooks.length > 0) void createWorkbookRevisionFromTemplate(workbooks[0].id, name, templateId);
          }}
        />
      )}
      {groups.map((group) => (
        <div
          key={group.label}
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 72,
            padding: "4px 8px 0",
            borderRight: `1px solid ${theme.border.divider}`,
          }}
        >
          {group.label === "Format" ? (
            <FormatToolbar />
          ) : (
            <div style={{ display: "flex", gap: 5, alignItems: "center", overflow: "hidden" }}>
              {group.tools.map((tool) =>
                tool === "Settings" ? (
                  <SettingsDropdown key={tool} />
                ) : (
                  <RibbonButton
                    key={tool}
                    label={tool}
                    disabled={!enabled[tool]}
                    onClick={handlers[tool]}
                  />
                )
              )}
            </div>
          )}
          <div
            style={{
              marginTop: "auto",
              paddingBottom: 3,
              fontSize: 10,
              lineHeight: "12px",
              color: theme.text.secondary,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {group.label}
          </div>
        </div>
      ))}
    </>
  );
}
