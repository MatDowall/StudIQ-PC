import { theme } from "../theme";
import { useAppStore } from "../store/appStore";

const groups = [
  { label: "Dimension Group", tools: ["Add", "Properties", "Copy", "Import", "Export"] },
  { label: "Type", tools: ["Point", "Line"] },
  { label: "Drawing", tools: ["Plan View", "View in 3D"] },
  { label: "Snap", tools: ["Geometry", "Angle", "Rebar"] },
  { label: "Show", tools: ["Labels", "Markups", "Properties on Add"] },
];

// Tools in the "Dimension Group" group are wired to real actions; everything else in the
// ribbon is still static CostX-style decoration.
const DIMENSION_GROUP_TOOLS: Record<string, "add" | "properties" | "copy"> = {
  Add: "add",
  Properties: "properties",
  Copy: "copy",
};

export function Ribbon() {
  const activeProject = useAppStore((state) => state.activeProject);
  const closeProject = useAppStore((state) => state.closeProject);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const requestDgPaneCommand = useAppStore((state) => state.requestDgPaneCommand);
  const drawingType = useAppStore((state) => state.drawingType);
  const setDrawingType = useAppStore((state) => state.setDrawingType);
  const view3d = useAppStore((state) => state.view3d);
  const setView3d = useAppStore((state) => state.setView3d);

  return (
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
      {groups.map((group, groupIndex) => (
        <div
          key={group.label}
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            minWidth: groupIndex === 0 ? 138 : 92,
            padding: "4px 8px 3px",
            borderRight: `1px solid ${theme.border.divider}`,
          }}
        >
          <div style={{ display: "flex", gap: 5, alignItems: "center", overflow: "hidden" }}>
            {group.tools.slice(0, 3).map((tool, toolIndex) => {
              const dgCommand = groupIndex === 0 ? DIMENSION_GROUP_TOOLS[tool] : undefined;
              const isTypeToggle = group.label === "Type" && (tool === "Point" || tool === "Line");
              const isViewToggle = group.label === "Drawing" && (tool === "Plan View" || tool === "View in 3D");

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
              } else {
                // Static decorative tools.
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
                    : undefined;

              return (
                <button
                  key={`${group.label}-${tool}`}
                  disabled={!enabled && !isTypeToggle}
                  onClick={handleClick}
                  style={{
                    height: 20,
                    maxWidth: 70,
                    padding: "0 6px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    border: `1px solid ${active ? theme.accent : theme.border.divider}`,
                    background: active ? theme.bg.active : theme.bg.input,
                    color: active ? theme.text.primary : theme.text.disabled,
                    fontSize: 10,
                    cursor,
                  }}
                >
                  {tool}
                </button>
              );
            })}
          </div>
          <div
            style={{
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
      {activeProject ? (
        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 280,
            maxWidth: 520,
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
          <button
            type="button"
            onClick={() => {
              void closeProject();
            }}
            style={{
              height: 24,
              padding: "0 10px",
              marginLeft: 4,
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
  );
}
