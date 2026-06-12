import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { DocumentMeta, ViewerCanvas } from "./ViewerCanvas";
import { FramingBreakdownPanel } from "./FramingBreakdownPanel";
import { OpeningDialog } from "./OpeningDialog";
import { Framing3DView, type Framing3DPage } from "./Framing3DView";
import { DEFAULT_DOOR, DEFAULT_WINDOW, parseFramingSettings, parseWallFraming, type OpeningTemplate } from "../lib/framing";
import { computeWall3D, type Member3D } from "../lib/framing3d";

export function Viewer() {
  const [doc, setDoc] = useState<DocumentMeta | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [status, setStatus] = useState("");
  const currentDocument = useAppStore((state) => state.currentDocument);
  const currentPageIndex = useAppStore((state) => state.activePageIndex);
  const overlayMeasurements = useAppStore((state) => state.overlayMeasurements);
  const overlayColour = useAppStore((state) => state.overlayColour);
  const groupColours = useAppStore((state) => state.groupColours);
  const viewerMode = useAppStore((state) => state.viewerMode);
  const setViewerMode = useAppStore((state) => state.setViewerMode);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const groupProps = useAppStore((state) => state.groupProps);
  const pageScale = useAppStore((state) => state.pageScale);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [openingDialog, setOpeningDialog] = useState<OpeningTemplate | null>(null);
  const openingPlacement = useAppStore((state) => state.openingPlacement);
  const setOpeningPlacement = useAppStore((state) => state.setOpeningPlacement);
  const arrayTrimMode = useAppStore((state) => state.arrayTrimMode);
  const setArrayTrimMode = useAppStore((state) => state.setArrayTrimMode);
  const arrayTrimType = useAppStore((state) => state.arrayTrimType);
  const setArrayTrimType = useAppStore((state) => state.setArrayTrimType);
  const view3d = useAppStore((state) => state.view3d);
  const view3dMulti = useAppStore((state) => state.view3dMulti);
  const multiPage3DConfig = useAppStore((state) => state.multiPage3DConfig);
  const activeIsFraming =
    activeDimensionGroupId !== null && groupProps[activeDimensionGroupId]?.measurement_type === "timber_framing";
  const activeIsArray =
    activeDimensionGroupId !== null && groupProps[activeDimensionGroupId]?.measurement_type === "array";

  // Preview image URL for the current page — loaded on demand when view3d is active.
  const [previewUrl3d, setPreviewUrl3d] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!view3d || !doc) { setPreviewUrl3d(undefined); return; }
    let alive = true;
    invoke<{ page: number; width: number; height: number; image_path: string }>(
      "render_preview", { pageIndex }
    ).then((data) => {
      if (alive) setPreviewUrl3d(convertFileSrc(data.image_path));
    }).catch(() => { /* preview unavailable — ground stays as grid */ });
    return () => { alive = false; };
  }, [view3d, doc, pageIndex]);

  // Page dimensions in world metres for the ground plane.
  const mmpp3d = pageScale?.mm_per_point ?? null;
  const S3d = mmpp3d ? mmpp3d / 1000 : null;
  const currentPage3d = doc?.pages[pageIndex] ?? null;
  const pageWidthM3d = S3d && currentPage3d ? currentPage3d.width_pts * S3d : undefined;
  const pageHeightM3d = S3d && currentPage3d ? currentPage3d.height_pts * S3d : undefined;

  // 3D members for the framing walls on the displayed page.
  const members3d = useMemo<Member3D[]>(() => {
    if (!view3d) return [];
    const mmpp = pageScale?.mm_per_point ?? null;
    const out: Member3D[] = [];
    for (const mz of overlayMeasurements) {
      if (mz.measurement_type !== "timber_framing" || mz.page_index !== pageIndex) continue;
      let pts: { x: number; y: number }[];
      try {
        pts = JSON.parse(mz.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const settings = parseFramingSettings(groupProps[mz.dimension_group_id]?.framing_props_json ?? null);
      out.push(...computeWall3D(pts, settings, mmpp, parseWallFraming(mz.framing_json)));
    }
    return out;
  }, [view3d, overlayMeasurements, groupProps, pageScale, pageIndex]);
  // Preview images for the multi-page 3D scene's "ground" pages (offset <= 0).
  const [multiPreviewUrls, setMultiPreviewUrls] = useState<Record<number, string>>({});
  useEffect(() => {
    if (!view3d || !view3dMulti || !multiPage3DConfig) { setMultiPreviewUrls({}); return; }
    let alive = true;
    const groundPages = multiPage3DConfig.pages.filter((p) => p.included && p.offsetM <= 0);
    Promise.all(
      groundPages.map(async (p) => {
        try {
          const data = await invoke<{ page: number; width: number; height: number; image_path: string }>(
            "render_preview", { pageIndex: p.pageIndex }
          );
          return [p.pageIndex, convertFileSrc(data.image_path)] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!alive) return;
      const urls: Record<number, string> = {};
      for (const entry of entries) {
        if (entry) urls[entry[0]] = entry[1];
      }
      setMultiPreviewUrls(urls);
    });
    return () => { alive = false; };
  }, [view3d, view3dMulti, multiPage3DConfig]);

  // 3D scene pages for the multi-page view: each included page's framing members (offset
  // along world Y by its configured Z-offset), with the PDF page rendered as a ground
  // plane only for pages at or below Z-0.
  const pages3d = useMemo<Framing3DPage[]>(() => {
    if (!view3d || !view3dMulti || !multiPage3DConfig) return [];
    return multiPage3DConfig.pages
      .filter((p) => p.included)
      .map((p) => {
        const out: Member3D[] = [];
        for (const g of p.groups) {
          if (!g.included) continue;
          const settings = parseFramingSettings(g.framingPropsJson);
          for (const mz of g.measurements) {
            let pts: { x: number; y: number }[];
            try {
              pts = JSON.parse(mz.geometry_json);
            } catch {
              continue;
            }
            if (!Array.isArray(pts) || pts.length < 2) continue;
            out.push(...computeWall3D(pts, settings, p.mmPerPoint, parseWallFraming(mz.framing_json)));
          }
        }
        const S = p.mmPerPoint ? p.mmPerPoint / 1000 : null;
        return {
          members: out,
          offsetM: p.offsetM,
          pageWidthM: S ? p.pageWidthPts * S : undefined,
          pageHeightM: S ? p.pageHeightPts * S : undefined,
          previewUrl: multiPreviewUrls[p.pageIndex],
          showGround: p.offsetM <= 0,
        };
      });
  }, [view3d, view3dMulti, multiPage3DConfig, multiPreviewUrls]);

  // Debug/QA: console-only export of the current page's timber-framing walls as a 2D
  // elevation PDF. Run `exportFramingElevations()` in devtools. Same action backs the
  // ribbon's "Elevation PDF" button.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).exportFramingElevations = () =>
      useAppStore.getState().exportFramingElevations();
    return () => {
      delete (window as unknown as Record<string, unknown>).exportFramingElevations;
    };
  }, []);

  const calibrating = useAppStore((state) => state.calibrating);
  const setCalibrating = useAppStore((state) => state.setCalibrating);
  const drawPolarity = useAppStore((state) => state.drawPolarity);
  const setDrawPolarity = useAppStore((state) => state.setDrawPolarity);

  const handleStatusChange = useCallback((nextStatus: string) => {
    setStatus(nextStatus);
  }, []);

  useEffect(() => {
    if (!currentDocument) {
      setDoc(null);
      setPageIndex(0);
      setStatus("");
      return;
    }
    setDoc(currentDocument);
    setPageIndex(currentPageIndex);
    setStatus(`Opened: ${currentDocument.page_count} pages`);
  }, [currentDocument, currentPageIndex]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minWidth: 0,
        minHeight: 0,
        background: theme.bg.shell,
        color: theme.text.primary,
        fontFamily: "Segoe UI, sans-serif",
      }}
    >
      <div
        style={{
          height: 42,
          padding: "0 10px",
          background: "#2b2d31",
          display: "flex",
          gap: 12,
          alignItems: "center",
          borderBottom: "1px solid #3c4048",
          flexShrink: 0,
        }}
      >
        {doc ? (
          <button
            onClick={() => setCalibrating(!calibrating)}
            title="Set the page scale by drawing a line over a known dimension"
            style={{
              height: 24,
              padding: "0 10px",
              background: calibrating ? theme.accent : theme.bg.input,
              color: calibrating ? "#fff" : theme.text.primary,
              border: `1px solid ${calibrating ? theme.accent : theme.border.divider}`,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {calibrating ? "Calibrating…" : pageScale ? "Rescale" : "Set Scale"}
          </button>
        ) : null}
        {doc ? (
          <span style={{ fontSize: 12, color: pageScale ? theme.text.secondary : theme.danger }}>
            {pageScale ? `Scale: 1 pt = ${pageScale.mm_per_point.toPrecision(4)} mm` : "No scale set"}
          </span>
        ) : null}
        {activeDimensionGroupId !== null ? (
          <div style={{ display: "flex", border: `1px solid ${theme.border.divider}`, borderRadius: 3, overflow: "hidden" }}>
            {(["add", "select"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewerMode(mode)}
                title={mode === "add" ? "Add dimensions (click to place)" : "Select / edit dimensions (Del to delete, drag vertices to move)"}
                style={{
                  height: 24,
                  padding: "0 10px",
                  border: "none",
                  background: viewerMode === mode ? theme.accent : theme.bg.input,
                  color: viewerMode === mode ? "#fff" : theme.text.secondary,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {mode === "add" ? "Add" : "Select"}
              </button>
            ))}
          </div>
        ) : null}
        {activeDimensionGroupId !== null && viewerMode === "add" && !activeIsFraming && !activeIsArray ? (
          <div style={{ display: "flex", border: `1px solid ${theme.border.divider}`, borderRadius: 3, overflow: "hidden" }}>
            {([1, -1] as const).map((polarity) => (
              <button
                key={polarity}
                onClick={() => setDrawPolarity(polarity)}
                title={polarity === 1 ? "Draw positive dimensions (add)" : "Draw negative dimensions (deduct/cutout)"}
                style={{
                  height: 24,
                  padding: "0 10px",
                  border: "none",
                  background: drawPolarity === polarity ? (polarity === 1 ? "#1f8f3a" : "#b23030") : theme.bg.input,
                  color: drawPolarity === polarity ? "#fff" : theme.text.secondary,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                {polarity === 1 ? "Positive" : "Negative"}
              </button>
            ))}
          </div>
        ) : null}
        {activeIsArray ? (
          <select
            value={arrayTrimMode ? arrayTrimType : "off"}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "off") {
                setArrayTrimMode(false);
              } else {
                setArrayTrimType(value as "line" | "box");
                setArrayTrimMode(true);
              }
            }}
            title="Trim array: draw a cut line or box to clip array members"
            style={{
              height: 24,
              padding: "0 6px",
              background: arrayTrimMode ? theme.accent : theme.bg.input,
              color: arrayTrimMode ? "#fff" : theme.text.primary,
              border: `1px solid ${arrayTrimMode ? theme.accent : theme.border.divider}`,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            <option value="off">Trim</option>
            <option value="line">Trim: Line</option>
            <option value="box">Trim: Box</option>
          </select>
        ) : null}
        {activeIsFraming ? (
          <div style={{ display: "flex", border: `1px solid ${theme.border.divider}`, borderRadius: 3, overflow: "hidden" }}>
            <button
              onClick={() => (openingPlacement?.kind === "door" ? setOpeningPlacement(null) : setOpeningDialog(DEFAULT_DOOR))}
              title="Insert a door: set the opening, then click on a wall to place it"
              style={{
                height: 24,
                padding: "0 10px",
                border: "none",
                background: openingPlacement?.kind === "door" ? theme.accent : theme.bg.input,
                color: openingPlacement?.kind === "door" ? "#fff" : theme.text.primary,
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {openingPlacement?.kind === "door" ? "Placing door…" : "Add Door"}
            </button>
            <button
              onClick={() => (openingPlacement?.kind === "window" ? setOpeningPlacement(null) : setOpeningDialog(DEFAULT_WINDOW))}
              title="Insert a window: set the opening, then click on a wall to place it"
              style={{
                height: 24,
                padding: "0 10px",
                border: "none",
                borderLeft: `1px solid ${theme.border.divider}`,
                background: openingPlacement?.kind === "window" ? theme.accent : theme.bg.input,
                color: openingPlacement?.kind === "window" ? "#fff" : theme.text.primary,
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {openingPlacement?.kind === "window" ? "Placing window…" : "Add Window"}
            </button>
          </div>
        ) : null}
        {activeIsFraming ? (
          <button
            onClick={() => setShowBreakdown((v) => !v)}
            title="Show the framing quantity makeup (studs, plates, dwangs)"
            style={{
              height: 24,
              padding: "0 10px",
              background: showBreakdown ? theme.accent : theme.bg.input,
              color: showBreakdown ? "#fff" : theme.text.primary,
              border: `1px solid ${showBreakdown ? theme.accent : theme.border.divider}`,
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Breakdown
          </button>
        ) : null}
        <span style={{ fontSize: 12 }}>{status}</span>
        {doc ? (
          <span style={{ fontSize: 12 }}>
            Page {pageIndex + 1} of {doc.page_count}
          </span>
        ) : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {view3d ? (
          view3dMulti && multiPage3DConfig ? (
            pages3d.some((p) => p.members.length > 0) ? (
              <Framing3DView members={[]} pages={pages3d} />
            ) : (
              <div style={{ flex: 1, display: "grid", placeItems: "center", background: "#dfe4ea", color: "#5a636c", fontSize: 13 }}>
                No timber framing found on the selected pages.
              </div>
            )
          ) : members3d.length > 0 ? (
            <Framing3DView members={members3d} pageWidthM={pageWidthM3d} pageHeightM={pageHeightM3d} previewUrl={previewUrl3d} />
          ) : (
            <div style={{ flex: 1, display: "grid", placeItems: "center", background: "#dfe4ea", color: "#5a636c", fontSize: 13 }}>
              No timber framing on this page to show in 3D (draw a wall on a scaled page).
            </div>
          )
        ) : (
          <>
            <ViewerCanvas
              doc={doc}
              pageIndex={pageIndex}
              onStatusChange={handleStatusChange}
              overlayMeasurements={overlayMeasurements}
              overlayColour={overlayColour}
              groupColours={groupColours}
            />
            {showBreakdown && activeIsFraming ? <FramingBreakdownPanel onClose={() => setShowBreakdown(false)} /> : null}
          </>
        )}
      </div>
      {openingDialog ? (
        <OpeningDialog
          title={openingDialog.kind === "window" ? "Add Window" : "Add Door"}
          initial={openingDialog}
          confirmLabel={openingDialog.kind === "window" ? "Place Window" : "Place Door"}
          onCancel={() => setOpeningDialog(null)}
          onConfirm={(template) => {
            setOpeningPlacement(template);
            setOpeningDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
