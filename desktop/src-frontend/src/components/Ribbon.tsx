import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { theme } from "../theme";
import { useAppStore } from "../store/appStore";
import { ProjectInfoDialog } from "./ProjectInfoDialog";

// Material Symbol icon name for each ribbon button label.
const BUTTON_ICONS: Record<string, string> = {
  Add: "add",
  Properties: "tune",
  Copy: "copy_all",
  Point: "polyline",
  Line: "show_chart",
  "Plan View": "architecture",
  "View in 3D": "view_in_ar",
  Dim: "contrast",
  Geometry: "my_location",
};

const groups = [
  { label: "Dimension Group", tools: ["Add", "Properties", "Copy", "Import", "Export"] },
  { label: "Type", tools: ["Point", "Line"] },
  { label: "Drawing", tools: ["Plan View", "View in 3D", "Dim"] },
  { label: "Snap", tools: ["Geometry"] },
];

const DIMENSION_GROUP_TOOLS: Record<string, "add" | "properties" | "copy"> = {
  Add: "add",
  Properties: "properties",
  Copy: "copy",
};

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, lineHeight: 1, userSelect: "none", flexShrink: 0 }}
    >
      {name}
    </span>
  );
}

export function Ribbon() {
  const activeProject = useAppStore((state) => state.activeProject);
  const closeProject = useAppStore((state) => state.closeProject);
  const exportProject = useAppStore((state) => state.exportProject);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const requestDgPaneCommand = useAppStore((state) => state.requestDgPaneCommand);
  const drawingType = useAppStore((state) => state.drawingType);
  const setDrawingType = useAppStore((state) => state.setDrawingType);
  const view3d = useAppStore((state) => state.view3d);
  const setView3d = useAppStore((state) => state.setView3d);
  const drawingDimmer = useAppStore((state) => state.drawingDimmer);
  const setDrawingDimmer = useAppStore((state) => state.setDrawingDimmer);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const setSnapEnabled = useAppStore((state) => state.setSnapEnabled);

  const [showProjectInfo, setShowProjectInfo] = useState(false);
  const [exportStatus, setExportStatus] = useState("");

  const dimActive = drawingDimmer < 1;

  async function handleExport() {
    if (!activeProject) return;
    const dest = await save({
      defaultPath: activeProject.name + ".tcop",
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
    });
    if (!dest || typeof dest !== "string") return;
    try {
      await exportProject(dest);
      setExportStatus("Exported.");
      setTimeout(() => setExportStatus(""), 2500);
    } catch (err) {
      setExportStatus(`Export failed: ${err}`);
    }
  }

  return (
    <>
      <div
        style={{
          gridColumn: "1 / 3",
          display: "flex",
          alignItems: "stretch",
          height: theme.ribbonHeight,
          overflow: "hidden",
          background: theme.bg.ribbon,
          borderBottom: `1px solid ${theme.border.subtle}`,
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
        }}
      >
        {groups.map((group, groupIndex) => {
          const isDrawingGroup = group.label === "Drawing";
          return (
            <div
              key={group.label}
              style={{
                display: "flex",
                flexDirection: "column",
                minWidth: groupIndex === 0 ? 138 : isDrawingGroup ? 148 : 72,
                padding: "4px 8px 0",
                borderRight: `1px solid ${theme.border.divider}`,
              }}
            >
              <div style={{ display: "flex", gap: 5, alignItems: "center", overflow: "hidden" }}>
                {group.tools.slice(0, 3).map((tool, toolIndex) => {
                  const dgCommand = groupIndex === 0 ? DIMENSION_GROUP_TOOLS[tool] : undefined;
                  const isTypeToggle = group.label === "Type" && (tool === "Point" || tool === "Line");
                  const isViewToggle = group.label === "Drawing" && (tool === "Plan View" || tool === "View in 3D");
                  const isDimToggle = group.label === "Drawing" && tool === "Dim";
                  const isSnapToggle = group.label === "Snap" && tool === "Geometry";

                  let enabled: boolean;
                  let cursor: string;
                  let active: boolean;

                  if (dgCommand !== undefined) {
                    enabled = dgCommand === "add" || activeDimensionGroupId !== null;
                    active = enabled;
                    cursor = !enabled ? "not-allowed" : "pointer";
                  } else if (isTypeToggle) {
                    enabled = true;
                    active = (tool === "Point" && drawingType === "point") || (tool === "Line" && drawingType === "line");
                    cursor = "pointer";
                  } else if (isViewToggle) {
                    enabled = true;
                    active = (tool === "Plan View" && !view3d) || (tool === "View in 3D" && view3d);
                    cursor = "pointer";
                  } else if (isDimToggle) {
                    enabled = true;
                    active = dimActive;
                    cursor = "pointer";
                  } else if (isSnapToggle) {
                    enabled = true;
                    active = snapEnabled;
                    cursor = "pointer";
                  } else {
                    enabled = toolIndex === 0;
                    active = enabled;
                    cursor = "default";
                  }

                  const handleClick = dgCommand !== undefined && enabled
                    ? () => requestDgPaneCommand(dgCommand)
                    : isTypeToggle
                      ? () => setDrawingType(tool === "Line" ? "line" : "point")
                      : isViewToggle
                        ? () => setView3d(tool === "View in 3D")
                        : isDimToggle
                          ? () => setDrawingDimmer(dimActive ? 1 : 0.4)
                          : isSnapToggle
                            ? () => setSnapEnabled(!snapEnabled)
                            : undefined;

                  const iconName = BUTTON_ICONS[tool];

                  return (
                    <button
                      key={`${group.label}-${tool}`}
                      disabled={!enabled && !isTypeToggle}
                      onClick={handleClick}
                      title={tool}
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
                        border: `1px solid ${active ? theme.accent : theme.border.divider}`,
                        background: active ? theme.bg.active : theme.bg.input,
                        color: active ? theme.text.primary : theme.text.disabled,
                        fontSize: 9,
                        cursor,
                        flexShrink: 0,
                      }}
                    >
                      {iconName ? <Icon name={iconName} size={32} /> : null}
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1 }}>
                        {tool}
                      </span>
                    </button>
                  );
                })}
              </div>
              {isDrawingGroup && dimActive ? (
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: "auto", paddingBottom: 3 }}>
                  <input
                    type="range"
                    min={0.1}
                    max={0.95}
                    step={0.05}
                    value={drawingDimmer}
                    onChange={(e) => setDrawingDimmer(Number(e.target.value))}
                    style={{ flex: 1, height: 12, cursor: "pointer", accentColor: theme.accent }}
                  />
                  <span style={{ fontSize: 9, color: theme.text.secondary, flexShrink: 0 }}>
                    {Math.round(drawingDimmer * 100)}%
                  </span>
                </div>
              ) : (
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
              )}
            </div>
          );
        })}
        {activeProject ? (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 280,
              maxWidth: 600,
              padding: "0 12px",
              borderLeft: `1px solid ${theme.border.divider}`,
              color: theme.text.primary,
              fontSize: 12,
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.name}</span>
            <span style={{ color: theme.text.secondary }}>|</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.client}</span>
            <span style={{ color: theme.text.secondary }}>|</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{activeProject.contract_number}</span>
            {exportStatus ? (
              <span style={{ color: theme.text.secondary, fontSize: 11, flexShrink: 0 }}>{exportStatus}</span>
            ) : null}
            <button
              type="button"
              onClick={() => setShowProjectInfo(true)}
              title="Edit project info"
              style={{
                height: 24,
                padding: "0 8px",
                marginLeft: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <Icon name="edit" size={13} />
              Project Info
            </button>
            <button
              type="button"
              onClick={() => { void handleExport(); }}
              title="Export project file"
              style={{
                height: 24,
                padding: "0 8px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <Icon name="save_as" size={13} />
              Export
            </button>
            <button
              type="button"
              onClick={() => { void closeProject(); }}
              style={{
                height: 24,
                padding: "0 8px",
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              Close Project
            </button>
          </div>
        ) : null}
      </div>
      {showProjectInfo && activeProject ? (
        <ProjectInfoDialog
          initial={{ name: activeProject.name, client: activeProject.client, contractNumber: activeProject.contract_number, status: activeProject.status }}
          onCancel={() => setShowProjectInfo(false)}
          onConfirm={() => setShowProjectInfo(false)}
        />
      ) : null}
    </>
  );
}
