import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { useAppStore, TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";
import { ColourDialog } from "./ColourDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { DimensionGroupDialog } from "./DimensionGroupDialog";
import { TextInputDialog } from "./TextInputDialog";

const tabs = ["Dimension Groups", "Dimensions", "Auto Count"];
const gridColumns = "22px minmax(150px, 1fr) 72px 48px 26px";

function findPath(nodes: TreeNodeDto[], targetId: number, childCache: Record<number, TreeNodeDto[]>, path: string[] = []): string[] | null {
  for (const node of nodes) {
    const nextPath = node.node_type === "folder" ? [...path, node.name] : path;
    if (node.id === targetId) return nextPath;
    const found = findPath(childCache[node.id] ?? [], targetId, childCache, nextPath);
    if (found) return found;
  }
  return null;
}

function summaryForNode(node: TreeNodeDto) {
  if (node.node_type !== "dimension_group") return { quantity: "", uom: "" };
  const uoms = ["m3", "m2", "m", "ea", "kg"];
  return {
    quantity: String((node.id * 17 + node.name.length * 3) % 240),
    uom: uoms[node.id % uoms.length],
  };
}

function DimensionNodeIcon({ node }: { node: TreeNodeDto }) {
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

  return (
    <span
      style={{
        width: 18,
        marginRight: 8,
        color: theme.text.secondary,
        fontSize: 13,
        lineHeight: 1,
      }}
    >
      ◈
    </span>
  );
}

function DimensionTreeRow({
  node,
  depth,
  activeNodeId,
  onNodeClick,
  onContextMenu,
}: {
  node: TreeNodeDto;
  depth: number;
  activeNodeId: number | null;
  onNodeClick: (node: TreeNodeDto) => void;
  onContextMenu: (event: MouseEvent, node: TreeNodeDto) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const childCache = useAppStore((state) => state.childCache);
  const loadChildren = useAppStore((state) => state.loadChildren);
  const treeRevision = useAppStore((state) => state.treeRevision);
  const isFolder = node.node_type === "folder";
  const children = childCache[node.id] ?? [];
  const canExpand = isFolder && (node.has_children || children.length > 0);
  const isActive = activeNodeId === node.id;
  const summary = summaryForNode(node);

  useEffect(() => {
    if (!canExpand && expanded) {
      setExpanded(false);
    }
  }, [canExpand, expanded]);

  useEffect(() => {
    if (!expanded || !isFolder || (!node.has_children && children.length === 0) || loading) return;
    if (childCache[node.id] && loadedRevision === treeRevision) return;

    setLoading(true);
    loadChildren(node.id, true).finally(() => {
      setLoadedRevision(useAppStore.getState().treeRevision);
      setLoading(false);
    });
  }, [childCache, children.length, expanded, isFolder, loadChildren, loadedRevision, loading, node.has_children, node.id, treeRevision]);

  async function toggleExpanded(event: MouseEvent) {
    event.stopPropagation();
    if (!canExpand) return;
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
          display: "grid",
          gridTemplateColumns: gridColumns,
          alignItems: "center",
          minWidth: 360,
          height: theme.rowHeight,
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
            width: 22,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minWidth: 0,
            paddingLeft: depth * theme.treeIndent,
            overflow: "hidden",
          }}
        >
          <DimensionNodeIcon node={node} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
        </div>
        <div style={{ paddingRight: 8, textAlign: "right", color: isActive ? "#FFFFFF" : theme.text.primary }}>{summary.quantity}</div>
        <div style={{ color: isActive ? "#FFFFFF" : theme.text.primary }}>{summary.uom}</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          {node.node_type === "dimension_group" ? (
            <span style={{ width: 16, height: 16, background: node.colour ?? theme.accent, border: `1px solid ${theme.border.divider}` }} />
          ) : null}
        </div>
      </div>
      {expanded
        ? children.map((child) => (
            <DimensionTreeRow
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

export function DimensionGroupPane() {
  const dimensionRoots = useAppStore((state) => state.dimensionRoots);
  const childCache = useAppStore((state) => state.childCache);
  const loadRoots = useAppStore((state) => state.loadRoots);
  const createFolder = useAppStore((state) => state.createFolder);
  const createDimensionGroupInFolderPath = useAppStore((state) => state.createDimensionGroupInFolderPath);
  const deleteNode = useAppStore((state) => state.deleteNode);
  const renameNode = useAppStore((state) => state.renameNode);
  const updateDimensionGroupColour = useAppStore((state) => state.updateDimensionGroupColour);
  const selectDimensionGroup = useAppStore((state) => state.selectDimensionGroup);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const activeBreadcrumb = useAppStore((state) => state.activeBreadcrumb);
  const overlayMeasurements = useAppStore((state) => state.overlayMeasurements);
  const overlayColour = useAppStore((state) => state.overlayColour);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNodeDto } | null>(null);
  const [pendingAddGroupPath, setPendingAddGroupPath] = useState<string | null>(null);
  const [pendingFolderParent, setPendingFolderParent] = useState<TreeNodeDto | null>(null);
  const [pendingRename, setPendingRename] = useState<TreeNodeDto | null>(null);
  const [pendingColour, setPendingColour] = useState<TreeNodeDto | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNodeDto | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadRoots("dimensions")
      .then(() => {
        if (!cancelled) setStatus("");
      })
      .catch((error) => {
        if (!cancelled) setStatus(`ERROR: ${error}`);
      });
    return () => {
      cancelled = true;
    };
  }, [loadRoots]);

  async function handleNodeClick(node: TreeNodeDto) {
    if (node.node_type === "dimension_group") {
      setStatus("Loading measurements...");
      try {
        await selectDimensionGroup(node);
        setSelectedFolderId(null);
        setStatus("");
      } catch (error) {
        setStatus(`ERROR: ${error}`);
      }
      return;
    }

    if (node.node_type === "folder") {
      setSelectedFolderId(node.id);
    }
  }

  function handleContextMenu(event: MouseEvent, node: TreeNodeDto) {
    event.preventDefault();
    if (node.node_type !== "folder" && node.node_type !== "dimension_group") return;
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  async function confirmAddGroup(folderPath: string, name: string, colour: string) {
    setStatus("Adding dimension group...");
    try {
      await createDimensionGroupInFolderPath(folderPath, name, colour);
      setPendingAddGroupPath(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmAddFolder(name: string) {
    if (!pendingFolderParent) return;
    setStatus("Adding folder...");
    try {
      await createFolder("dimensions", pendingFolderParent.id, name);
      setPendingFolderParent(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmRename(name: string) {
    if (!pendingRename) return;
    setStatus("Renaming...");
    try {
      await renameNode(pendingRename, name);
      setPendingRename(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmColour(colour: string) {
    if (!pendingColour) return;
    setStatus("Updating colour...");
    try {
      await updateDimensionGroupColour(pendingColour.id, colour);
      setPendingColour(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  async function confirmDeleteNode() {
    if (!pendingDelete) return;
    setStatus(`Deleting ${pendingDelete.name}...`);
    try {
      await deleteNode(pendingDelete);
      setPendingDelete(null);
      setSelectedFolderId(null);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  const activeNodeId = activeDimensionGroupId ?? selectedFolderId;

  return (
    <section style={{ display: "flex", minHeight: 0, flexDirection: "column", background: theme.bg.pane }}>
      <div style={{ display: "flex", height: theme.tabHeight, background: theme.bg.tabBar, borderBottom: `1px solid ${theme.border.subtle}` }}>
        {tabs.map((tab, index) => (
          <div
            key={tab}
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 10px",
              borderRight: `1px solid ${theme.border.subtle}`,
              background: index === 0 ? theme.bg.pane : theme.bg.tabBar,
              color: index === 0 ? theme.text.primary : theme.text.disabled,
              fontSize: 12,
            }}
          >
            {tab}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: `1px solid ${theme.border.subtle}` }}>
        <button
          onClick={() => setPendingFolderParent({ id: 0, tree: "dimensions", node_type: "folder", parent_id: null, name: "root", sort_order: 0, has_children: false, file_path: null, page_count: null, uom: null, colour: null })}
          style={{
            height: 24,
            padding: "0 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Add Folder
        </button>
        <button
          onClick={() => setPendingAddGroupPath("")}
          style={{
            height: 24,
            padding: "0 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Add Group
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: gridColumns, minWidth: 360, height: 24, borderBottom: `1px solid ${theme.border.subtle}`, background: theme.bg.shell, color: theme.text.primary, fontSize: 12 }}>
        <div style={{ borderRight: `1px solid ${theme.border.subtle}` }} />
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>
          <span>Name</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>Quantity</div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px", borderRight: `1px solid ${theme.border.subtle}` }}>UOM</div>
        <div />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingTop: 2 }}>
        {dimensionRoots.length === 0 ? <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No dimension folders yet</div> : null}
        {dimensionRoots.map((node) => (
          <DimensionTreeRow
            key={node.id}
            node={node}
            depth={0}
            activeNodeId={activeNodeId}
            onNodeClick={handleNodeClick}
            onContextMenu={handleContextMenu}
          />
        ))}
        {status ? <div style={{ padding: 8, color: theme.danger, fontSize: 12 }}>{status}</div> : null}
      </div>
      <div
        style={{
          minHeight: 44,
          padding: "6px 8px",
          borderTop: `1px solid ${theme.border.subtle}`,
          color: theme.text.secondary,
          fontSize: 12,
        }}
      >
        {activeDimensionGroupId ? (
          <>
            <div style={{ color: theme.text.primary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{activeBreadcrumb}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <span style={{ width: 10, height: 10, background: overlayColour, border: `1px solid ${theme.border.divider}` }} />
              <span>{overlayMeasurements.length} measurements loaded</span>
            </div>
          </>
        ) : (
          "No dimension group selected"
        )}
      </div>
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={
            contextMenu.node.node_type === "folder"
              ? [
                  {
                    label: "Add Sub-folder",
                    action: () => setPendingFolderParent(contextMenu.node),
                  },
                  {
                    label: "Add Dimension Group",
                    action: () => setPendingAddGroupPath(findPath(dimensionRoots, contextMenu.node.id, childCache)?.join("/") ?? ""),
                  },
                  {
                    label: "Rename Folder",
                    action: () => setPendingRename(contextMenu.node),
                  },
                  {
                    label: "Delete Folder",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
              : [
                  {
                    label: "Select Group",
                    action: () => {
                      void handleNodeClick(contextMenu.node);
                    },
                  },
                  {
                    label: "Rename Group",
                    action: () => setPendingRename(contextMenu.node),
                  },
                  {
                    label: "Change Colour",
                    action: () => setPendingColour(contextMenu.node),
                  },
                  {
                    label: "Delete Dimension Group",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
          }
        />
      ) : null}
      {pendingAddGroupPath !== null ? (
        <DimensionGroupDialog
          defaultPath={pendingAddGroupPath}
          roots={dimensionRoots}
          childCache={childCache}
          onCancel={() => setPendingAddGroupPath(null)}
          onConfirm={(folderPath, name, colour) => {
            void confirmAddGroup(folderPath, name, colour);
          }}
        />
      ) : null}
      {pendingFolderParent ? (
        <TextInputDialog
          title={pendingFolderParent.id === 0 ? "Add folder" : "Add sub-folder"}
          label="Folder name"
          initialValue=""
          confirmLabel="Add Folder"
          onCancel={() => setPendingFolderParent(null)}
          onConfirm={(name) => {
            if (pendingFolderParent.id === 0) {
              setStatus("Adding folder...");
              createFolder("dimensions", null, name)
                .then(() => setStatus(""))
                .catch((error) => setStatus(`ERROR: ${error}`))
                .finally(() => setPendingFolderParent(null));
            } else {
              void confirmAddFolder(name);
            }
          }}
        />
      ) : null}
      {pendingRename ? (
        <TextInputDialog
          title={pendingRename.node_type === "folder" ? "Rename folder" : "Rename dimension group"}
          label="Name"
          initialValue={pendingRename.name}
          confirmLabel="Rename"
          onCancel={() => setPendingRename(null)}
          onConfirm={(name) => {
            void confirmRename(name);
          }}
        />
      ) : null}
      {pendingColour ? (
        <ColourDialog
          title="Change dimension group colour"
          initialColour={pendingColour.colour ?? "#4A9EFF"}
          onCancel={() => setPendingColour(null)}
          onConfirm={(colour) => {
            void confirmColour(colour);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.node_type === "folder" ? "Delete dimension folder" : "Delete dimension group"}
          body={
            pendingDelete.node_type === "folder"
              ? `This will permanently delete "${pendingDelete.name}".\n\nAll child folders, dimension groups, and measurements inside this folder will be removed from the project.\n\nThis cannot be undone.`
              : `This will permanently delete "${pendingDelete.name}".\n\nAll measurements stored in this dimension group will be removed from the project.\n\nThis cannot be undone.`
          }
          confirmLabel={pendingDelete.node_type === "folder" ? "Delete Folder" : "Delete Dimension Group"}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void confirmDeleteNode();
          }}
        />
      ) : null}
    </section>
  );
}
