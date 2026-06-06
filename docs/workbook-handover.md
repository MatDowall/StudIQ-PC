# Workbook Feature — Handover Document

This document tracks the architecture, milestones, and implementation state of the
**Workbook** feature in StudIQ. Update it as each milestone is completed.

---

## Overview

The Workbook is a CostX-style cost-estimate view. Dimension groups (with their measured
quantities) are dragged from the Dimension Groups pane into a Workbook spreadsheet, where
they become priced line-items. Multiple workbooks can exist per project (under named
revisions), enabling alternative estimates or scope variations.

The Workbook lives behind its own tab ("Workbook") next to the existing "Dimensions" tab.
The two workflows share the same left-sidebar Dimension Groups pane (bottom half) so
dimension groups can be dragged into the active workbook at any time.

---

## Architecture

### Tab switching (`activeTab` in Zustand store)

`appStore.ts` holds `activeTab: "dimensions" | "workbook"`. Any component that needs to
know the active context reads this field; none receive it as a prop.

### Lazy-mount performance strategy

`App.tsx` tracks `workbookEverVisited` via a `useRef` (not state, so it never triggers a
re-render). The first time the user switches to the Workbook tab the flag flips to `true`
and `WorkbookView` is mounted. After that it remains mounted but is hidden with
`display: none` while the Dimensions tab is active.

The `Viewer` (canvas, tile cache, pan/zoom state) is similarly always mounted once a project
is open and hidden with `display: none` while in Workbook mode. This means:

- Switching tabs is instantaneous — no re-mount, no tile reload.
- Workbook data fetching (future Tauri invoke calls) happens only while in the Workbook tab.
- There is no concurrent rendering pressure from both views at once.

### Left-column switching

`LeftColumn.tsx` reads `activeTab` and renders:

| Tab | Top pane | Bottom pane |
|---|---|---|
| Dimensions | `DrawingRegisterPane` | `DimensionGroupPane` |
| Workbook | `WorkbookSidebarPane` | `DimensionGroupPane` |

The bottom pane (`DimensionGroupPane`) always stays so dimension groups are drag-accessible
from either workflow.

### Ribbon switching

`Ribbon.tsx` reads `activeTab` and swaps the button-group area between the full
Dimensions ribbon (Add, Properties, Copy, Type, Drawing, Snap) and `WorkbookRibbon`
(dummy buttons). The project-info bar on the right always persists.

---

## Component map

| File | Purpose |
|---|---|
| `components/WorkbookRibbon.tsx` | Workbook-specific ribbon buttons (all dummy for now) |
| `components/WorkbookSidebarPane.tsx` | Revision/workbook tree in the left sidebar (top half) |
| `components/WorkbookView.tsx` | Main spreadsheet content area (placeholder) |
| `store/appStore.ts` | `activeTab` + `setActiveTab` |
| `App.tsx` | Tab bar UI, lazy-mount logic, `display:none` switching |
| `LeftColumn.tsx` | Tab-aware top-pane rendering |
| `Ribbon.tsx` | Tab-aware ribbon button groups |

---

## Milestones

### Milestone 1 — Tab shell & environment ✅ COMPLETE (2026-06-06)

**Goal:** Split the app into Dimensions and Workbook workflows without breaking
existing functionality. No real workbook data yet.

**Delivered:**
- Tab bar above ribbon (28 px, spans full width, accent-underline on active tab)
- `activeTab` field in Zustand store
- `WorkbookRibbon` with six groups of disabled dummy buttons
- `WorkbookSidebarPane` — CostX-style revision tree with dummy data
  (Estimate → Revision 1 → Trade Estimate)
- `WorkbookView` — spreadsheet skeleton with column headers (expand / Name / Total)
  and a single dummy "Trade Estimate" row
- Viewer kept alive (display:none) behind Workbook tab — no canvas/tile state lost
- WorkbookView lazily mounted on first Workbook visit

**Gate:** App builds and runs; switching tabs changes ribbon, left-pane top half, and main
area without errors or performance regression in the Dimensions workflow. ✅ Passed.

