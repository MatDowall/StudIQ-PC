import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";

interface FolderPathDialogProps {
  defaultPath: string;
  roots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;
  onCancel: () => void;
  onConfirm: (folderPath: string) => void;
}

function collectFolderPaths(nodes: TreeNodeDto[], childCache: Record<number, TreeNodeDto[]>, prefix: string[] = []): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.node_type !== "folder") continue;
    const nextPath = [...prefix, node.name];
    paths.push(nextPath.join("/"));
    paths.push(...collectFolderPaths(childCache[node.id] ?? [], childCache, nextPath));
  }
  return paths;
}

export function FolderPathDialog({ defaultPath, roots, childCache, onCancel, onConfirm }: FolderPathDialogProps) {
  const folderPaths = useMemo(() => collectFolderPaths(roots, childCache), [childCache, roots]);
  const [folderPath, setFolderPath] = useState(defaultPath);
  const canConfirm = folderPath.trim().length > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm) onConfirm(folderPath.trim());
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, folderPath, onCancel, onConfirm]);

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        background: "rgba(0, 0, 0, 0.45)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: 460,
          maxWidth: "calc(100vw - 40px)",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 18px 48px rgba(0, 0, 0, 0.45)",
          color: theme.text.primary,
          fontFamily: "Segoe UI, sans-serif",
        }}
      >
        <div
          style={{
            height: 38,
            display: "flex",
            alignItems: "center",
            padding: "0 12px",
            borderBottom: `1px solid ${theme.border.subtle}`,
            background: theme.bg.ribbon,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          Choose destination folder
        </div>
        <div style={{ padding: 12 }}>
          <div style={{ marginBottom: 8, color: theme.text.secondary, fontSize: 12 }}>
            Select an existing folder, or type a new path to create it.
          </div>
          <div
            style={{
              height: 154,
              overflow: "auto",
              border: `1px solid ${theme.border.subtle}`,
              background: theme.bg.shell,
              marginBottom: 10,
            }}
          >
            {folderPaths.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No folders yet</div>
            ) : (
              folderPaths.map((path) => (
                <button
                  key={path}
                  onClick={() => setFolderPath(path)}
                  style={{
                    display: "block",
                    width: "100%",
                    height: 24,
                    padding: "0 8px",
                    border: "none",
                    background: path === folderPath ? theme.bg.active : "transparent",
                    color: path === folderPath ? "#FFFFFF" : theme.text.primary,
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  {path}
                </button>
              ))
            )}
          </div>
          <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4 }}>Folder path</label>
          <input
            autoFocus
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: 30,
              padding: "0 8px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              outline: "none",
              fontSize: 13,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "10px 12px",
            borderTop: `1px solid ${theme.border.subtle}`,
          }}
        >
          <button
            onClick={onCancel}
            style={{
              height: 28,
              padding: "0 12px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            disabled={!canConfirm}
            onClick={() => onConfirm(folderPath.trim())}
            style={{
              height: 28,
              padding: "0 12px",
              background: canConfirm ? theme.bg.active : theme.bg.input,
              color: canConfirm ? "#FFFFFF" : theme.text.disabled,
              border: `1px solid ${canConfirm ? theme.accent : theme.border.divider}`,
              cursor: canConfirm ? "pointer" : "default",
            }}
          >
            Add Drawing
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
