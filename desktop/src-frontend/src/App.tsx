import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LeftColumn } from "./components/LeftColumn";
import { Ribbon } from "./components/Ribbon";
import { StartScreen } from "./components/StartScreen";
import { Viewer } from "./components/Viewer";
import { ProjectMeta, useAppStore } from "./store/appStore";
import { theme } from "./theme";

export default function App() {
  const activeProject = useAppStore((state) => state.activeProject);
  const [leftWidth, setLeftWidth] = useState(theme.leftPaneWidth);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    invoke<ProjectMeta | null>("get_active_project")
      .then((project) => {
        if (project) useAppStore.getState().setActiveProject(project);
      })
      .catch((error) => {
        console.error("Failed to load active project", error);
      });
  }, []);

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    setLeftWidth(Math.max(220, Math.min(480, event.clientX)));
  }

  function stopDrag() {
    setDragging(false);
  }

  if (!activeProject) {
    return <StartScreen />;
  }

  return (
    <div
      onPointerMove={handlePointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      style={{
        display: "grid",
        gridTemplateRows: `${theme.ribbonHeight}px 1fr`,
        gridTemplateColumns: `${leftWidth}px 1fr`,
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        background: theme.bg.shell,
      }}
    >
      <Ribbon />
      <div style={{ position: "relative", minHeight: 0, overflow: "hidden" }}>
        <LeftColumn />
        <div
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 4,
            cursor: "col-resize",
            background: dragging ? theme.accent : "transparent",
          }}
        />
      </div>
      <Viewer />
    </div>
  );
}
