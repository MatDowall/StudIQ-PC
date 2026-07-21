import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { theme } from "../theme";
import { PriceBookManagerDialog } from "./PriceBookManagerDialog";

export const RATE_ITEM_DRAG_MIME = "application/x-studiq-rate-item";

export interface PriceBookItemDto {
  id: number;
  product_category: string;
  group_name: string;
  sub_group: string;
  description: string;
  product_code: string;
  unit_of_sale: string;
  unit_price: number;
  effective_date: string;
}

export interface PriceBookImportDto {
  id: number;
  source_filename: string;
  price_book_name: string;
  account_number: string;
  account_name: string;
  branch_code: string;
  download_date: string;
  row_count: number;
  is_current: boolean;
  imported_at: string;
}

const ROW_GRID = "18px minmax(120px, 1fr) 56px 64px";

function currency(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ItemRow({ item }: { item: PriceBookItemDto }) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(
          RATE_ITEM_DRAG_MIME,
          JSON.stringify({
            code: item.product_code,
            description: item.description,
            unit: item.unit_of_sale,
            rate: item.unit_price,
          }),
        );
        event.dataTransfer.effectAllowed = "copy";
      }}
      title={`${item.description}${item.product_code ? ` (${item.product_code})` : ""} — drag into the workbook Rate column`}
      style={{
        display: "grid",
        gridTemplateColumns: ROW_GRID,
        alignItems: "center",
        minWidth: 320,
        height: theme.rowHeight,
        paddingLeft: theme.treeIndent * 3,
        color: theme.text.primary,
        cursor: "grab",
        fontSize: 12,
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 14, color: theme.text.secondary, flexShrink: 0 }}>
        sell
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", paddingRight: 6 }}>{item.description}</span>
      <span style={{ color: theme.text.secondary, overflow: "hidden", textOverflow: "ellipsis" }}>{item.unit_of_sale}</span>
      <span style={{ textAlign: "right", paddingRight: 6 }}>{currency(item.unit_price)}</span>
    </div>
  );
}

function ExpandRow({
  depth,
  label,
  expanded,
  onToggle,
  count,
}: {
  depth: number;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  count?: number;
}) {
  return (
    <div
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        minWidth: 320,
        height: theme.rowHeight,
        paddingLeft: theme.treeIndent * depth,
        color: theme.text.primary,
        cursor: "pointer",
        fontSize: 12,
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: 16, width: 18, flexShrink: 0, color: theme.text.secondary }}
      >
        {expanded ? "expand_more" : "chevron_right"}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {count != null ? (
        <span style={{ marginLeft: "auto", paddingRight: 6, color: theme.text.disabled }}>{count}</span>
      ) : null}
    </div>
  );
}

/** A "Group" node — the CSV's `Sub Group` column groups items directly under a Group in
 *  this price book (Group and Sub Group are frequently identical), so a Group expands
 *  straight to its distinct sub-groups, one level of drill-down each. */
function GroupNode({ category, group }: { category: string; group: string }) {
  const [expanded, setExpanded] = useState(false);
  const [subGroups, setSubGroups] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && subGroups === null && !loading) {
      setLoading(true);
      try {
        const rows = await invoke<string[]>("list_price_book_subgroups", { category, groupName: group });
        setSubGroups(rows);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <ExpandRow depth={1} label={group} expanded={expanded} onToggle={() => void toggle()} />
      {expanded && loading ? (
        <div style={{ paddingLeft: theme.treeIndent * 2, fontSize: 11, color: theme.text.secondary }}>Loading...</div>
      ) : null}
      {expanded && subGroups
        ? subGroups.map((sg) => <SubGroupLeaf key={sg} category={category} group={group} subGroup={sg} />)
        : null}
    </>
  );
}

