import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { theme } from "../theme";

interface NewProjectDialogProps {
  onCancel: () => void;
  onCreate: (name: string, client: string, contractNumber: string, filePath: string) => Promise<void>;
}

function projectFilename(name: string) {
  const cleaned = name.trim().replace(/[<>:"/\\|?*]+/g, "-");
  return `${cleaned || "New Project"}.tcop`;
}

function ensureTcopExtension(path: string) {
  return path.toLowerCase().endsWith(".tcop") ? path : `${path}.tcop`;
}

export function NewProjectDialog({ onCancel, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [contractNumber, setContractNumber] = useState("");
  const [filePath, setFilePath] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);

  const canCreate = useMemo(
    () => name.trim() && client.trim() && contractNumber.trim() && filePath.trim() && !creating,
    [client, contractNumber, creating, filePath, name],
  );

  async function browse() {
    const selected = await save({
      defaultPath: projectFilename(name),
      filters: [{ name: "Take-it-Off Project", extensions: ["tcop"] }],
    });

    if (!selected) return;
    setFilePath(ensureTcopExtension(selected));
  }

  async function create() {
    if (!canCreate) return;
    setCreating(true);
    setStatus("");
    try {
      await onCreate(name, client, contractNumber, ensureTcopExtension(filePath));
    } catch (error) {
      setStatus(`ERROR: ${error}`);
      setCreating(false);
    }
  }

  const labelStyle = { color: theme.text.secondary, fontSize: 12, width: 96 };
  const inputStyle = {
    flex: 1,
    minWidth: 0,
    height: 28,
    boxSizing: "border-box" as const,
    padding: "0 8px",
    background: theme.bg.input,
    color: theme.text.primary,
    border: `1px solid ${theme.border.divider}`,
    fontSize: 13,
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.55)",
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="New Project"
        style={{
          width: 420,
          maxWidth: "calc(100vw - 32px)",
          background: theme.bg.pane,
          color: theme.text.primary,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 16px 42px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${theme.border.subtle}`, fontSize: 16 }}>New Project</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={labelStyle}>Project Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} style={inputStyle} autoFocus />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={labelStyle}>Client</span>
            <input value={client} onChange={(event) => setClient(event.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={labelStyle}>Contract No.</span>
            <input value={contractNumber} onChange={(event) => setContractNumber(event.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
            <span style={labelStyle}>Save Location</span>
            <input value={filePath} readOnly style={inputStyle} />
          </label>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                void browse();
              }}
              style={{
                height: 28,
                padding: "0 12px",
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Browse...
            </button>
          </div>
          {status ? <div style={{ color: theme.danger, fontSize: 12 }}>{status}</div> : null}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", padding: 16, borderTop: `1px solid ${theme.border.subtle}` }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={creating}
            style={{
              height: 30,
              padding: "0 14px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              cursor: creating ? "not-allowed" : "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => {
              void create();
            }}
            style={{
              height: 30,
              padding: "0 14px",
              background: canCreate ? theme.bg.active : theme.bg.input,
              color: canCreate ? theme.text.primary : theme.text.disabled,
              border: `1px solid ${canCreate ? theme.accent : theme.border.divider}`,
              cursor: canCreate ? "pointer" : "not-allowed",
              fontSize: 12,
            }}
          >
            Create
          </button>
        </div>
      </section>
    </div>
  );
}
