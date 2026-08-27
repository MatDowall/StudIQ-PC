import { useEffect, useMemo, useState } from "react";
import { TreeNodeDto } from "../store/appStore";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import { FRAMING_SIZES, type FramingSize } from "../lib/framing";

const MEASUREMENT_TYPES = [
  { value: "length", label: "Length" },
  { value: "area", label: "Area" },
  { value: "count", label: "Count" },
  { value: "timber_framing", label: "Timber Framing" },
  { value: "array", label: "Joist / Rafter" },
  { value: "wall_surface", label: "Wall Surface from Framing" },
  { value: "wall_insulation", label: "Wall Insulation from Framing" },
] as const;

interface DimensionGroupDialogProps {
  defaultPath: string;
  roots: TreeNodeDto[];
  childCache: Record<number, TreeNodeDto[]>;
  onCancel: () => void;
  onConfirm: (
    folderPath: string,
    name: string,
    colour: string,
    measurementType: string,
    joistRafter?: { spacingM: number; framingSize: FramingSize },
  ) => void;
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
  const isJoistRafter = measurementType === "array";
  const [spacing, setSpacing] = useState("0.6");
  const [timberSize, setTimberSize] = useState<FramingSize>("90x45");
  const spacingM = Number.parseFloat(spacing);
  const spacingValid = !isJoistRafter || (Number.isFinite(spacingM) && spacingM > 0);
  const canConfirm = folderPath.trim().length > 0 && name.trim().length > 0 && spacingValid;
  const joistRafterProps = isJoistRafter ? { spacingM, framingSize: timberSize } : undefined;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm) onConfirm(folderPath.trim(), name.trim(), colour, measurementType, joistRafterProps);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, colour, folderPath, name, measurementType, joistRafterProps, onCancel, onConfirm]);

  return (
    <DialogShell title="Add dimension group" width={480} zIndex={1200} onClose={onCancel}>
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
        {isJoistRafter ? (
          <>
            <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4 }}>
              Default Spacing (m) <span style={{ color: theme.danger }}>*</span>
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={spacing}
              onChange={(event) => setSpacing(event.target.value)}
              style={{
                boxSizing: "border-box",
                width: "100%",
                height: 30,
                padding: "0 8px",
                marginBottom: 4,
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${spacingValid ? theme.border.divider : theme.danger}`,
                outline: "none",
                fontSize: 13,
              }}
            />
            {!spacingValid ? (
              <div style={{ marginBottom: 6, color: theme.danger, fontSize: 11 }}>
                Spacing is required and must be greater than zero.
              </div>
            ) : null}
            <label style={{ display: "block", color: theme.text.secondary, fontSize: 12, marginBottom: 4, marginTop: 6 }}>Timber Size</label>
            <select
              value={timberSize}
              onChange={(event) => setTimberSize(event.target.value as FramingSize)}
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
              {FRAMING_SIZES.map((size) => (
                <option key={size} value={size}>{size.replace("x", " × ")}</option>
              ))}
            </select>
          </>
        ) : null}
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
          onClick={() => onConfirm(folderPath.trim(), name.trim(), colour, measurementType, joistRafterProps)}
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
    </DialogShell>
  );
}
