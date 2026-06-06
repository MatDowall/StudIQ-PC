import { theme } from "../theme";

const COL_HEADER: React.CSSProperties = {
  padding: "0 8px",
  fontSize: 12,
  fontWeight: 600,
  color: theme.text.secondary,
  borderBottom: `1px solid ${theme.border.divider}`,
  borderRight: `1px solid ${theme.border.divider}`,
  background: theme.bg.ribbon,
  height: 24,
  display: "flex",
  alignItems: "center",
  userSelect: "none",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

const CELL: React.CSSProperties = {
  padding: "0 8px",
  fontSize: 12,
  color: theme.text.primary,
  borderBottom: `1px solid ${theme.border.subtle}`,
  borderRight: `1px solid ${theme.border.subtle}`,
  height: 24,
  display: "flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  overflow: "hidden",
};

interface SpreadsheetRow {
  id: string;
  depth: number;
  kind: "folder" | "item";
  name: string;
  total: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

const DUMMY_ROWS: SpreadsheetRow[] = [
  { id: "r1", depth: 0, kind: "folder", name: "Trade Estimate", total: null, hasChildren: true, expanded: false },
];

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

export function WorkbookView() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        width: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: theme.bg.shell,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      {/* Toolbar strip */}
      <div
        style={{
          height: 32,
          borderBottom: `1px solid ${theme.border.divider}`,
          background: theme.bg.pane,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, color: theme.text.secondary }}>
          Trade Estimate — Revision 1
        </span>
      </div>

      {/* Spreadsheet grid */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Column headers */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "28px 1fr 140px",
            position: "sticky",
            top: 0,
            zIndex: 1,
          }}
        >
          {/* expand cell */}
          <div style={{ ...COL_HEADER, justifyContent: "center", padding: 0 }} />
          <div style={COL_HEADER}>Name</div>
          <div style={{ ...COL_HEADER, justifyContent: "flex-end" }}>Total</div>
        </div>

        {/* Rows */}
        {DUMMY_ROWS.map((row) => (
          <div
            key={row.id}
            style={{
              display: "grid",
              gridTemplateColumns: "28px 1fr 140px",
              background: theme.bg.pane,
            }}
          >
            {/* expand toggle */}
            <div
              style={{
                ...CELL,
                justifyContent: "center",
                padding: 0,
                cursor: row.hasChildren ? "pointer" : "default",
                color: theme.text.secondary,
              }}
            >
              {row.hasChildren ? (
                <Icon name={row.expanded ? "expand_more" : "chevron_right"} size={16} />
              ) : null}
            </div>

            {/* name */}
            <div style={{ ...CELL, paddingLeft: row.depth * 16 + 8, gap: 6 }}>
              <Icon name={row.kind === "folder" ? "table_view" : "table_rows"} size={14} />
              <span>{row.name}</span>
            </div>

            {/* total */}
            <div style={{ ...CELL, justifyContent: "flex-end", color: theme.text.secondary }}>
              {row.total ?? "—"}
            </div>
          </div>
        ))}

        {/* Placeholder */}
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: theme.text.disabled,
            fontSize: 13,
          }}
        >
          Workbook spreadsheet — coming in a future milestone
        </div>
      </div>
    </div>
  );
}
