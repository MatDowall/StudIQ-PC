import { useState } from "react";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";

const STATUS_OPTIONS = ["Tendering", "Closed"];

interface Props {
  initial: { name: string; client: string; contractNumber: string; status: string };
  onCancel: () => void;
  onConfirm: () => void;
}

export function ProjectInfoDialog({ initial, onCancel, onConfirm }: Props) {
  const updateProjectMeta = useAppStore((state) => state.updateProjectMeta);
  const [name, setName] = useState(initial.name);
  const [client, setClient] = useState(initial.client);
  const [contractNumber, setContractNumber] = useState(initial.contractNumber);
  const [status, setStatus] = useState(initial.status);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!name.trim()) { setError("Project name is required."); return; }
    if (!client.trim()) { setError("Client is required."); return; }
    if (!contractNumber.trim()) { setError("Contract number is required."); return; }
    setSaving(true);
    try {
      await updateProjectMeta(name.trim(), client.trim(), contractNumber.trim(), status);
      onConfirm();
    } catch (err) {
      setError(`Error: ${err}`);
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 28,
    width: "100%",
    padding: "0 8px",
    background: theme.bg.input,
    color: theme.text.primary,
    border: `1px solid ${theme.border.divider}`,
    fontSize: 13,
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: theme.text.secondary,
    marginBottom: 4,
    display: "block",
  };

  return (
    <DialogShell title="Project Information" width={400} zIndex={9000} onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
        <div>
          <label style={labelStyle}>Project Name</label>
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div>
          <label style={labelStyle}>Client</label>
          <input style={inputStyle} value={client} onChange={(e) => setClient(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Contract Number</label>
          <input style={inputStyle} value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            style={{ ...inputStyle, cursor: "pointer" }}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>

        {error ? <div style={{ color: theme.danger, fontSize: 12 }}>{error}</div> : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: 28,
              padding: "0 14px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => { void handleSave(); }}
            disabled={saving}
            style={{
              height: 28,
              padding: "0 14px",
              background: theme.bg.active,
              color: theme.text.primary,
              border: `1px solid ${theme.accent}`,
              cursor: saving ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