**Post-ship fix — Viewer canvas height regression:**
Wrapping `<Viewer />` inside `position: absolute; inset: 0; display: block` caused the
canvas to collapse to ~1px because Viewer's root `flex` div has no explicit height — it
relied on the browser stretching it as a grid item. Fix: added `height: "100%"` to
Viewer's root div (`Viewer.tsx:96`). This chains the height back up through the inset
wrapper to the grid row and is robust regardless of what display context holds the Viewer.

---

### Milestone 2 — Workbook DB schema & revision CRUD (planned)

**Goal:** Persist workbook revisions in the project `.tcop` SQLite file.

**Planned work:**
- New tables: `workbooks`, `workbook_revisions`, `workbook_items`
- Tauri commands: `list_workbook_revisions`, `create_workbook_revision`,
  `delete_workbook_revision`, `rename_workbook_revision`
- `WorkbookSidebarPane` wired to real data (replace dummy tree)
- "New Revision" button in sidebar and ribbon enabled

---

### Milestone 3 — Workbook spreadsheet (row model)

**Goal:** A real spreadsheet view inside `WorkbookView`.

**Planned work:**
- Virtual-scroll grid (column headers sticky; rows scrollable)
- Columns: expand | Name | Unit | Quantity | Rate | Amount | Notes
- Folder rows collapsible
- Keyboard navigation (arrow keys, Tab, Enter to edit)

---

### Milestone 4 — Drag dimension groups into workbook

**Goal:** Drag a dimension group from the left-sidebar pane onto the workbook, creating
a priced row with the group's live quantity.

**Planned work:**
- HTML drag-and-drop from `DimensionGroupPane` rows
- Drop target in `WorkbookView` grid
- On drop: insert a `workbook_item` row linked to the dimension group
- Live quantity sync: workbook row quantity updates when the group's measurements change

**CLAUDE.md note (to add when done):** Each distinct framing size in a framing group must
produce its own row (see "Workbook implication" section of CLAUDE.md).

---

### Milestone 5 — Rate entry & totalling

**Goal:** Enter unit rates; compute row amounts and folder/workbook totals.

**Planned work:**
- Inline rate cell editing
- Amount = quantity × rate
- Folder subtotals roll up to workbook total
- Workbook total shown in `WorkbookSidebarPane` beside the revision name

---

### Milestone 6 — Multiple workbooks & revision management

**Goal:** Create, rename, delete, and duplicate workbook revisions; compare totals
between revisions.

---

### Milestone 7 — Export

**Goal:** Export the active workbook to Excel (.xlsx) and/or PDF.

---

## Data model (target schema — subject to change)

```sql
CREATE TABLE workbooks (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL,  -- always 1 in single-project files
    name        TEXT NOT NULL DEFAULT 'Estimate'
);

CREATE TABLE workbook_revisions (
    id          INTEGER PRIMARY KEY,
    workbook_id INTEGER NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workbook_items (
    id              INTEGER PRIMARY KEY,
    revision_id     INTEGER NOT NULL REFERENCES workbook_revisions(id) ON DELETE CASCADE,
    parent_id       INTEGER REFERENCES workbook_items(id) ON DELETE CASCADE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    item_type       TEXT NOT NULL CHECK(item_type IN ('folder', 'line')),
    name            TEXT NOT NULL,
    -- link to dimension group (null for manually-entered rows)
    dimension_group_id INTEGER REFERENCES tree_nodes(id) ON DELETE SET NULL,
    -- for framing groups, the specific framing size this row tracks (null = all / non-framing)
    framing_size    TEXT,
    unit            TEXT,
    quantity        REAL,
    rate            REAL,
    notes           TEXT
);
```

---

## Notes & decisions

- `workbookEverVisited` is a `useRef` (not state) in `App.tsx` so it never triggers an
  extra render cycle when the user first clicks Workbook.
- `display: none` (not `visibility: hidden`) is used for inactive views — this is important
  because `visibility: hidden` still participates in layout and can cause the Viewer canvas
  to report incorrect dimensions.
- The DimensionGroupPane remains visible in both tabs — this is intentional (CostX model).
- Future workbook-specific Tauri commands should be namespaced `workbook_*` to avoid
  collision with dimension/drawing commands.
