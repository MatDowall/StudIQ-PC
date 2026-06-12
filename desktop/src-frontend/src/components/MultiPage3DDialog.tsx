import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { theme } from "../theme";
import { useAppStore, type MultiPage3DPageEntry } from "../store/appStore";

const inputStyle: React.CSSProperties = {
  boxSizing: "border-box",
  height: 26,
  padding: "0 6px",
  background: theme.bg.input,
  color: theme.text.primary,
  border: `1px solid ${theme.border.divider}`,
  outline: "none",
  fontSize: 12,
};

/** Setup dialog for "View Multiple Pages...": pick which pages (and which timber-framing
 *  dimension groups on each) to combine into one 3D scene, with a per-page Z-offset
 *  (storey height) and a drag-and-drop draw order. */
export function MultiPage3DDialog({ onCancel }: { onCancel: () => void }) {
  const loadMultiPage3DSetup = useAppStore((state) => state.loadMultiPage3DSetup);
  const setMultiPage3DConfig = useAppStore((state) => state.setMultiPage3DConfig);
  const setView3dMulti = useAppStore((state) => state.setView3dMulti);
  const setView3d = useAppStore((state) => state.setView3d);
  const activeDrawingId = useAppStore((state) => state.activeDrawingId);
  const existingConfig = useAppStore((state) => state.multiPage3DConfig);

  const [pages, setPages] = useState<MultiPage3DPageEntry[] | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const fresh = await loadMultiPage3DSetup();
      if (!alive) return;
      if (existingConfig && existingConfig.drawingId === activeDrawingId) {
        // Re-opening: preserve the user's previous order/offsets/selection where the page
        // still exists, but pick up any newly-drawn pages/groups from the fresh scan.
        const byPage = new Map(existingConfig.pages.map((p) => [p.pageIndex, p]));
        const merged: MultiPage3DPageEntry[] = [];
        for (const prev of existingConfig.pages) {
          const current = fresh.find((p) => p.pageIndex === prev.pageIndex);
          if (!current) continue;
          const groupsByPrev = new Map(prev.groups.map((g) => [g.groupId, g]));
          merged.push({
            ...current,
            included: prev.included,
            offsetM: prev.offsetM,
            groups: current.groups.map((g) => ({ ...g, included: groupsByPrev.get(g.groupId)?.included ?? true })),
          });
        }
        for (const current of fresh) {
          if (!byPage.has(current.pageIndex)) merged.push(current);
        }
        setPages(merged);
      } else {
        setPages(fresh);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updatePage(index: number, patch: Partial<MultiPage3DPageEntry>) {
    setPages((prev) => prev?.map((p, i) => (i === index ? { ...p, ...patch } : p)) ?? prev);
  }

  function toggleGroup(pageIndex: number, groupId: number) {
    setPages((prev) =>
      prev?.map((p, i) =>
        i === pageIndex
          ? { ...p, groups: p.groups.map((g) => (g.groupId === groupId ? { ...g, included: !g.included } : g)) }
          : p,
      ) ?? prev,
    );
  }

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    setPages((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDragIndex(null);
  }

  function handleConfirm() {
    if (!pages || activeDrawingId === null) return;
    setMultiPage3DConfig({ drawingId: activeDrawingId, pages });
    setView3dMulti(true);
    setView3d(true);
    onCancel();
  }

  return createPortal(
    <div style={{ position: "fixed", inset: 0, zIndex: 1250, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.45)" }}>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: 520,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          background: theme.bg.pane,
          border: `1px solid ${theme.border.divider}`,
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
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
            flexShrink: 0,
          }}
        >
          View Multiple Pages in 3D
        </div>
        <div style={{ overflowY: "auto", padding: 14, flex: 1, minHeight: 0 }}>
          {pages === null ? (
            <div style={{ color: theme.text.secondary, fontSize: 12 }}>Scanning drawing for timber framing…</div>
          ) : pages.length === 0 ? (
            <div style={{ color: theme.text.secondary, fontSize: 12 }}>
              No timber framing dimension groups were found on any page of this drawing.
            </div>
          ) : (
            <>
              <div style={{ color: theme.text.secondary, fontSize: 11, marginBottom: 10 }}>
                Drag rows to set the stacking order (top = highest). Set a Z-offset per page to position each
                storey's framing — pages at offset 0 also show the drawing as a floor plan; pages above 0 hide it.
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pages.map((page, index) => (
                  <div
                    key={page.pageIndex}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => handleDrop(index)}
                    style={{
                      border: `1px solid ${theme.border.divider}`,
                      background: theme.bg.input,
                      opacity: page.included ? 1 : 0.55,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px" }}>
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: 16, lineHeight: 1, cursor: "grab", color: theme.text.secondary }}
                        title="Drag to reorder"
                      >
                        drag_indicator
                      </span>
                      <input
                        type="checkbox"
                        checked={page.included}
                        onChange={(e) => updatePage(index, { included: e.target.checked })}
                        title="Include this page in the 3D view"
                      />
                      <span style={{ fontSize: 12, fontWeight: 600, minWidth: 64 }}>{page.label}</span>
                      <span style={{ flex: 1, fontSize: 11, color: theme.text.secondary }}>
                        {page.groups.length} framing group{page.groups.length === 1 ? "" : "s"}
                      </span>
                      <span style={{ fontSize: 11, color: theme.text.secondary }}>Z offset</span>
                      <input
                        type="number"
                        step="any"
                        value={page.offsetM}
                        onChange={(e) => updatePage(index, { offsetM: Number(e.target.value) || 0 })}
                        style={{ ...inputStyle, width: 70 }}
                      />
                      <span style={{ fontSize: 11, color: theme.text.secondary }}>m</span>
                    </div>
                    {page.groups.length > 0 ? (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "4px 14px",
                          padding: "0 8px 8px 34px",
                        }}
                      >
                        {page.groups.map((g) => (
                          <label key={g.groupId} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                            <input
                              type="checkbox"
                              checked={g.included}
                              onChange={() => toggleGroup(index, g.groupId)}
                            />
                            {g.name}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 12px", borderTop: `1px solid ${theme.border.subtle}`, flexShrink: 0 }}>
          <button onClick={onCancel} style={{ height: 28, padding: "0 12px", background: theme.bg.input, color: theme.text.primary, border: `1px solid ${theme.border.divider}`, cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!pages || pages.length === 0}
            style={{
              height: 28,
              padding: "0 12px",
              background: theme.bg.active,
              color: "#FFFFFF",
              border: `1px solid ${theme.accent}`,
              cursor: pages && pages.length > 0 ? "pointer" : "not-allowed",
              opacity: pages && pages.length > 0 ? 1 : 0.6,
            }}
          >
            View in 3D
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
