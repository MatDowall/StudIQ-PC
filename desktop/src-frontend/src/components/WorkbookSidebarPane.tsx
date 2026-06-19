import { useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import type { WorkbookDto, WorkbookRevisionDto } from "../store/appStore";

const TOTAL_FORMAT = new Intl.NumberFormat("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const KIND_ICONS = {
  workbook: "folder_open",
  revision: "history",
} as const;

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, lineHeight: 1, userSelect: "none", flexShrink: 0 }}
    >
      {name}
    </span>
  );
}

function RevisionRow({
  revision,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  revision: WorkbookRevisionDto;
  isActive: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(revision.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectTotal = revision.project_total;

  function commitRename() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== revision.name) {
      onRename(trimmed);
    } else {
      setDraft(revision.name);
    }
    setEditing(false);
  }

  return (
    <div
      onClick={() => { if (!editing) onSelect(); }}
      onDoubleClick={() => { setDraft(revision.name); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }}
      style={{
        display: "flex",
        alignItems: "center",
        height: theme.rowHeight,
        paddingLeft: theme.treeIndent * 2 + 4,
        paddingRight: 4,
        gap: 4,
        cursor: "pointer",
        background: isActive ? theme.bg.active : "transparent",
        color: theme.text.primary,
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {/* indent spacer */}
      <span style={{ width: 14, flexShrink: 0 }} />

      <Icon name={KIND_ICONS.revision} size={14} />

      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { setDraft(revision.name); setEditing(false); }
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            fontSize: 12,
            background: theme.bg.input,
            border: `1px solid ${theme.accent}`,
            color: theme.text.primary,
            padding: "0 2px",
            outline: "none",
          }}
        />
      ) : (
        <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {revision.name}
        </span>
      )}

      {projectTotal != null && !editing && (
        <span
          title="Project total"
          style={{
            fontSize: 11,
            color: theme.text.secondary,
            flexShrink: 0,
            fontVariantNumeric: "tabular-nums",
            marginRight: 2,
          }}
        >
          {TOTAL_FORMAT.format(projectTotal)}
        </span>
      )}

      {isActive && !editing && (
        <button
          title="Delete revision"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{
            background: "none",
            border: "none",
            color: theme.text.secondary,
            cursor: "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <Icon name="delete" size={14} />
        </button>
      )}
    </div>
  );
}

function WorkbookRow({ workbook }: { workbook: WorkbookDto }) {
  const [expanded, setExpanded] = useState(true);
  const activeRevisionId = useAppStore((s) => s.activeRevisionId);
  const setActiveRevisionId = useAppStore((s) => s.setActiveRevisionId);
  const createWorkbookRevision = useAppStore((s) => s.createWorkbookRevision);
  const deleteWorkbookRevision = useAppStore((s) => s.deleteWorkbookRevision);
  const renameWorkbookRevision = useAppStore((s) => s.renameWorkbookRevision);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const hasRevisions = workbook.revisions.length > 0;

  async function handleDelete(rev: WorkbookRevisionDto) {
    if (workbook.revisions.length <= 1) {
      return; // Don't allow deleting the last revision
    }
    await deleteWorkbookRevision(rev.id);
  }

  async function commitAdd() {
    const trimmed = newName.trim();
    if (trimmed) {
      await createWorkbookRevision(workbook.id, trimmed);
    }
    setNewName("");
    setAdding(false);
  }

  return (
    <>
      {/* Workbook header row */}
      <div
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          height: theme.rowHeight,
          paddingLeft: theme.treeIndent + 4,
          paddingRight: 4,
          gap: 4,
          cursor: "pointer",
          color: theme.text.primary,
          userSelect: "none",
          flexShrink: 0,
        }}
      >
        <span style={{ width: 14, fontSize: 12, lineHeight: 1, color: hasRevisions ? theme.text.secondary : "transparent", textAlign: "center", flexShrink: 0 }}>
          {hasRevisions ? (expanded ? "▾" : "▸") : ""}
        </span>
        <Icon name={KIND_ICONS.workbook} size={14} />
        <span style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
          {workbook.name}
        </span>
      </div>

      {/* Revisions */}
      {expanded && workbook.revisions.map((rev) => (
        <RevisionRow
          key={rev.id}
          revision={rev}
          isActive={rev.id === activeRevisionId}
          onSelect={() => setActiveRevisionId(rev.id)}
          onRename={(name) => renameWorkbookRevision(rev.id, name)}
          onDelete={() => handleDelete(rev)}
        />
      ))}

      {/* Inline new-revision input */}
      {expanded && adding && (
        <div style={{ display: "flex", alignItems: "center", height: theme.rowHeight, paddingLeft: theme.treeIndent * 2 + 4 + 14 + 4, paddingRight: 4, gap: 4, flexShrink: 0 }}>
          <Icon name={KIND_ICONS.revision} size={14} />
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={commitAdd}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAdd();
              if (e.key === "Escape") { setNewName(""); setAdding(false); }
            }}
            placeholder="Revision name…"
            style={{
              flex: 1,
              fontSize: 12,
              background: theme.bg.input,
              border: `1px solid ${theme.accent}`,
              color: theme.text.primary,
              padding: "0 2px",
              outline: "none",
            }}
          />
        </div>
      )}
    </>
  );
}

export function WorkbookSidebarPane() {
  const workbooks = useAppStore((s) => s.workbooks);
  const createWorkbookRevision = useAppStore((s) => s.createWorkbookRevision);

  function handleNewRevision() {
    if (workbooks.length > 0) {
      // Trigger inline add on the first (only) workbook via a synthetic approach:
      // We rely on the WorkbookRow's own "adding" state — but since that's internal,
      // the header button uses a store action directly with a generated name.
      const wb = workbooks[0];
      const nextNum = wb.revisions.length + 1;
      createWorkbookRevision(wb.id, `Revision ${nextNum}`);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: theme.bg.pane,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 8px",
          height: 28,
          borderBottom: `1px solid ${theme.border.divider}`,
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, color: theme.text.secondary, letterSpacing: "0.04em" }}>
          WORKBOOKS
        </span>
        <button
          title="New Revision"
          onClick={handleNewRevision}
          disabled={workbooks.length === 0}
          style={{
            background: "none",
            border: "none",
            color: workbooks.length === 0 ? theme.text.disabled : theme.text.primary,
            cursor: workbooks.length === 0 ? "not-allowed" : "pointer",
            padding: 0,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Icon name="add" size={16} />
        </button>
      </div>

      {/* Tree */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {workbooks.map((wb) => (
          <WorkbookRow key={wb.id} workbook={wb} />
        ))}
      </div>
    </div>
  );
}
