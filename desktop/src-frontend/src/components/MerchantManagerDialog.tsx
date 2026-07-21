import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogShell } from "./DialogShell";
import { PRICE_BOOK_FIELDS, type MerchantDto } from "./RateLibraryPane";

interface Props {
  onClose: () => void;
  /** Called whenever the merchant list changes (create/update/delete) so the caller
   *  (the upload picker in PriceBookManagerDialog) can refresh its options. */
  onChanged: () => void;
}

const NEW_DRAFT_ID = -1;

interface Draft {
  id: number;
  name: string;
  columnMap: Record<string, string>;
}

function draftFromMerchant(m: MerchantDto): Draft {
  return { id: m.id, name: m.name, columnMap: { ...m.column_map } };
}

function blankDraft(): Draft {
  return { id: NEW_DRAFT_ID, name: "", columnMap: {} };
}

export function MerchantManagerDialog({ onClose, onChanged }: Props) {
  const [merchants, setMerchants] = useState<MerchantDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [detectedHeaders, setDetectedHeaders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await invoke<MerchantDto[]>("list_price_book_merchants");
      setMerchants(rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function selectMerchant(m: MerchantDto) {
    setError(null);
    setDraft(draftFromMerchant(m));
    setDetectedHeaders([]);
  }

  function startNew() {
    setError(null);
    setDraft(blankDraft());
    setDetectedHeaders([]);
  }

  async function loadSample() {
    const selected = await open({ filters: [{ name: "Price Book CSV", extensions: ["csv"] }], multiple: false });
    if (!selected || typeof selected !== "string") return;
    try {
      const headers = await invoke<string[]>("preview_price_book_headers", { path: selected });
      setDetectedHeaders(headers);
    } catch (err) {
      setError(String(err));
    }
  }

  function updateField(key: string, value: string) {
    if (!draft) return;
    setDraft({ ...draft, columnMap: { ...draft.columnMap, [key]: value } });
  }

  async function handleSave() {
    if (!draft) return;
    setError(null);
    setSaving(true);
    try {
      if (draft.id === NEW_DRAFT_ID) {
        await invoke("create_price_book_merchant", { name: draft.name, columnMap: draft.columnMap });
      } else {
        await invoke("update_price_book_merchant", { id: draft.id, name: draft.name, columnMap: draft.columnMap });
      }
      await refresh();
      onChanged();
      setDraft(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    setConfirmDeleteId(null);
    setError(null);
    try {
      await invoke("delete_price_book_merchant", { id });
      if (draft?.id === id) setDraft(null);
      await refresh();
      onChanged();
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <>
      <DialogShell title="Manage Merchants" width={620} zIndex={1260} onClose={onClose}>
        <div style={{ padding: 12, display: "flex", gap: 12 }}>
          <div style={{ width: 170, flexShrink: 0 }}>
            <div
              style={{
                height: 260,
                overflow: "auto",
                border: `1px solid ${theme.border.subtle}`,
                background: theme.bg.shell,
                marginBottom: 8,
              }}
            >
              {loading ? (
                <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>Loading...</div>
              ) : merchants.length === 0 ? (
                <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No merchants yet</div>
              ) : (
                merchants.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => selectMerchant(m)}
                    style={{
                      display: "block",
                      width: "100%",
                      height: 26,
                      padding: "0 8px",
                      border: "none",
                      background: draft?.id === m.id ? theme.bg.active : "transparent",
                      color: draft?.id === m.id ? "#FFFFFF" : theme.text.primary,
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.name}
                  </button>
                ))
              )}
            </div>
            <button
              onClick={startNew}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                width: "100%",
                height: 28,
                padding: "0 12px",
                background: theme.bg.input,
                color: theme.text.primary,
                border: `1px solid ${theme.border.divider}`,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              New Merchant
            </button>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {draft ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    placeholder="Merchant name (e.g. PlaceMakers)"
                    style={{
                      flex: 1,
                      height: 26,
                      padding: "0 8px",
                      background: theme.bg.input,
                      color: theme.text.primary,
                      border: `1px solid ${theme.border.divider}`,
                      fontSize: 13,
                      outline: "none",
                    }}
                  />
                  {draft.id !== NEW_DRAFT_ID ? (
                    <button
                      title="Delete"
                      onClick={() => setConfirmDeleteId(draft.id)}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        width: 28, height: 28, padding: 0,
                        background: theme.bg.input, color: theme.text.primary,
                        border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                    </button>
                  ) : null}
                </div>

                <button
                  onClick={() => void loadSample()}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 4,
                    width: "100%",
                    height: 26,
                    padding: "0 8px",
                    marginBottom: 8,
                    background: theme.bg.input,
                    color: theme.text.primary,
                    border: `1px solid ${theme.border.divider}`,
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload_file</span>
                  Load Sample CSV to Pick Columns From...
                </button>
                {detectedHeaders.length > 0 ? (
                  <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 8 }}>
                    {detectedHeaders.length} columns detected — start typing in a field below to see matches
                  </div>
                ) : null}

                <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 6 }}>
                  Only Description and Unit Price are required — Category/Group/Sub Group are
                  optional and can be left blank for a merchant whose price list isn't organized
                  that way.
                </div>

                <div style={{ maxHeight: 280, overflow: "auto" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "170px 1fr", rowGap: 6, columnGap: 8, alignItems: "center" }}>
                    {PRICE_BOOK_FIELDS.map((field) => (
                      <div key={field.key} style={{ display: "contents" }}>
                        <label style={{ fontSize: 12, color: theme.text.secondary }} title={field.hint}>
                          {field.label}
                          {field.required ? <span style={{ color: theme.danger }}> *</span> : null}
                        </label>
                        <input
                          value={draft.columnMap[field.key] ?? ""}
                          onChange={(event) => updateField(field.key, event.target.value)}
                          list={`merchant-headers-${field.key}`}
                          placeholder={field.required ? "Required — exact CSV column name" : field.hint ?? "Optional"}
                          style={{
                            height: 24,
                            padding: "0 6px",
                            background: theme.bg.input,
                            color: theme.text.primary,
                            border: `1px solid ${theme.border.divider}`,
                            fontSize: 12,
                            outline: "none",
                          }}
                        />
                        <datalist id={`merchant-headers-${field.key}`}>
                          {detectedHeaders.map((h) => (
                            <option key={h} value={h} />
                          ))}
                        </datalist>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ color: theme.text.secondary, fontSize: 12, padding: 8 }}>
                Select a merchant to edit its format, or create a new one.
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ padding: "0 12px 8px", color: theme.danger, fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}` }}>
          {draft ? (
            <button
              onClick={() => void handleSave()}
              disabled={saving || !draft.name.trim()}
              style={{
                height: 28,
                padding: "0 12px",
                background: theme.bg.active,
                color: theme.text.primary,
                border: `1px solid ${theme.accent}`,
                cursor: saving ? "default" : "pointer",
                fontSize: 12,
              }}
            >
              {saving ? "Saving..." : "Save Format"}
            </button>
          ) : null}
          <button
            onClick={onClose}
            style={{
              height: 28,
              padding: "0 12px",
              background: theme.bg.input,
              color: theme.text.primary,
              border: `1px solid ${theme.border.divider}`,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </DialogShell>

      {confirmDeleteId !== null && (
        <ConfirmDialog
          title="Delete Merchant"
          body="This removes the merchant's saved CSV format. This cannot be undone.\n\nContinue?"
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void handleDelete(confirmDeleteId)}
        />
      )}
    </>
  );
}
