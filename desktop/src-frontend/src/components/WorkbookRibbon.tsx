import { theme } from "../theme";

const BUTTON_ICONS: Record<string, string> = {
  "New Revision": "add_circle",
  Delete: "delete",
  "Expand All": "unfold_more",
  "Collapse All": "unfold_less",
  "Add Row": "playlist_add",
  "Insert Above": "vertical_align_top",
  "Insert Below": "vertical_align_bottom",
  Format: "format_paint",
  Export: "save_as",
  Print: "print",
};

const groups = [
  { label: "Workbook", tools: ["New Revision", "Delete"] },
  { label: "Rows", tools: ["Add Row", "Insert Above", "Insert Below"] },
  { label: "View", tools: ["Expand All", "Collapse All"] },
  { label: "Format", tools: ["Format"] },
  { label: "Output", tools: ["Export", "Print"] },
];

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

export function WorkbookRibbon() {
  return (
    <>
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
          <div style={{ display: "flex", gap: 5, alignItems: "center", overflow: "hidden" }}>
            {group.tools.map((tool) => {
              const iconName = BUTTON_ICONS[tool];
              return (
                <button
                  key={tool}
                  disabled
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
                    border: `1px solid ${theme.border.divider}`,
                    background: theme.bg.input,
                    color: theme.text.disabled,
                    fontSize: 9,
                    cursor: "not-allowed",
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
