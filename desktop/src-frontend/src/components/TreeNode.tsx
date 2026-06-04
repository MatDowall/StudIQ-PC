import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { drawingPageNodeId, useAppStore, TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";

interface TreeNodeProps {
  node: TreeNodeDto;
  depth: number;
  activeNodeId: number | null;
  onNodeClick: (node: TreeNodeDto) => void;
  onContextMenu: (e: MouseEvent, node: TreeNodeDto) => void;
}

function NodeIcon({ node }: { node: TreeNodeDto }) {
  if (node.node_type === "folder") {
    return (
      <span
        style={{
          position: "relative",
          width: 14,
          height: 11,
          marginRight: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: "absolute",
            left: 1,
            top: 1,
            width: 6,
            height: 3,
            border: `1px solid ${theme.text.secondary}`,
            borderBottom: "none",
          }}
        />
        <span
          style={{
            position: "absolute",
            left: 0,
            top: 4,
            width: 13,
            height: 7,
            border: `1px solid ${theme.text.secondary}`,
          }}
        />
      </span>
    );
  }

  if (node.node_type === "dimension_group") {
    return (
      <span
        style={{
          width: 22,
          marginRight: 4,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          style={{
            width: 10,
            height: 10,
            background: node.colour ?? theme.accent,
            border: `1px solid ${theme.border.divider}`,
          }}
        />
      </span>
    );
  }

  return (
    <span
      style={{
        width: 22,
        marginRight: 4,
        flexShrink: 0,
        color: theme.text.secondary,
        fontSize: 10,
      }}
    >
      {node.node_type === "drawing" ? "PDF" : "Pg"}
    </span>
  );
}

export function TreeNode({ node, depth, activeNodeId, onNodeClick, onContextMenu }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const childCache = useAppStore((state) => state.childCache);
  const loadChildren = useAppStore((state) => state.loadChildren);
  const treeRevision = useAppStore((state) => state.treeRevision);
  const isFolder = node.node_type === "folder";
  const isDrawing = node.node_type === "drawing";
  const pageCount = node.page_count ?? 0;
  const cachedChildren = childCache[node.id] ?? [];
  const pageChildren: TreeNodeDto[] = isDrawing
    ? Array.from({ length: pageCount }, (_, pageIndex) => ({
        id: drawingPageNodeId(node.id, pageIndex),
        tree: node.tree,
        node_type: "drawing_page",
        parent_id: node.id,
        name: `Page ${pageIndex + 1}`,
        sort_order: pageIndex,
        has_children: false,
        file_path: node.file_path,
        page_count: null,
        uom: node.uom,
        colour: node.colour,
        framing_size: null,
      }))
    : [];
  const children = isDrawing ? pageChildren : cachedChildren;
  const canExpand = (isFolder && (node.has_children || cachedChildren.length > 0)) || (isDrawing && pageCount > 0);
  const isActive = activeNodeId === node.id;
  const [loadedRevision, setLoadedRevision] = useState(-1);

  useEffect(() => {
    if (!canExpand && expanded) {
      setExpanded(false);
    }
  }, [canExpand, expanded]);

  useEffect(() => {
    if (!expanded || !isFolder || (!node.has_children && cachedChildren.length === 0) || loading) return;
    if (childCache[node.id] && loadedRevision === treeRevision) return;

    setLoading(true);
    loadChildren(node.id, true).finally(() => {
      setLoadedRevision(useAppStore.getState().treeRevision);
      setLoading(false);
    });
  }, [cachedChildren.length, childCache, expanded, isFolder, loadChildren, loadedRevision, loading, node.has_children, node.id, treeRevision]);

  async function toggleExpanded(event: MouseEvent) {
    event.stopPropagation();
    if (!canExpand) return;
    if (isDrawing) {
      setExpanded((current) => !current);
      return;
    }
    if (!expanded && !childCache[node.id]) {
      setLoading(true);
      try {
        await loadChildren(node.id);
        setLoadedRevision(useAppStore.getState().treeRevision);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((current) => !current);
  }

  return (
    <>
      <div
        onClick={() => onNodeClick(node)}
        onContextMenu={(event) => onContextMenu(event, node)}
        style={{
          display: "flex",
          alignItems: "center",
          height: theme.rowHeight,
          paddingLeft: depth * theme.treeIndent,
          paddingRight: 6,
          background: isActive ? theme.bg.active : "transparent",
          color: isActive ? "#FFFFFF" : theme.text.primary,
          cursor: "default",
          fontSize: 12,
          userSelect: "none",
          whiteSpace: "nowrap",
        }}
      >
        <button
          onClick={toggleExpanded}
          disabled={!canExpand || loading}
          style={{
            width: 18,
            height: theme.rowHeight,
            padding: 0,
            border: "none",
            background: "transparent",
            color: canExpand ? theme.text.secondary : "transparent",
            cursor: canExpand ? "pointer" : "default",
            fontSize: 10,
          }}
        >
          {loading ? "..." : expanded ? "v" : ">"}
        </button>
        <NodeIcon node={node} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
      </div>
      {expanded
        ? children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeNodeId={activeNodeId}
              onNodeClick={onNodeClick}
              onContextMenu={onContextMenu}
            />
          ))
        : null}
    </>
  );
}
