import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { theme } from "../theme";
import { FileMenu } from "./FileMenu";
import { ViewMenu } from "./ViewMenu";
import { WorkbookMenu } from "./WorkbookMenu";
import { HelpMenu } from "./HelpMenu";

const appWindow = getCurrentWindow();

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      style={{
        display: "flex",
        alignItems: "center",
        height: 32,
        background: theme.bg.shell,
        color: theme.text.secondary,
        fontFamily: "Segoe UI, sans-serif",
        fontSize: 12,
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <div data-tauri-drag-region style={{ flex: 1, height: "100%", display: "flex", alignItems: "center", paddingLeft: 8, gap: 6 }}>
        <span style={{ color: theme.accent, fontWeight: 600 }}>IQ</span>
        <span>StudIQ</span>
        <FileMenu />
        <ViewMenu />
        <WorkbookMenu />
        <HelpMenu />
      </div>
      <div style={{ display: "flex", height: "100%" }}>
        <TitleBarButton title="Minimize" onClick={() => void appWindow.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0" y="4.5" width="10" height="1" fill="currentColor" /></svg>
        </TitleBarButton>
        <TitleBarButton title={maximized ? "Restore" : "Maximize"} onClick={() => void appWindow.toggleMaximize()}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="0.5" y="2.5" width="7" height="7" fill={theme.bg.shell} stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </TitleBarButton>
        <TitleBarButton title="Close" hoverColor={theme.danger} onClick={() => void appWindow.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </TitleBarButton>
      </div>
    </div>
  );
}

function TitleBarButton({
  title,
  onClick,
  children,
  hoverColor,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  hoverColor?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        width: 46,
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: theme.text.secondary,
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = hoverColor ?? theme.bg.hover;
        e.currentTarget.style.color = hoverColor ? "#FFFFFF" : theme.text.primary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = theme.text.secondary;
      }}
    >
      {children}
    </button>
  );
}
