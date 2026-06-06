import { useState } from "react";
import { theme } from "../theme";

interface WorkbookNode {
  id: string;
  kind: "estimate" | "revision" | "workbook";
  label: string;
  children?: WorkbookNode[];
}

const DUMMY_TREE: WorkbookNode[] = [
  {
    id: "estimate-1",
    kind: "estimate",
    label: "12 Magnolia Lane",
    children: [
      {
        id: "rev-1",
        kind: "revision",
        label: "Revision 1",
        children: [
          { id: "wb-1", kind: "workbook", label: "Trade Estimate" },
        ],
      },
    ],
  },
];

const KIND_ICONS: Record<WorkbookNode["kind"], string> = {
  estimate: "folder_open",
  revision: "history",
  workbook: "table_view",
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

function WorkbookTreeRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: WorkbookNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isSelected = node.id === selectedId;

  return (
    <>
      <div
        onClick={() => onSelect(node.id)}
        style={{
          display: "flex",
          alignItems: "center",
          height: theme.rowHeight,
          paddingLeft: depth * theme.treeIndent + 4,
          paddingRight: 4,
          gap: 4,
          cursor: "pointer",
          background: isSelected ? theme.bg.active : "transparent",
          color: isSelected ? theme.text.primary : theme.text.primary,
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        {/* expand/collapse arrow */}
        <span
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setExpanded((v) => !v); }}
          style={{
            width: 14,
            fontSize: 12,
            lineHeight: 1,
            color: hasChildren ? theme.text.secondary : "transparent",
            cursor: hasChildren ? "pointer" : "default",
            flexShrink: 0,
            textAlign: "center",
          }}
        >
          {hasChildren ? (expanded ? "▾" : "▸") : ""}
        </span>

        <Icon name={KIND_ICONS[node.kind]} size={14} />

        <span
          style={{
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {node.label}
        </span>
      </div>

      {expanded && hasChildren && node.children?.map((child) => (
        <WorkbookTreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export function WorkbookSidebarPane() {
  const [selectedId, setSelectedId] = useState<string | null>("wb-1");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: theme.bg.pane,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          height: 28,
          borderBottom: `1px solid ${theme.border.divider}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.text.secondary, letterSpacing: "0.04em" }}>
          WORKBOOKS
        </span>
        <button
          disabled
          title="New Revision (coming soon)"
          style={{
            background: "none",
            border: "none",
            color: theme.text.disabled,
            cursor: "not-allowed",
            padding: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="add" size={16} />
        </button>
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {DUMMY_TREE.map((node) => (
          <WorkbookTreeRow
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ))}
      </div>
    </div>
  );
}
