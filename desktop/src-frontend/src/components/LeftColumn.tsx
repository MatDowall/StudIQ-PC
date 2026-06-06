import { useEffect, useRef, useState } from "react";
import { DimensionGroupPane } from "./DimensionGroupPane";
import { DrawingRegisterPane } from "./DrawingRegisterPane";
import { WorkbookSidebarPane } from "./WorkbookSidebarPane";
import { theme } from "../theme";
import { useAppStore } from "../store/appStore";

export function LeftColumn() {
  const activeTab = useAppStore((state) => state.activeTab);
  const [topHeight, setTopHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || topHeight !== null) return;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0) {
      setTopHeight(Math.max(120, Math.min(rect.height - 120, rect.height * 0.52)));
    }
  }, [topHeight]);

  useEffect(() => {
    if (!dragging) return;

    function handlePointerMove(event: PointerEvent) {
      const element = containerRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const next = event.clientY - rect.top;
      setTopHeight(Math.max(120, Math.min(rect.height - 120, next)));
    }

    function stopDrag() {
      setDragging(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, [dragging]);

  return (
    <aside
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateRows: `${Math.round(topHeight ?? 260)}px 4px minmax(120px, 1fr)`,
        height: "100%",
        minWidth: 220,
        maxWidth: 480,
        minHeight: 0,
        overflow: "hidden",
        background: theme.bg.pane,
        borderRight: `1px solid ${theme.border.divider}`,
        color: theme.text.primary,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      {activeTab === "workbook" ? <WorkbookSidebarPane /> : <DrawingRegisterPane />}
      <div
        onPointerDown={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        style={{ cursor: "row-resize", background: dragging ? theme.accent : theme.border.divider }}
      />
      <DimensionGroupPane />
    </aside>
  );
}
