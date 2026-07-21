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
  merchant_id: number | null;
  merchant_name: string | null;
}

export interface MerchantDto {
  id: number;
  name: string;
  column_map: Record<string, string>;
  created_at: string;
}

/** Canonical price-book fields, shared by the merchant format editor and the import
 *  validation error messages on the backend — keep in sync with
 *  REQUIRED_PRICE_BOOK_FIELDS / OPTIONAL_PRICE_BOOK_FIELDS in desktop/src/lib.rs. */
export const PRICE_BOOK_FIELDS: Array<{ key: string; label: string; required: boolean; hint?: string }> = [
  { key: "description", label: "Description", required: true },
  { key: "unit_price", label: "Unit Price", required: true },
  { key: "unit_of_sale", label: "Unit", required: false },
  { key: "product_code", label: "Item Code", required: false },
  {
    key: "category",
    label: "Category",
    required: false,
    hint: "Leave blank if this merchant doesn't group items into categories",
  },
  { key: "group_name", label: "Group", required: false, hint: "Leave blank if this merchant has no sub-level under Category" },
  { key: "sub_group", label: "Sub Group", required: false, hint: "Leave blank if this merchant has no further sub-level under Group" },
  { key: "effective_date", label: "Effective Date", required: false },
  { key: "download_date", label: "Download / Ingest Date", required: false },
  { key: "price_book_name", label: "Price Book Name", required: false },
  { key: "account_number", label: "Account Number", required: false },
  { key: "account_name", label: "Account Name", required: false },
  { key: "branch_code", label: "Branch / Store Code", required: false },
];

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

/** Matches the backend's PRICE_BOOK_BROWSE_LIMIT (desktop/src/lib.rs) — used only to
 *  decide whether to show a "showing first N" hint under a browsed (not searched) item
 *  list, which only fires in practice for a merchant with no meaningful grouping at all. */
const ITEM_BROWSE_LIMIT = 300;

/** category/group/subGroup are `null` when that level isn't filtered — either because
 *  the merchant's format doesn't map it, or because a shallower level has already
 *  collapsed past it (see TreeBranch). An empty string `""` is a real, distinct filter
 *  value: the "(Uncategorised)"/"(Ungrouped)"/"(No Sub Group)" bucket. */
interface TreeFilters {
  category: string | null;
  group: string | null;
  subGroup: string | null;
}

const BLANK_BUCKET_LABELS = ["(Uncategorised)", "(Ungrouped)", "(No Sub Group)"];

function fetchLevelValues(level: 0 | 1 | 2, filters: TreeFilters): Promise<string[]> {
  if (level === 0) return invoke<string[]>("list_price_book_categories");
  if (level === 1) return invoke<string[]>("list_price_book_groups", { category: filters.category });
  return invoke<string[]>("list_price_book_subgroups", { category: filters.category, groupName: filters.group });
}

function withLevelValue(filters: TreeFilters, level: 0 | 1 | 2, value: string): TreeFilters {
  if (level === 0) return { ...filters, category: value };
  if (level === 1) return { ...filters, group: value };
  return { ...filters, subGroup: value };
}

/** Renders one level of the Category → Group → Sub Group hierarchy (or, at level 3,
 *  the items themselves). Different merchants use this hierarchy to different depths —
 *  some don't categorize at all — so a level whose values are *all* blank (the field
 *  isn't mapped for this merchant, or every item under the current filters leaves it
 *  blank) is invisible: instead of rendering a single pointless "(Uncategorised)" node,
 *  it passes straight through to the next level at the same tree depth. This is what
 *  lets the same tree component handle a full Carters-style hierarchy, a flat
 *  description+price-only catalog, and everything in between, driven entirely by what
 *  the data actually contains. */
function TreeBranch({ level, filters, depth }: { level: 0 | 1 | 2 | 3; filters: TreeFilters; depth: number }) {
  const [values, setValues] = useState<string[] | null>(null);

  useEffect(() => {
    if (level === 3) return;
    let cancelled = false;
    setValues(null);
    fetchLevelValues(level, filters).then((rows) => {
      if (!cancelled) setValues(rows);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, filters.category, filters.group, filters.subGroup]);

  if (level === 3) return <ItemsLeaf filters={filters} depth={depth} />;

  if (values === null) {
    return <div style={{ paddingLeft: theme.treeIndent * depth, fontSize: 11, color: theme.text.secondary }}>Loading...</div>;
  }

  if (values.every((v) => v === "")) {
    return <TreeBranch level={(level + 1) as 1 | 2 | 3} filters={filters} depth={depth} />;
  }

  return (
    <>
      {values.map((value) => (
        <TreeBranchNode key={value} level={level} value={value} filters={filters} depth={depth} />
      ))}
    </>
  );
}

function TreeBranchNode({
  level,
  value,
  filters,
  depth,
}: {
  level: 0 | 1 | 2;
  value: string;
  filters: TreeFilters;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <ExpandRow depth={depth} label={value || BLANK_BUCKET_LABELS[level]} expanded={expanded} onToggle={() => setExpanded((e) => !e)} />
      {expanded ? (
        <TreeBranch level={(level + 1) as 1 | 2 | 3} filters={withLevelValue(filters, level, value)} depth={depth + 1} />
      ) : null}
    </>
  );
}

function ItemsLeaf({ filters, depth }: { filters: TreeFilters; depth: number }) {
  const [items, setItems] = useState<PriceBookItemDto[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<PriceBookItemDto[]>("list_price_book_items", {
      category: filters.category,
      groupName: filters.group,
      subGroup: filters.subGroup,
    }).then((rows) => {
      if (!cancelled) setItems(rows);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.category, filters.group, filters.subGroup]);

  if (items === null) {
    return <div style={{ paddingLeft: theme.treeIndent * depth, fontSize: 11, color: theme.text.secondary }}>Loading...</div>;
  }
  return (
    <>
      {items.map((item) => (
        <ItemRow key={item.id} item={item} />
      ))}
      {items.length >= ITEM_BROWSE_LIMIT ? (
        <div style={{ paddingLeft: theme.treeIndent * depth, fontSize: 11, color: theme.text.secondary }}>
          Showing first {ITEM_BROWSE_LIMIT} — use search to find more
        </div>
      ) : null}
    </>
  );
}

const ROOT_FILTERS: TreeFilters = { category: null, group: null, subGroup: null };

export function RateLibraryPane() {
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
      const book = await invoke<PriceBookImportDto | null>("get_current_price_book");
      setCurrentBook(book);
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
          ? `${currentBook.merchant_name ?? currentBook.price_book_name ?? "Price book"} — ingested ${currentBook.download_date} (${currentBook.row_count} items)`
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
        ) : currentBook ? (
          <TreeBranch key={currentBook.id} level={0} filters={ROOT_FILTERS} depth={0} />
        ) : (
          <div style={{ padding: 8, color: theme.text.secondary, fontSize: 12 }}>
            No price book loaded — click Manage to upload one
          </div>
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
