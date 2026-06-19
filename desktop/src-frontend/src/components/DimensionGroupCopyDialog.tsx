import { useEffect, useState } from "react";
import type { FolderOption } from "../store/appStore";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

interface DimensionGroupCopyDialogProps {
  sourceName: string;
  folders: FolderOption[];
  defaultFolderId: number | null;
  onCancel: () => void;
  onConfirm: (targetFolderId: number, name: string, copyDimensions: boolean) => void;
}

export function DimensionGroupCopyDialog({
  sourceName,
  folders,
  defaultFolderId,
  onCancel,
  onConfirm,
}: DimensionGroupCopyDialogProps) {
  const [name, setName] = useState(`${sourceName} - Copy`);
  const [folderId, setFolderId] = useState<number | null>(defaultFolderId ?? folders[0]?.id ?? null);
  const [copyDimensions, setCopyDimensions] = useState(false);
  const canConfirm = name.trim().length > 0 && folderId !== null;

  function confirm() {
    if (!canConfirm || folderId === null) return;
    onConfirm(folderId, name.trim(), copyDimensions);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
      if (event.key === "Enter" && canConfirm && folderId !== null) {
        onConfirm(folderId, name.trim(), copyDimensions);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canConfirm, copyDimensions, folderId, name, onCancel, onConfirm]);

  const inputStyle: React.CSSProperties = {
    boxSizing: "border-box",
    width: "100%",
    height: 30,
    padding: "0 8px",
    background: theme.bg.input,
    color: theme.text.primary,
    border: `1px solid ${theme.border.divider}`,
    outline: "none",
    fontSize: 13,
  };

  return (
    <DialogShell title="Copy dimension group to" width={440} zIndex={1200} onClose={onCancel}>
      <div style={{ padding: 14, display: "grid", gridTemplateColumns: "64px 1fr", gap: "10px 10px", alignItems: "center" }}>
        <label htmlFor="copy-name" style={{ color: theme.text.secondary, fontSize: 12, textAlign: "right" }}>
          Name
        </label>
        <input id="copy-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} />

        <label htmlFor="copy-folder" style={{ color: theme.text.secondary, fontSize: 12, textAlign: "right" }}>
          Folder
        </label>
        <select
          id="copy-folder"
          value={folderId ?? ""}
          onChange={(event) => setFolderId(event.target.value === "" ? null : Number(event.target.value))}
          style={{ ...inputStyle, padding: "0 6px" }}
        >
          {folders.length === 0 ? <option value="">No folders</option> : null}
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.path}
            </option>
          ))}
        </select>

        <span />
        <label style={{ display: "flex", alignItems: "center", gap: 8, color: theme.text.primary, fontSize: 12, cursor: "pointer" }}>
          <input type="checkbox" checked={copyDimensions} onChange={(event) => setCopyDimensions(event.target.checked)} />
          Copy Dimensions
        </label>
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
          onClick={confirm}
          style={{
            height: 28,
            padding: "0 12px",
            background: canConfirm ? theme.bg.active : theme.bg.input,
            color: canConfirm ? "#FFFFFF" : theme.text.disabled,
            border: `1px solid ${canConfirm ? theme.accent : theme.border.divider}`,
            cursor: canConfirm ? "pointer" : "default",
          }}
        >
          OK
        </button>
      </div>
    </DialogShell>
  );
}
