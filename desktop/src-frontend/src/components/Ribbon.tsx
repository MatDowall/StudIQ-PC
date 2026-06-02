import { theme } from "../theme";
import { useAppStore } from "../store/appStore";

const groups = [
  { label: "Dimension Group", tools: ["Add", "Properties", "Copy", "Import", "Export"] },
  { label: "BIM", tools: ["Check BIM Objects", "Show All Objects"] },
  { label: "Dimension", tools: ["Add", "Copy", "Select In Area", "Edit Controls"] },
  { label: "Type", tools: ["Line", "Point", "Object"] },
  { label: "Zones", tools: ["Edit Zones"] },
  { label: "Snap", tools: ["Geometry", "Angle", "Rebar"] },
  { label: "Mode", tools: ["Measured", "Legend"] },
  { label: "Show", tools: ["Labels", "Markups", "Properties on Add"] },
];

export function Ribbon() {
  const activeProject = useAppStore((state) => state.activeProject);
  const closeProject = useAppStore((state) => state.closeProject);

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
              const active = tool === "Add" || tool === "Line" || tool === "Measured";
              return (
                <button
                  key={`${group.label}-${tool}`}
                  disabled={!active && toolIndex > 0}
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
                    cursor: active ? "default" : "not-allowed",
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
