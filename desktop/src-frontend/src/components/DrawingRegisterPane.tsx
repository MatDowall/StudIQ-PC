import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore, TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu } from "./ContextMenu";
import { FolderPathDialog } from "./FolderPathDialog";
import { TreeNode } from "./TreeNode";

const tabs = ["Drawings", "Layers", "Model", "Views"];

export function DrawingRegisterPane() {
  const drawingRoots = useAppStore((state) => state.drawingRoots);
  const childCache = useAppStore((state) => state.childCache);
  const loadRoots = useAppStore((state) => state.loadRoots);
  const addDrawingToFolderPath = useAppStore((state) => state.addDrawingToFolderPath);
  const deleteNode = useAppStore((state) => state.deleteNode);
  const openDrawing = useAppStore((state) => state.openDrawing);
  const openDrawingPage = useAppStore((state) => state.openDrawingPage);
  const activeDrawingId = useAppStore((state) => state.activeDrawingId);
  const activePageNodeId = useAppStore((state) => state.activePageNodeId);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: TreeNodeDto } | null>(null);
  const [pendingDrawing, setPendingDrawing] = useState<{ filePath: string; name: string; defaultFolderPath: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TreeNodeDto | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadRoots("drawings")
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
    if (node.node_type === "drawing") {
      setStatus("Opening drawing...");
      try {
        await openDrawing(node);
        setSelectedFolderId(null);
        setStatus("");
      } catch (error) {
        setStatus(`ERROR: ${error}`);
      }
      return;
    }

    if (node.node_type === "drawing_page") {
      setStatus(`Opening ${node.name}...`);
      try {
        await openDrawingPage(node);
        setSelectedFolderId(null);
        setStatus("");
      } catch (error) {
        setStatus(`ERROR: ${error}`);
      }
      return;
    }

    setSelectedFolderId(node.id);
  }

  function handleContextMenu(event: MouseEvent, node: TreeNodeDto) {
    event.preventDefault();
    if (node.node_type === "drawing_page") return;
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  function findPath(nodes: TreeNodeDto[], targetId: number, path: string[] = []): string[] | null {
    for (const node of nodes) {
      const nextPath = node.node_type === "folder" ? [...path, node.name] : path;
      if (node.id === targetId) return nextPath;
      const children = useAppStore.getState().childCache[node.id] ?? [];
      const found = findPath(children, targetId, nextPath);
      if (found) return found;
    }
    return null;
  }

  async function handleAddDrawingToChosenFolder(defaultFolderPath = "") {
    const selected = await open({
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;

    const filename = selected.split(/[\\/]/).pop() ?? "Drawing";
    const name = filename.replace(/\.pdf$/i, "");
    setPendingDrawing({ filePath: selected, name, defaultFolderPath });
  }

  async function confirmAddDrawing(folderPath: string) {
    if (!pendingDrawing) return;
    setStatus("Adding drawing...");
    try {
      await addDrawingToFolderPath(folderPath, pendingDrawing.name, pendingDrawing.filePath);
      setPendingDrawing(null);
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

  const activeNodeId = activePageNodeId ?? activeDrawingId ?? selectedFolderId;

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
          onClick={() => {
            void handleAddDrawingToChosenFolder();
          }}
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
          Add Drawing
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingTop: 4 }}>
        <div style={{ display: "block" }}>
          {drawingRoots.length === 0 ? (
            <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No drawing folders yet</div>
          ) : null}
          {drawingRoots.map((node) => (
            <TreeNode
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
        <div style={{ display: "none" }} />
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
                    label: "Add Drawing",
                    action: () => {
                      const defaultPath = findPath(drawingRoots, contextMenu.node.id)?.join("/") ?? "";
                      void handleAddDrawingToChosenFolder(defaultPath);
                    },
                  },
                  {
                    label: "Delete Folder",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
              : [
                  {
                    label: "Open Drawing",
                    action: () => {
                      void handleNodeClick(contextMenu.node);
                    },
                  },
                  {
                    label: "Remove Drawing",
                    danger: true,
                    action: () => setPendingDelete(contextMenu.node),
                  },
                ]
          }
        />
      ) : null}
      {pendingDrawing ? (
        <FolderPathDialog
          defaultPath={pendingDrawing.defaultFolderPath}
          roots={drawingRoots}
          childCache={childCache}
          onCancel={() => setPendingDrawing(null)}
          onConfirm={(folderPath) => {
            void confirmAddDrawing(folderPath);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <ConfirmDialog
          title={pendingDelete.node_type === "folder" ? "Delete folder" : "Remove drawing"}
          body={
            pendingDelete.node_type === "folder"
              ? `This will permanently delete "${pendingDelete.name}".\n\nAll child folders and drawings inside this folder will be removed from the project register. Any linked project data under those drawings may also be removed by database cascade rules.\n\nThis cannot be undone.`
              : `This will permanently remove "${pendingDelete.name}" from the project register.\n\nAny linked project data under this drawing may also be removed by database cascade rules.\n\nThis cannot be undone.`
          }
          confirmLabel={pendingDelete.node_type === "folder" ? "Delete Folder" : "Remove Drawing"}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            void confirmDeleteNode();
          }}
        />
      ) : null}
    </section>
  );
}
