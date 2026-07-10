import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogShell } from "./DialogShell";

interface RateDto {
  id: number;
  code: string;
  description: string;
  rate: number;
  unit: string;
}

interface ConstantDto {
  name: string;
  value: number;
}

type Tab = "rates" | "constants";

interface Props {
  onClose: () => void;
}

const CELL: React.CSSProperties = {
  padding: "0 6px",
  border: "none",
  background: theme.bg.input,
  color: theme.text.primary,
  fontSize: 12,
  fontFamily: "Segoe UI, sans-serif",
  height: 26,
  outline: "none",
  width: "100%",
};

export function RateConstantsDialog({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("rates");

  // ── Rates ──────────────────────────────────────────────────────────────────
  const [rates, setRates] = useState<RateDto[]>([]);
  const [selectedRateId, setSelectedRateId] = useState<number | null>(null);
  const [rateForm, setRateForm] = useState({ code: "", description: "", rate: "", unit: "" });
  const [editingRateId, setEditingRateId] = useState<number | null>(null);
  const [confirmDeleteRateId, setConfirmDeleteRateId] = useState<number | null>(null);

  // ── Constants ──────────────────────────────────────────────────────────────
  const [constants, setConstants] = useState<ConstantDto[]>([]);
  const [selectedConstName, setSelectedConstName] = useState<string | null>(null);
  const [constForm, setConstForm] = useState({ name: "", value: "" });
  const [editingConstName, setEditingConstName] = useState<string | null>(null);
  const [confirmDeleteConstName, setConfirmDeleteConstName] = useState<string | null>(null);

  useEffect(() => { void loadRates(); void loadConstants(); }, []);

  async function loadRates() {
    const rows = await invoke<RateDto[]>("list_rates");
    setRates(rows);
  }
  async function loadConstants() {
    const rows = await invoke<ConstantDto[]>("list_constants");
    setConstants(rows);
  }

  // ── Rate actions ───────────────────────────────────────────────────────────

  function beginAddRate() {
    setEditingRateId(null);
    setRateForm({ code: "", description: "", rate: "", unit: "" });
    setSelectedRateId(null);
  }

  function beginEditRate(r: RateDto) {
    setEditingRateId(r.id);
    setRateForm({ code: r.code, description: r.description, rate: String(r.rate), unit: r.unit });
    setSelectedRateId(r.id);
  }

  async function saveRate() {
    const code = rateForm.code.trim();
    const rate = parseFloat(rateForm.rate);
    if (!code) return;
    if (!Number.isFinite(rate)) return;
    if (editingRateId != null) {
      await invoke("update_rate", { id: editingRateId, code, description: rateForm.description, rate, unit: rateForm.unit });
    } else {
      const r = await invoke<RateDto>("create_rate", { code, description: rateForm.description, rate, unit: rateForm.unit });
      setSelectedRateId(r.id);
    }
    setEditingRateId(null);
    setRateForm({ code: "", description: "", rate: "", unit: "" });
    await loadRates();
  }

  async function deleteRate(id: number) {
    await invoke("delete_rate", { id });
    if (selectedRateId === id) setSelectedRateId(null);
    setConfirmDeleteRateId(null);
    await loadRates();
  }

  // ── Constant actions ───────────────────────────────────────────────────────

  function beginAddConstant() {
    setEditingConstName(null);
    setConstForm({ name: "", value: "" });
    setSelectedConstName(null);
  }

  function beginEditConstant(c: ConstantDto) {
    setEditingConstName(c.name);
    setConstForm({ name: c.name, value: String(c.value) });
    setSelectedConstName(c.name);
  }

  async function saveConstant() {
    const name = constForm.name.trim();
    const value = parseFloat(constForm.value);
    if (!name || !Number.isFinite(value)) return;
    await invoke("set_constant", { name, value });
    setEditingConstName(null);
    setConstForm({ name: "", value: "" });
    setSelectedConstName(name);
    await loadConstants();
  }

  async function deleteConstant(name: string) {
    await invoke("delete_constant", { name });
    if (selectedConstName === name) setSelectedConstName(null);
    setConfirmDeleteConstName(null);
    await loadConstants();
  }

  // ── Shared styles ──────────────────────────────────────────────────────────

  const isRateFormOpen = editingRateId != null || (editingRateId === null && rateForm.code !== "" || rateForm.rate !== "");
  const isConstFormOpen = editingConstName != null || constForm.name !== "" || constForm.value !== "";

  function TabButton({ id, label }: { id: Tab; label: string }) {
    return (
      <button
        onClick={() => setTab(id)}
        style={{
          flex: 1, height: 30, border: "none", cursor: "pointer", fontSize: 12,
          fontFamily: "Segoe UI, sans-serif",
          background: tab === id ? theme.bg.pane : theme.bg.ribbon,
          color: tab === id ? theme.text.primary : theme.text.secondary,
          fontWeight: tab === id ? 600 : 400,
          borderBottom: tab === id ? `2px solid ${theme.accent}` : "2px solid transparent",
        }}
      >
        {label}
      </button>
    );
  }

  function ActionBtn({ label, icon, onClick, danger }: { label: string; icon: string; onClick: () => void; danger?: boolean }) {
    return (
      <button
        title={label}
        onClick={onClick}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: 26, height: 26, padding: 0, border: `1px solid ${theme.border.divider}`,
          background: theme.bg.input, color: danger ? theme.danger : theme.text.primary,
          cursor: "pointer", borderRadius: 2,
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 15, lineHeight: 1 }}>{icon}</span>
      </button>
    );
  }

  const selectedRate = rates.find((r) => r.id === selectedRateId) ?? null;
  const selectedConst = constants.find((c) => c.name === selectedConstName) ?? null;

  return (
    <>
      <DialogShell title="Rate Library" width={560} zIndex={1240} onClose={onClose}>
        {/* Tab bar */}
        <div style={{ display: "flex", borderBottom: `1px solid ${theme.border.subtle}` }}>
          <TabButton id="rates" label="Rates" />
          <TabButton id="constants" label="Constants" />
        </div>

        {/* ── Rates panel ── */}
        {tab === "rates" && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Toolbar */}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: 11, color: theme.text.secondary }}>
                {rates.length} {rates.length === 1 ? "rate" : "rates"}
              </span>
              <ActionBtn label="Add" icon="add" onClick={beginAddRate} />
              <ActionBtn label="Edit" icon="edit" onClick={() => selectedRate && beginEditRate(selectedRate)} />
              <ActionBtn label="Delete" icon="delete" danger onClick={() => selectedRate && setConfirmDeleteRateId(selectedRate.id)} />
            </div>

            {/* List */}
            <div style={{ height: 160, overflow: "auto", border: `1px solid ${theme.border.subtle}`, background: theme.bg.shell }}>
              {rates.length === 0 ? (
                <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No rates yet — click + to add one</div>
              ) : (
                rates.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setSelectedRateId(r.id)}
                    onDoubleClick={() => beginEditRate(r)}
                    style={{
                      display: "grid", gridTemplateColumns: "80px 1fr 80px 60px",
                      gap: 8, alignItems: "center",
                      width: "100%", height: 26, padding: "0 8px", border: "none",
                      background: r.id === selectedRateId ? theme.bg.active : "transparent",
                      color: r.id === selectedRateId ? "#fff" : theme.text.primary,
                      textAlign: "left", cursor: "pointer", fontSize: 12,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{r.code}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description}</span>
                    <span style={{ textAlign: "right" }}>{r.rate.toFixed(2)}</span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.unit}</span>
                  </button>
                ))
              )}
            </div>

            {/* Edit/add form */}
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 80px 60px", gap: 6 }}>
              <input placeholder="Code" value={rateForm.code} onChange={(e) => setRateForm((f) => ({ ...f, code: e.target.value }))} style={CELL} />
              <input placeholder="Description" value={rateForm.description} onChange={(e) => setRateForm((f) => ({ ...f, description: e.target.value }))} style={CELL} />
              <input placeholder="Rate" type="number" value={rateForm.rate} onChange={(e) => setRateForm((f) => ({ ...f, rate: e.target.value }))} style={CELL} />
              <input placeholder="Unit" value={rateForm.unit} onChange={(e) => setRateForm((f) => ({ ...f, unit: e.target.value }))} style={CELL} />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => void saveRate()}
                disabled={!rateForm.code.trim() || !Number.isFinite(parseFloat(rateForm.rate))}
                style={{
                  height: 26, padding: "0 12px", fontSize: 12, fontFamily: "inherit",
                  background: theme.bg.active, color: theme.text.primary,
                  border: `1px solid ${theme.accent}`, cursor: "pointer",
                }}
              >
                {editingRateId != null ? "Update" : "Add Rate"}
              </button>
              {(editingRateId != null || rateForm.code || rateForm.rate) && (
                <button
                  onClick={() => { setEditingRateId(null); setRateForm({ code: "", description: "", rate: "", unit: "" }); }}
                  style={{
                    height: 26, padding: "0 12px", fontSize: 12, fontFamily: "inherit",
                    background: theme.bg.input, color: theme.text.primary,
                    border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Constants panel ── */}
        {tab === "constants" && (
          <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Toolbar */}
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: 11, color: theme.text.secondary }}>
                {constants.length} {constants.length === 1 ? "constant" : "constants"}
              </span>
              <ActionBtn label="Add" icon="add" onClick={beginAddConstant} />
              <ActionBtn label="Edit" icon="edit" onClick={() => selectedConst && beginEditConstant(selectedConst)} />
              <ActionBtn label="Delete" icon="delete" danger onClick={() => selectedConst && setConfirmDeleteConstName(selectedConst.name)} />
            </div>

            {/* List */}
            <div style={{ height: 160, overflow: "auto", border: `1px solid ${theme.border.subtle}`, background: theme.bg.shell }}>
              {constants.length === 0 ? (
                <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No constants yet — click + to add one</div>
              ) : (
                constants.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setSelectedConstName(c.name)}
                    onDoubleClick={() => beginEditConstant(c)}
                    style={{
                      display: "grid", gridTemplateColumns: "1fr 120px",
                      gap: 8, alignItems: "center",
                      width: "100%", height: 26, padding: "0 8px", border: "none",
                      background: c.name === selectedConstName ? theme.bg.active : "transparent",
                      color: c.name === selectedConstName ? "#fff" : theme.text.primary,
                      textAlign: "left", cursor: "pointer", fontSize: 12,
                    }}
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{c.name}</span>
                    <span style={{ textAlign: "right" }}>{c.value}</span>
                  </button>
                ))
              )}
            </div>

            {/* Edit/add form */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 120px", gap: 6 }}>
              <input
                placeholder="Name"
                value={constForm.name}
                disabled={editingConstName != null}
                onChange={(e) => setConstForm((f) => ({ ...f, name: e.target.value }))}
                style={{ ...CELL, opacity: editingConstName != null ? 0.6 : 1 }}
              />
              <input
                placeholder="Value"
                type="number"
                value={constForm.value}
                onChange={(e) => setConstForm((f) => ({ ...f, value: e.target.value }))}
                style={CELL}
              />
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => void saveConstant()}
                disabled={!constForm.name.trim() || !Number.isFinite(parseFloat(constForm.value))}
                style={{
                  height: 26, padding: "0 12px", fontSize: 12, fontFamily: "inherit",
                  background: theme.bg.active, color: theme.text.primary,
                  border: `1px solid ${theme.accent}`, cursor: "pointer",
                }}
              >
                {editingConstName != null ? "Update" : "Add Constant"}
              </button>
              {(editingConstName != null || constForm.name || constForm.value) && (
                <button
                  onClick={() => { setEditingConstName(null); setConstForm({ name: "", value: "" }); }}
                  style={{
                    height: 26, padding: "0 12px", fontSize: 12, fontFamily: "inherit",
                    background: theme.bg.input, color: theme.text.primary,
                    border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        <div
          style={{
            display: "flex", justifyContent: "flex-end",
            padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}`,
          }}
        >
          <button
            onClick={onClose}
            style={{
              height: 28, padding: "0 12px", background: theme.bg.input,
              color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer",
              fontSize: 12, fontFamily: "inherit",
            }}
          >
            Close
          </button>
        </div>
      </DialogShell>

      {confirmDeleteRateId != null && (
        <ConfirmDialog
          title="Delete Rate"
          body={`Delete rate "${rates.find((r) => r.id === confirmDeleteRateId)?.code}"? Any Excel cells using =STUDIQ.RATE(${confirmDeleteRateId}) will show an error.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteRateId(null)}
          onConfirm={() => void deleteRate(confirmDeleteRateId!)}
        />
      )}

      {confirmDeleteConstName != null && (
        <ConfirmDialog
          title="Delete Constant"
          body={`Delete constant "${confirmDeleteConstName}"? Any Excel cells using =STUDIQ.CONST("${confirmDeleteConstName}") will show an error.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteConstName(null)}
          onConfirm={() => void deleteConstant(confirmDeleteConstName!)}
        />
      )}
    </>
  );
}
