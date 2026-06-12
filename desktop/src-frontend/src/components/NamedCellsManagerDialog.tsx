import { useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";
import { ConfirmDialog } from "./ConfirmDialog";
import { TextInputDialog } from "./TextInputDialog";

export interface NamedCellEntry {
  name: string;
  path: string;
  ref: string;
}

interface NamedCellsManagerDialogProps {
  entries: NamedCellEntry[];
  isValidName: (name: string) => boolean;
  onClose: () => void;
  onGoTo: (name: string) => void;
  onRename: (oldName: string, newName: string) => void;
  onDelete: (name: string) => void;
}

/** Excel-style "Name Manager" for workbook named cells: lists every name bound in
 *  this revision (with its sheet path and cell reference) and lets the user jump
 *  to the bound cell, rename the binding, or delete it entirely. */
export function NamedCellsManagerDialog({ entries, isValidName, onClose, onGoTo, onRename, onDelete }: NamedCellsManagerDialogProps) {
  const [selectedName, setSelectedName] = useState<string | null>(entries[0]?.name ?? null);
  const [renaming, setRenaming] = useState(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);

  const selected = entries.find((e) => e.name === selectedName) ?? null;

  return createPortal(
    <>
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1240,
          display: "grid",
          placeItems: "center",
          background: "rgba(0, 0, 0, 0.45)",
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          style={{
            width: 560,
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
              background: theme.bg.ribbon,
              borderBottom: `1px solid ${theme.border.subtle}`,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Named Cells
          </div>

          <div style={{ padding: 12, display: "flex", gap: 12 }}>
            {/* Named cell list */}
            <div style={{ width: 260, flexShrink: 0 }}>
              <div
                style={{
                  height: 220,
                  overflow: "auto",
                  border: `1px solid ${theme.border.subtle}`,
                  background: theme.bg.shell,
                }}
              >
                {entries.length === 0 ? (
                  <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No named cells yet</div>
                ) : (
                  entries.map((e) => (
                    <button
                      key={e.name}
                      onClick={() => setSelectedName(e.name)}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        width: "100%",
                        height: 26,
                        padding: "0 8px",
                        border: "none",
                        background: e.name === selectedName ? theme.bg.active : "transparent",
                        color: e.name === selectedName ? "#FFFFFF" : theme.text.primary,
                        textAlign: "left",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                      <span
                        style={{
                          marginLeft: "auto",
                          flexShrink: 0,
                          fontSize: 11,
                          color: e.name === selectedName ? "#FFFFFF" : theme.text.secondary,
                        }}
                      >
                        {e.path}!{e.ref}
                      </span>
                    </button>
                  ))
                )}
              </div>
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
                      onClick={() => setConfirmDeleteName(selected.name)}
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

                  <div style={{ fontSize: 11, color: theme.text.secondary, marginBottom: 16 }}>
                    Bound to <strong>{selected.ref}</strong> on <strong>{selected.path}</strong>
                  </div>

                  <button
                    onClick={() => onGoTo(selected.name)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                      height: 30, padding: "0 12px",
                      background: theme.bg.active, color: "#FFFFFF",
                      border: `1px solid ${theme.accent}`, cursor: "pointer", fontSize: 12,
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>my_location</span>
                    Go to
                  </button>
                </>
              ) : (
                <div style={{ color: theme.text.secondary, fontSize: 12, padding: 8 }}>
                  No named cell selected. Right-click a cell and choose "New Named Cell…" to create one.
                </div>
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
        </div>
      </div>

      {renaming && selected && (
        <TextInputDialog
          title="Rename Named Cell"
          label="Name"
          initialValue={selected.name}
          confirmLabel="Rename"
          onCancel={() => setRenaming(false)}
          onConfirm={(value) => {
            const newName = value.trim();
            setRenaming(false);
            if (newName === selected.name) return;
            if (!isValidName(newName)) {
              window.alert(
                `"${newName}" isn't a valid name. Names must start with a letter or underscore, ` +
                `contain only letters, digits, underscores or periods, and must not look like a cell reference (e.g. A1).`,
              );
              return;
            }
            if (entries.some((e) => e.name === newName)) {
              window.alert(`A named cell called "${newName}" already exists.`);
              return;
            }
            setSelectedName(newName);
            onRename(selected.name, newName);
          }}
        />
      )}

      {confirmDeleteName !== null && (
        <ConfirmDialog
          title="Delete Named Cell"
          body={`This permanently removes the name "${confirmDeleteName}" from this workbook. Any formulas that reference it will start showing an error. This cannot be undone.\n\nContinue?`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDeleteName(null)}
          onConfirm={() => {
            const name = confirmDeleteName;
            setConfirmDeleteName(null);
            if (selectedName === name) setSelectedName(null);
            onDelete(name);
          }}
        />
      )}
    </>,
    document.body,
  );
}
