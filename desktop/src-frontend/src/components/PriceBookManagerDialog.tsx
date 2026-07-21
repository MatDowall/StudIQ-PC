import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { theme } from "../theme";
import { DialogShell } from "./DialogShell";
import { MerchantManagerDialog } from "./MerchantManagerDialog";
import type { MerchantDto, PriceBookImportDto } from "./RateLibraryPane";

interface Props {
  onClose: () => void;
}

const HISTORY_GRID = "1fr 110px 110px 90px 70px 150px";

export function PriceBookManagerDialog({ onClose }: Props) {
  const [imports, setImports] = useState<PriceBookImportDto[]>([]);
  const [merchants, setMerchants] = useState<MerchantDto[]>([]);
  const [selectedMerchantId, setSelectedMerchantId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managingMerchants, setManagingMerchants] = useState(false);

  async function refreshImports() {
    setLoading(true);
    try {
      const rows = await invoke<PriceBookImportDto[]>("list_price_book_imports");
      setImports(rows);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshMerchants() {
    try {
      const rows = await invoke<MerchantDto[]>("list_price_book_merchants");
      setMerchants(rows);
      setSelectedMerchantId((current) => {
        if (current != null && rows.some((m) => m.id === current)) return current;
        return rows[0]?.id ?? null;
      });
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    void refreshImports();
    void refreshMerchants();
  }, []);

  async function handleUpload() {
    if (selectedMerchantId == null) return;
    setError(null);
    const selected = await open({
      filters: [{ name: "Price Book CSV", extensions: ["csv"] }],
      multiple: false,
    });
    if (!selected || typeof selected !== "string") return;
    setUploading(true);
    try {
      await invoke("import_price_book", { path: selected, merchantId: selectedMerchantId });
      await refreshImports();
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
    }
  }

  const current = imports.find((i) => i.is_current) ?? null;

  return (
    <>
      <DialogShell title="Rate Library — Manage Price Books" width={700} zIndex={1240} onClose={onClose}>
        <div style={{ padding: 12 }}>
          <div
            style={{
              padding: "8px 10px",
              marginBottom: 10,
              background: theme.bg.shell,
              border: `1px solid ${theme.border.subtle}`,
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              {current ? (
                <>
                  <div style={{ fontWeight: 600, color: theme.text.primary }}>
                    Current: {current.merchant_name ?? current.price_book_name ?? "Price book"} — {current.account_name}
                    {current.branch_code ? ` (${current.branch_code})` : ""}
                  </div>
                  <div style={{ color: theme.text.secondary, marginTop: 2 }}>
                    CSV ingest date {current.download_date} · {current.row_count} items · uploaded {current.imported_at}
                  </div>
                </>
              ) : (
                <div style={{ color: theme.text.secondary }}>No price book uploaded yet</div>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ fontSize: 12, color: theme.text.secondary, flexShrink: 0 }}>Merchant format:</label>
              <select
                value={selectedMerchantId ?? ""}
                onChange={(event) => setSelectedMerchantId(event.target.value ? Number(event.target.value) : null)}
                style={{
                  flex: 1,
                  height: 26,
                  padding: "0 6px",
                  background: theme.bg.input,
                  color: theme.text.primary,
                  border: `1px solid ${theme.border.divider}`,
                  fontSize: 12,
                }}
              >
                {merchants.length === 0 ? <option value="">No merchants configured</option> : null}
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setManagingMerchants(true)}
                style={{
                  height: 26,
                  padding: "0 8px",
                  background: theme.bg.input,
                  color: theme.text.primary,
                  border: `1px solid ${theme.border.divider}`,
                  cursor: "pointer",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                Manage Merchants...
              </button>
              <button
                onClick={() => void handleUpload()}
                disabled={uploading || selectedMerchantId == null}
                title={selectedMerchantId == null ? "Add a merchant format first" : undefined}
                style={{
                  height: 26,
                  padding: "0 12px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: theme.bg.input,
                  color: selectedMerchantId == null ? theme.text.disabled : theme.text.primary,
                  border: `1px solid ${theme.border.divider}`,
                  cursor: uploading || selectedMerchantId == null ? "default" : "pointer",
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload_file</span>
                {uploading ? "Uploading..." : "Upload..."}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ padding: "6px 10px", marginBottom: 10, color: theme.danger, fontSize: 12, border: `1px solid ${theme.danger}`, whiteSpace: "pre-wrap" }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 12, color: theme.text.secondary, marginBottom: 6 }}>Ingest history</div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: HISTORY_GRID,
              height: 24,
              background: theme.bg.shell,
              border: `1px solid ${theme.border.subtle}`,
              borderBottom: "none",
              fontSize: 11,
              color: theme.text.secondary,
              alignItems: "center",
            }}
          >
            <div style={{ padding: "0 8px" }}>File / Price Book</div>
            <div style={{ padding: "0 8px" }}>Merchant</div>
            <div style={{ padding: "0 8px" }}>CSV Ingest Date</div>
            <div style={{ padding: "0 8px" }}>Rows</div>
            <div style={{ padding: "0 8px" }}>Current</div>
            <div style={{ padding: "0 8px" }}>Uploaded</div>
          </div>
          <div style={{ maxHeight: 260, overflow: "auto", border: `1px solid ${theme.border.subtle}` }}>
            {loading ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>Loading...</div>
            ) : imports.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No ingests yet</div>
            ) : (
              imports.map((imp) => (
                <div
                  key={imp.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: HISTORY_GRID,
                    minHeight: 24,
                    alignItems: "center",
                    fontSize: 12,
                    background: imp.is_current ? theme.bg.active : "transparent",
                    color: theme.text.primary,
                    borderTop: `1px solid ${theme.border.subtle}`,
                  }}
                >
                  <div style={{ padding: "2px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={imp.source_filename}>
                    {imp.price_book_name || imp.source_filename}
                  </div>
                  <div style={{ padding: "2px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {imp.merchant_name ?? "—"}
                  </div>
                  <div style={{ padding: "2px 8px" }}>{imp.download_date}</div>
                  <div style={{ padding: "2px 8px" }}>{imp.row_count}</div>
                  <div style={{ padding: "2px 8px" }}>{imp.is_current ? "✓" : ""}</div>
                  <div style={{ padding: "2px 8px", color: theme.text.secondary }}>{imp.imported_at}</div>
                </div>
              ))
            )}
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

      {managingMerchants ? (
        <MerchantManagerDialog
          onClose={() => setManagingMerchants(false)}
          onChanged={() => void refreshMerchants()}
        />
      ) : null}
    </>
  );
}
