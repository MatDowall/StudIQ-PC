import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Footer } from "./components/Footer";
import { LeftColumn } from "./components/LeftColumn";
import { Ribbon } from "./components/Ribbon";
import { StartScreen } from "./components/StartScreen";
import { Viewer } from "./components/Viewer";
import { WorkbookView } from "./components/WorkbookView";
import { ProjectMeta, useAppStore } from "./store/appStore";
import { TitleBar } from "./components/TitleBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { startBridgeListener } from "./lib/bridge";
import { theme } from "./theme";

const LEFT_WIDTH_KEY = "studiq.leftPaneWidth";
const clampLeftWidth = (width: number) => Math.max(theme.leftPaneMinWidth, Math.min(theme.leftPaneMaxWidth, width));

export default function App() {
  const activeProject = useAppStore((state) => state.activeProject);
  const activeTab = useAppStore((state) => state.activeTab);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  // The sidebar opens at a width that fits its columns; a width the estimator drags it to is
  // remembered across restarts.
  const [leftWidth, setLeftWidth] = useState(() => {
    try {
      const stored = Number.parseInt(localStorage.getItem(LEFT_WIDTH_KEY) ?? "", 10);
      if (Number.isFinite(stored)) return clampLeftWidth(stored);
    } catch {
      // storage unavailable — fall through to the default
    }
    return theme.leftPaneWidth;
  });
  const [dragging, setDragging] = useState(false);
  // Lazily mount WorkbookView on first visit; keep it mounted (display:none) thereafter
  // so workbook state survives tab switches without triggering expensive re-mounts.
  const workbookEverVisited = useRef(false);
  if (activeTab === "workbook") workbookEverVisited.current = true;

  useEffect(() => {
    // Mount the Excel-bridge listener once: it answers compute requests proxied
    // from the Rust bridge server (desktop/src/bridge.rs) for the Excel add-in.
    startBridgeListener();

    invoke<ProjectMeta | null>("get_active_project")
      .then((project) => {
        if (project) useAppStore.getState().setActiveProject(project);
      })
      .catch((error) => {
        console.error("Failed to load active project", error);
      });

    const openShellFile = (filePath: string | null) => {
      if (!filePath) return;
      const lower = filePath.toLowerCase();
      if (lower.endsWith(".tcop")) {
        void useAppStore.getState().openProject(filePath);
      } else if (lower.endsWith(".tcopkg")) {
        useAppStore.getState().setPendingImportPath(filePath);
      }
    };

    invoke<string | null>("get_startup_file")
      .then(openShellFile)
      .catch(() => {});

    // A second launch (e.g. double-clicking a .tcop while StudIQ is already open) is
    // folded into this instance by the single-instance plugin, which forwards the file.
    const unlisten = listen<string>("open-file-from-shell", (event) => openShellFile(event.payload));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setLeftWidth(clampLeftWidth(event.clientX));
  }

  function stopDrag() {
    if (dragging) {
      try {
        localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth));
      } catch {
        // storage unavailable — the width just won't be remembered
      }
    }
    setDragging(false);
  }

  if (!activeProject) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden" }}>
        <TitleBar />
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <StartScreen />
        </div>
        <UpdateBanner />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", overflow: "hidden" }}>
      <TitleBar />
    <div
      onPointerMove={handlePointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      style={{
        display: "grid",
        gridTemplateRows: `${theme.tabHeight}px ${theme.ribbonHeight}px 1fr ${theme.footerHeight}px`,
        gridTemplateColumns: `${leftWidth}px 1fr`,
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
        background: theme.bg.shell,
      }}
    >
      {/* Tab bar — spans full width */}
      <div
        style={{
          gridColumn: "1 / 3",
          display: "flex",
          alignItems: "flex-end",
          background: theme.bg.tabBar,
          borderBottom: `1px solid ${theme.border.divider}`,
          paddingLeft: 8,
          gap: 0,
          fontFamily: "Segoe UI, sans-serif",
        }}
      >
        {(["dimensions", "workbook"] as const).map((tab) => {
          const isActive = activeTab === tab;
          const label = tab === "dimensions" ? "Dimensions" : "Workbook";
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                height: theme.tabHeight - 1,
                padding: "0 16px",
                fontSize: 12,
                fontFamily: "Segoe UI, sans-serif",
                border: "none",
                borderRight: `1px solid ${theme.border.divider}`,
                background: isActive ? theme.bg.ribbon : "transparent",
                color: isActive ? theme.text.primary : theme.text.secondary,
                cursor: isActive ? "default" : "pointer",
                fontWeight: isActive ? 600 : 400,
                borderTop: isActive ? `2px solid ${theme.accent}` : "2px solid transparent",
                transition: "color 0.1s",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Ribbon — spans full width, content switches per tab */}
      <Ribbon />

      {/* Left column — top pane switches per tab; dim group pane always at bottom */}
      <div style={{ display: "flex", minHeight: 0, overflow: "hidden" }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <LeftColumn />
        </div>
        {/* Splitter — a visible bar framing the sidebar off from the canvas; drag to resize. */}
        <div
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          style={{
            flex: "0 0 auto",
            width: theme.splitterWidth,
            boxSizing: "border-box",
            cursor: "col-resize",
            background: dragging ? theme.accent : theme.bg.shell,
            borderRight: `1px solid ${theme.border.divider}`,
          }}
        />
      </div>

      {/* Main content area — Viewer always mounted; WorkbookView lazily mounted then hidden */}
      <div style={{ position: "relative", minHeight: 0, overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: activeTab === "dimensions" ? "block" : "none",
          }}
        >
          <Viewer />
        </div>
        {workbookEverVisited.current && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: activeTab === "workbook" ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            <WorkbookView />
          </div>
        )}
      </div>

      {/* Footer — spans full width: page navigation (centred) and page scale (right) */}
      <Footer />
    </div>
    <UpdateBanner />
    </div>
  );
}
