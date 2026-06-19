import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogShell } from "./DialogShell";
import { NewTemplateDialog } from "./NewTemplateDialog";
import { TextInputDialog } from "./TextInputDialog";

export function TemplateManagerDialog() {
  const templates = useAppStore((s) => s.templates);
  const closeTemplateManager = useAppStore((s) => s.closeTemplateManager);
  const createTemplate = useAppStore((s) => s.createTemplate);
  const renameTemplate = useAppStore((s) => s.renameTemplate);
  const updateTemplateDescription = useAppStore((s) => s.updateTemplateDescription);
  const deleteTemplate = useAppStore((s) => s.deleteTemplate);
  const exportTemplate = useAppStore((s) => s.exportTemplate);
  const importTemplate = useAppStore((s) => s.importTemplate);
  const enterTemplateEdit = useAppStore((s) => s.enterTemplateEdit);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  useEffect(() => {
    setDescription(selected?.description ?? "");
  }, [selected?.id, selected?.description]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !creating && !renaming && confirmDeleteId === null) closeTemplateManager();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeTemplateManager, confirmDeleteId, creating, renaming]);

  function handleSaveDescription() {
    if (selected && description.trim() !== (selected.description ?? "")) {
      void updateTemplateDescription(selected.id, description);
    }
  }

  async function handleExport() {
    if (!selected) return;
    setError(null);
    const destPath = await save({
      defaultPath: `${selected.name}.sqtemplate`,
      filters: [{ name: "StudIQ Workbook Template", extensions: ["sqtemplate"] }],
    });
    if (!destPath) return;
    try {
      await exportTemplate(selected.id, destPath);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleImport() {
    setError(null);
    const srcPath = await open({
      filters: [{ name: "StudIQ Workbook Template", extensions: ["sqtemplate"] }],
      multiple: false,
    });
    if (!srcPath || typeof srcPath !== "string") return;
    try {
      await importTemplate(srcPath);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <>
      <DialogShell title="Template Manager" width={560} zIndex={1240} onClose={closeTemplateManager}>
        <div style={{ padding: 12, display: "flex", gap: 12 }}>
          {/* Template list */}
          <div style={{ width: 200, flexShrink: 0 }}>
            <div
              style={{
                height: 220,
                overflow: "auto",
                border: `1px solid ${theme.border.subtle}`,
                background: theme.bg.shell,
                marginBottom: 8,
              }}
            >
              {templates.length === 0 ? (
                <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No templates yet</div>
              ) : (
                templates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      height: 26,
                      padding: "0 8px",
                      border: "none",
                      background: t.id === selectedId ? theme.bg.active : "transparent",
                      color: t.id === selectedId ? "#FFFFFF" : theme.text.primary,
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: 12,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.name}
                  </button>
                ))
              )}
            </div>
            <button
              onClick={() => setCreating(true)}
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
                marginBottom: 6,
              }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              New Template
            </button>
            <button
              onClick={() => void handleImport()}
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
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
              Import...
            </button>
          </div>

          {/* Detail panel */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {selected ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ flex: 1, fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {selected.name}
                  </div>
                  <button
                    title="Export"
                    onClick={() => void handleExport()}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 28, height: 28, padding: 0,
                      background: theme.bg.input, color: theme.text.primary,
                      border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span>
                  </button>
                  <button
                    title="Rename"
                    onClick={() => setRenaming(true)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 28, height: 28, padding: 0,
                      background: theme.bg.input, color: theme.text.primary,
                      border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit</span>
                  </button>
                  <button
                    title="Delete"
                    onClick={() => setConfirmDeleteId(selected.id)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 28, height: 28, padding: 0,
                      background: theme.bg.input, color: theme.text.primary,
                      border: `1px solid ${theme.border.divider}`, cursor: "pointer",
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>

                <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 8 }}>
                  Created {selected.created_at}
                </div>

                <label style={{ display: "block", marginBottom: 4, color: theme.text.secondary, fontSize: 12 }}>Description</label>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  onBlur={handleSaveDescription}
                  rows={4}
                  style={{
                    boxSizing: "border-box",
                    width: "100%",
                    padding: "6px 8px",
                    background: theme.bg.input,
                    color: theme.text.primary,
                    border: `1px solid ${theme.border.divider}`,
                    outline: "none",
                    fontSize: 13,
                    fontFamily: "inherit",
                    resize: "vertical",
                    marginBottom: 12,
                  }}
                />

                <button
                  onClick={() => enterTemplateEdit(selected)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                    height: 30, padding: "0 12px",
                    background: theme.bg.active, color: "#FFFFFF",
                    border: `1px solid ${theme.accent}`, cursor: "pointer", fontSize: 12,
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>edit_document</span>
                  Edit Template
                </button>
              </>
            ) : (
              <div style={{ color: theme.text.secondary, fontSize: 12, padding: 8 }}>
                Select a template to view or edit its details, or create a new one.
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ padding: "0 12px 8px", color: theme.danger, fontSize: 12 }}>
            {error}
          </div>
        )}

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
            onClick={closeTemplateManager}
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

      {creating && (
        <NewTemplateDialog
          onCancel={() => setCreating(false)}
          onConfirm={(name, desc) => {
            setCreating(false);
            void createTemplate(name, desc);
          }}
        />
      )}

      {renaming && selected && (
        <TextInputDialog
          title="Rename Template"
          label="Name"
          initialValue={selected.name}
          confirmLabel="Rename"
          onCancel={() => setRenaming(false)}
          onConfirm={(value) => {
            setRenaming(false);
            void renameTemplate(selected.id, value);
          }}
        />
      )}

      {confirmDeleteId !== null && (
        <ConfirmDialog
          title="Delete Template"
          body="This permanently deletes the template and all of its sheet data. This cannot be undone.\n\nContinue?"
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => {
            const id = confirmDeleteId;
            setConfirmDeleteId(null);
            if (selectedId === id) setSelectedId(null);
            void deleteTemplate(id);
          }}
        />
      )}
    </>
  );
}
