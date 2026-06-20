import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { theme } from "../theme";
import { useAppStore } from "../store/appStore";
import { ProjectInfoDialog } from "./ProjectInfoDialog";
import { ErrorDialog } from "./ErrorDialog";
import { RateConstantsDialog } from "./RateConstantsDialog";
import { AboutDialog } from "./AboutDialog";
import { ExportExcelDialog } from "./ExportExcelDialog";
import type { FlattenExportLevels } from "../store/appStore";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="material-symbols-outlined" style={{ fontSize: size, lineHeight: 1, userSelect: "none", flexShrink: 0 }}>
      {name}
    </span>
  );
}

interface MenuItem {
  label: string;
  icon?: string;
  enabled: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
  divider?: boolean;
}

function MenuRow({ item, onDone }: { item: MenuItem; onDone: () => void }) {
  const [subOpen, setSubOpen] = useState(false);

  if (item.divider) {
    return <div style={{ borderTop: `1px solid ${theme.border.subtle}`, margin: "4px 0" }} />;
  }

  const hasSubmenu = !!item.submenu;

  return (
    <div
      onMouseEnter={() => {
        if (hasSubmenu) setSubOpen(true);
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

export function FileMenu() {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [showRateLibrary, setShowRateLibrary] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showExportExcel, setShowExportExcel] = useState(false);
  const [status, setStatus] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeProject = useAppStore((state) => state.activeProject);
  const closeProject = useAppStore((state) => state.closeProject);
  const exportProject = useAppStore((state) => state.exportProject);
  const exportPackage = useAppStore((state) => state.exportPackage);
  const gridApi = useAppStore((state) => state.workbookGridApi);
  const openTemplateManager = useAppStore((state) => state.openTemplateManager);
  const openNamedCellsManager = useAppStore((state) => state.openNamedCellsManager);
  const setWorkbookConfirmAction = useAppStore((state) => state.setWorkbookConfirmAction);
  const lightMode = useAppStore((state) => state.lightMode);
  const setLightMode = useAppStore((state) => state.setLightMode);

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

  async function handleExportProject() {
    if (!activeProject) return;
    const dest = await save({
      defaultPath: activeProject.name + ".tcop",
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
    });
    if (!dest || typeof dest !== "string") return;
    try {
      await exportProject(dest);
      setStatus("Exported.");
      setTimeout(() => setStatus(""), 2500);
    } catch (err) {
      setErrorMessage(`Export failed: ${err}`);
    }
  }

  async function handleExportExcel(levels: FlattenExportLevels) {
    setShowExportExcel(false);
    try {
      await gridApi?.exportExcel(levels);
    } catch (err) {
      setErrorMessage(`Export failed: ${err}`);
    }
  }

  async function handleExportPackage() {
    if (!activeProject) return;
    const dest = await save({
      defaultPath: activeProject.name + ".tcopkg",
      filters: [{ name: "Take-it-Off Package", extensions: ["tcopkg"] }],
    });
    if (!dest || typeof dest !== "string") return;
    try {
      setStatus("Packaging…");
      await exportPackage(dest);
      setStatus("Package exported.");
      setTimeout(() => setStatus(""), 3000);
    } catch (err) {
      setStatus("");
      setErrorMessage(`Export package failed: ${err}`);
    }
  }

  const hasGrid = gridApi != null;

  const items: MenuItem[] = [
    { label: "Project Info", icon: "edit", enabled: !!activeProject, onClick: () => setShowProjectInfo(true) },
    { label: "Export Project...", icon: "save_as", enabled: !!activeProject, onClick: () => { void handleExportProject(); } },
    { label: "Export Package...", icon: "inventory_2", enabled: !!activeProject, onClick: () => { void handleExportPackage(); } },
    { divider: true, label: "", enabled: false },
    { label: "Export to Excel...", icon: "save_as", enabled: hasGrid, onClick: () => setShowExportExcel(true) },
    { label: "Print", icon: "print", enabled: hasGrid, onClick: () => gridApi?.print() },
    {
      label: "Settings",
      icon: "settings",
      enabled: true,
      submenu: [
        { label: "Template Manager", icon: "dashboard_customize", enabled: true, onClick: () => openTemplateManager() },
        { label: "Named Cells", icon: "sell", enabled: true, onClick: () => openNamedCellsManager() },
        { label: "Rate Library", icon: "price_change", enabled: !!activeProject, onClick: () => setShowRateLibrary(true) },
        { label: "Clean orphaned sheets", icon: "cleaning_services", enabled: true, onClick: () => setWorkbookConfirmAction("clean") },
        { label: "Clear workbook", icon: "delete_sweep", enabled: true, onClick: () => setWorkbookConfirmAction("clear") },
      ],
    },
    { divider: true, label: "", enabled: false },
    { label: lightMode ? "Dark Mode" : "Light Mode", icon: lightMode ? "dark_mode" : "light_mode", enabled: true, onClick: () => setLightMode(!lightMode) },
    { divider: true, label: "", enabled: false },
    { label: "About StudIQ", icon: "info", enabled: true, onClick: () => setShowAbout(true) },
    { divider: true, label: "", enabled: false },
    { label: "Close Project", enabled: !!activeProject, onClick: () => { void closeProject(); } },
  ];

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
        File
      </button>
      {status ? (
        <div style={{ display: "flex", alignItems: "center", paddingLeft: 6, fontSize: 11, color: theme.text.secondary }}>
          {status}
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
      {showProjectInfo && activeProject ? (
        <ProjectInfoDialog
          initial={{ name: activeProject.name, client: activeProject.client, contractNumber: activeProject.contract_number, status: activeProject.status }}
          onCancel={() => setShowProjectInfo(false)}
          onConfirm={() => setShowProjectInfo(false)}
        />
      ) : null}
      {errorMessage ? (
        <ErrorDialog title="Error" body={errorMessage} onDismiss={() => setErrorMessage(null)} />
      ) : null}
      {showRateLibrary && <RateConstantsDialog onClose={() => setShowRateLibrary(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showExportExcel ? (
        <ExportExcelDialog onCancel={() => setShowExportExcel(false)} onConfirm={(levels) => { void handleExportExcel(levels); }} />
      ) : null}
    </div>
  );
}