function SubGroupLeaf({ category, group, subGroup }: { category: string; group: string; subGroup: string }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<PriceBookItemDto[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && items === null && !loading) {
      setLoading(true);
      try {
        const rows = await invoke<PriceBookItemDto[]>("list_price_book_items", {
          category,
          groupName: group,
          subGroup,
        });
        setItems(rows);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <ExpandRow depth={2} label={subGroup} expanded={expanded} onToggle={() => void toggle()} count={items?.length} />
      {expanded && loading ? (
        <div style={{ paddingLeft: theme.treeIndent * 3, fontSize: 11, color: theme.text.secondary }}>Loading...</div>
      ) : null}
      {expanded && items ? items.map((item) => <ItemRow key={item.id} item={item} />) : null}
    </>
  );
}

function CategoryNode({ category }: { category: string }) {
  const [expanded, setExpanded] = useState(false);
  const [groups, setGroups] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && groups === null && !loading) {
      setLoading(true);
      try {
        const rows = await invoke<string[]>("list_price_book_groups", { category });
        setGroups(rows);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <ExpandRow depth={0} label={category} expanded={expanded} onToggle={() => void toggle()} />
      {expanded && loading ? (
        <div style={{ paddingLeft: theme.treeIndent, fontSize: 11, color: theme.text.secondary }}>Loading...</div>
      ) : null}
      {expanded && groups ? groups.map((g) => <GroupNode key={g} category={category} group={g} />) : null}
    </>
  );
}

export function RateLibraryPane() {
  const [categories, setCategories] = useState<string[] | null>(null);
  const [currentBook, setCurrentBook] = useState<PriceBookImportDto | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PriceBookItemDto[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [status, setStatus] = useState("");
  const searchSeq = useRef(0);

  async function refresh() {
    setStatus("Loading price book...");
    try {
      const [book, cats] = await Promise.all([
        invoke<PriceBookImportDto | null>("get_current_price_book"),
        invoke<string[]>("list_price_book_categories"),
      ]);
      setCurrentBook(book);
      setCategories(cats);
      setStatus("");
    } catch (error) {
      setStatus(`ERROR: ${error}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const handle = setTimeout(() => {
      invoke<PriceBookItemDto[]>("search_price_book_items", { query: trimmed })
        .then((rows) => {
          if (searchSeq.current === seq) setSearchResults(rows);
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <section style={{ display: "flex", minHeight: 0, flexDirection: "column", background: theme.bg.pane }}>
      <div style={{ display: "flex", gap: 6, padding: 6, borderBottom: `1px solid ${theme.border.subtle}` }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search rate library..."
          style={{
            flex: 1,
            height: 24,
            padding: "0 8px",
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          onClick={() => setManagerOpen(true)}
          title="Upload a revised price book and review ingest history"
          style={{
            height: 24,
            padding: "0 8px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            background: theme.bg.input,
            color: theme.text.primary,
            border: `1px solid ${theme.border.divider}`,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>upload_file</span>
          Manage
        </button>
      </div>

      <div
        style={{
          padding: "4px 8px",
          borderBottom: `1px solid ${theme.border.subtle}`,
          color: theme.text.secondary,
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {currentBook
          ? `${currentBook.price_book_name || "Price book"} — ingested ${currentBook.download_date} (${currentBook.row_count} items)`
          : "No price book uploaded yet"}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: ROW_GRID, minWidth: 320, height: 24, borderBottom: `1px solid ${theme.border.subtle}`, background: theme.bg.shell, color: theme.text.primary, fontSize: 12 }}>
        <div />
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px" }}>Description</div>
        <div style={{ display: "flex", alignItems: "center", padding: "0 6px" }}>Unit</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", padding: "0 6px" }}>Rate</div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", paddingTop: 2 }}>
        {status ? <div style={{ padding: 8, color: theme.danger, fontSize: 12 }}>{status}</div> : null}

        {query.trim() ? (
          <>
            {searching ? <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>Searching...</div> : null}
            {!searching && searchResults?.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>No matching items</div>
            ) : null}
            {searchResults?.map((item) => <ItemRow key={item.id} item={item} />)}
          </>
        ) : (
          <>
            {categories?.length === 0 ? (
              <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>
                No price book loaded — click Manage to upload one
              </div>
            ) : null}
            {categories?.map((category) => <CategoryNode key={category} category={category} />)}
          </>
        )}
      </div>

      {managerOpen ? (
        <PriceBookManagerDialog
          onClose={() => {
            setManagerOpen(false);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}
