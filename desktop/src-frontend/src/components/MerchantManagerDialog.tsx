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
const NOT_USED = "";

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

function fieldLabel(key: string): string {
  return PRICE_BOOK_FIELDS.find((f) => f.key === key)?.label ?? key;
}

export function MerchantManagerDialog({ onClose, onChanged }: Props) {
  const [merchants, setMerchants] = useState<MerchantDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  // null = no sample loaded yet this editing session (nothing to detect columns from);
  // [] = a sample was loaded but its header row was empty.
  const [detectedHeaders, setDetectedHeaders] = useState<string[] | null>(null);
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
    setDetectedHeaders(null);
  }

  function startNew() {
    setError(null);
    setDraft(blankDraft());
    setDetectedHeaders(null);
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

  /** What canonical field (if any) a given detected CSV column is currently assigned to
   *  represent. Each header can represent at most one field. */
  function roleForHeader(draft: Draft, header: string): string {
    return PRICE_BOOK_FIELDS.find((f) => draft.columnMap[f.key] === header)?.key ?? NOT_USED;
  }

  /** Assigns `header` to represent `fieldKey` (or un-assigns it if fieldKey is empty),
   *  first clearing out any other field that was previously pointing at this same header
   *  — a single CSV column can only mean one thing, so re-assigning it here is what
   *  causes its old role's row to flip back to "Not used". */
  function assignHeader(header: string, fieldKey: string) {
    if (!draft) return;
    const nextMap = { ...draft.columnMap };
    for (const key of Object.keys(nextMap)) {
      if (nextMap[key] === header) delete nextMap[key];
    }
    if (fieldKey) nextMap[fieldKey] = header;
    setDraft({ ...draft, columnMap: nextMap });
  }

  const savedMappingEntries = draft
    ? Object.entries(draft.columnMap).filter(([, header]) => header.trim() !== "")
    : [];
  const canSave =
    !!draft && draft.name.trim() !== "" && !!draft.columnMap.description && !!draft.columnMap.unit_price;

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
      <DialogShell title="Manage Merchants" width={640} zIndex={1260} onClose={onClose}>
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
                  {detectedHeaders === null ? "Load Sample CSV..." : "Load a Different Sample CSV..."}
                </button>

                {detectedHeaders === null ? (
                  <>
                    <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 8 }}>
                      Load a sample of this merchant's price book so StudIQ can read its actual column
                      names — nothing is assumed about how this merchant lays out its CSV. Only
                      Description and Unit Price will be required; everything else (including
                      Category/Group/Sub Group) is only assigned if this merchant's file actually has it.
                    </div>
                    {savedMappingEntries.length > 0 ? (
                      <div style={{ fontSize: 12, border: `1px solid ${theme.border.subtle}`, padding: 8 }}>
                        <div style={{ color: theme.text.secondary, marginBottom: 4 }}>Current saved mapping:</div>
                        {savedMappingEntries.map(([key, header]) => (
                          <div key={key} style={{ color: theme.text.primary }}>
                            {fieldLabel(key)} → "{header}"
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : detectedHeaders.length === 0 ? (
                  <div style={{ fontSize: 12, color: theme.danger }}>No columns were detected in that file.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 6 }}>
                      For each column this merchant's CSV actually has, choose what it represents. Leave
                      "Not used" for anything that doesn't apply (e.g. this merchant has no Category).
                    </div>
                    <div style={{ maxHeight: 280, overflow: "auto" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", rowGap: 6, columnGap: 8, alignItems: "center" }}>
                        <div style={{ fontSize: 11, color: theme.text.disabled }}>CSV column</div>
                        <div style={{ fontSize: 11, color: theme.text.disabled }}>Represents</div>
                        {detectedHeaders.map((header) => {
                          const role = roleForHeader(draft, header);
                          return (
                            <div key={header} style={{ display: "contents" }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: theme.text.primary,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                                title={header}
                              >
                                {header}
                              </div>
                              <select
                                value={role}
                                onChange={(event) => assignHeader(header, event.target.value)}
                                style={{
                                  height: 24,
                                  background: theme.bg.input,
                                  color: theme.text.primary,
                                  border: `1px solid ${theme.border.divider}`,
                                  fontSize: 12,
                                }}
                              >
                                <option value={NOT_USED}>— Not used —</option>
                                {PRICE_BOOK_FIELDS.map((field) => (
                                  <option key={field.key} value={field.key}>
                                    {field.label}
                                    {field.required ? " *" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </>
                )}
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
              disabled={saving || !canSave}
              title={!canSave ? "Name, and a column mapped to Description and Unit Price, are required" : undefined}
              style={{
                height: 28,
                padding: "0 12px",
                background: theme.bg.active,
                color: canSave ? theme.text.primary : theme.text.disabled,
                border: `1px solid ${theme.accent}`,
                cursor: saving || !canSave ? "default" : "pointer",
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
          body="This deletes the merchant's saved CSV format AND its entire rate library — every price book ever uploaded for it, including its current one. This cannot be undone.\n\nContinue?"
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => void handleDelete(confirmDeleteId)}
        />
      )}
    </>
  );
}
