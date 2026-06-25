import { useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import type { WorkbookRevisionDto } from "../store/appStore";

const TOTAL_FORMAT = new Intl.NumberFormat("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

function WorkbookRow({
  revision,
  isActive,
  canDelete,
  onSelect,
  onRename,
  onDelete,
  onCopy,
}: {
  revision: WorkbookRevisionDto;
  isActive: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(revision.name);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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

  const menuItems: ContextMenuItem[] = [
    { label: "Copy Workbook", action: onCopy },
    { label: "Rename", action: () => { setDraft(revision.name); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); } },
    ...(canDelete ? [{ label: "Delete", danger: true, action: onDelete }] : []),
  ];

  return (
    <div
      onClick={() => { if (!editing) onSelect(); }}
      onDoubleClick={() => { setDraft(revision.name); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      style={{
        display: "flex",
        alignItems: "center",
        height: theme.rowHeight,
        paddingLeft: theme.treeIndent + 4,
        paddingRight: 4,
        gap: 4,
        cursor: "pointer",
        background: isActive ? theme.bg.active : "transparent",
        color: theme.text.primary,
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      <Icon name="description" size={14} />

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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

export function WorkbookSidebarPane() {
  const workbooks = useAppStore((s) => s.workbooks);
  const activeRevisionId = useAppStore((s) => s.activeRevisionId);
  const setActiveRevisionId = useAppStore((s) => s.setActiveRevisionId);
  const renameWorkbookRevision = useAppStore((s) => s.renameWorkbookRevision);
  const deleteWorkbookRevision = useAppStore((s) => s.deleteWorkbookRevision);
  const copyWorkbookRevision = useAppStore((s) => s.copyWorkbookRevision);
  const createWorkbookRevision = useAppStore((s) => s.createWorkbookRevision);

  const allRevisions = workbooks.flatMap((wb) => wb.revisions.map((rev) => ({ rev, workbookId: wb.id })));

  function handleNewWorkbook() {
    if (workbooks.length > 0) {
      const wb = workbooks[0];
      const nextNum = wb.revisions.length + 1;
      createWorkbookRevision(wb.id, `Workbook ${nextNum}`);
    }
  }

  async function handleDelete(rev: WorkbookRevisionDto) {
    if (allRevisions.length <= 1) {
      return; // Don't allow deleting the last workbook
    }
    await deleteWorkbookRevision(rev.id);
  }

  async function handleCopy(rev: WorkbookRevisionDto) {
    await copyWorkbookRevision(rev.id, `${rev.name} (Copy)`);
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
          title="New Workbook"
          onClick={handleNewWorkbook}
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

      {/* List */}
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {allRevisions.map(({ rev }) => (
          <WorkbookRow
            key={rev.id}
            revision={rev}
            isActive={rev.id === activeRevisionId}
            canDelete={allRevisions.length > 1}
            onSelect={() => setActiveRevisionId(rev.id)}
            onRename={(name) => renameWorkbookRevision(rev.id, name)}
            onDelete={() => handleDelete(rev)}
            onCopy={() => handleCopy(rev)}
          />
        ))}
      </div>
    </div>
  );
}
