import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";

const MEASUREMENT_TYPES = [
  { value: "length", label: "Length" },
  { value: "area", label: "Area" },
  { value: "count", label: "Count" },
  { value: "timber_framing", label: "Timber Framing" },
  { value: "array", label: "Array" },
] as const;

interface DimensionGroupDialogProps {
  defaultPath: string;
  roots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;
  onCancel: () => void;
  onConfirm: (folderPath: string, name: string, colour: string, measurementType: string) => void;
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

export function DimensionGroupDialog({ defaultPath, roots, childCache, onCancel, onConfirm }: DimensionGroupDialogProps) {
  const folderPaths = useMemo(() => collectFolderPaths(roots, childCache), [childCache, roots]);
  const [folderPath, setFolderPath] = useState(defaultPath);
  const [name, setName] = useState("");
  const [colour, setColour] = useState("#4A9EFF");
  const [measurementType, setMeasurementType] = useState("length");
  const canConfirm = folderPath.trim().length > 0 && name.trim().length > 0;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm) onConfirm(folderPath.trim(), name.trim(), colour, measurementType);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, colour, folderPath, name, onCancel, onConfirm]);

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
          width: 480,
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
          Add dimension group
        </div>
        <div style={{ padding: 12 }}>
          <div style={{ marginBottom: 8, color: theme.text.secondary, fontSize: 12 }}>
            Select an existing folder, or type a new path to create it.
          </div>
          <div
            style={{
              height: 132,
              overflow: "auto",
              border: `1px solid ${theme.border.subtle}`,
              background: theme.bg.shell,
              marginBottom: 10,
            }}
          >
            {folderPaths.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No dimension folders yet</div>
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
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: 30,
              padding: "0 8px",
              marginBottom: 10,
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              outline: "none",
              fontSize: 13,
            }}
          />
          <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4 }}>Group name</label>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: 30,
              padding: "0 8px",
              marginBottom: 10,
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              outline: "none",
              fontSize: 13,
            }}
          />
          <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4 }}>Measurement type</label>
          <select
            value={measurementType}
            onChange={(event) => setMeasurementType(event.target.value)}
            style={{
              boxSizing: "border-box",
              width: "100%",
              height: 30,
              padding: "0 8px",
              marginBottom: 10,
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              outline: "none",
              fontSize: 13,
            }}
          >
            {MEASUREMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4 }}>Colour</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="color"
              value={colour}
              onChange={(event) => setColour(event.target.value)}
              style={{ width: 44, height: 30, padding: 0, background: theme.bg.input, border: `1px solid ${theme.border.divider}` }}
            />
            <input
              value={colour}
              onChange={(event) => setColour(event.target.value)}
              style={{
                boxSizing: "border-box",
                flex: 1,
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
            onClick={() => onConfirm(folderPath.trim(), name.trim(), colour, measurementType)}
            style={{
              height: 28,
              padding: "0 12px",
              background: canConfirm ? theme.bg.active : theme.bg.input,
              color: canConfirm ? "#FFFFFF" : theme.text.disabled,
              border: `1px solid ${canConfirm ? theme.accent : theme.border.divider}`,
              cursor: canConfirm ? "pointer" : "default",
            }}
          >
            Add Group
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
