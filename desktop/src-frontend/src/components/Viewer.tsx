import { useCallback, useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { theme } from "../theme";
import { DocumentMeta, ViewerCanvas } from "./ViewerCanvas";
import { Framing3DView, type Framing3DPage } from "./Framing3DView";
import { parseFramingSettings, parseJoistRafterSettings, parseWallFraming } from "../lib/framing";
import { isWallInsulationType, isWallSurfaceType, parseArrayMeta, parseWallSurfaceMeta, wallSurfaceDeducts } from "../lib/quantity";
import {
  computeAreaMesh3D,
  computeArrayMembers3D,
  computeCountMarker3D,
  computeLengthMembers3D,
  computeWall3D,
  computeWallSurface3D,
  offsetMembers,
  type AreaMesh3D,
  type Member3D,
} from "../lib/framing3d";

export function Viewer() {
  const [doc, setDoc] = useState<DocumentMeta | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const currentDocument = useAppStore((state) => state.currentDocument);
  const currentPageIndex = useAppStore((state) => state.activePageIndex);
  const overlayMeasurements = useAppStore((state) => state.overlayMeasurements);
  const overlayColour = useAppStore((state) => state.overlayColour);
  const groupColours = useAppStore((state) => state.groupColours);
  const groupProps = useAppStore((state) => state.groupProps);
  const pageScale = useAppStore((state) => state.pageScale);
  const setViewerStatus = useAppStore((state) => state.setViewerStatus);
  const view3d = useAppStore((state) => state.view3d);
  const view3dMulti = useAppStore((state) => state.view3dMulti);
  const multiPage3DConfig = useAppStore((state) => state.multiPage3DConfig);

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

  // 3D geometry for every measurement on the displayed page — timber-framing walls go through
  // computeWall3D (the shared 2D/3D member model); count/length/area groups go through the
  // generic builders, coloured by the group's own positive/negative colour (same colours the
  // 2D canvas uses for that measurement).
  const { members3d, areas3d } = useMemo(() => {
    if (!view3d) return { members3d: [] as Member3D[], areas3d: [] as AreaMesh3D[] };
    const mmpp = pageScale?.mm_per_point ?? null;
    const members: Member3D[] = [];
    const areas: AreaMesh3D[] = [];
    for (const mz of overlayMeasurements) {
      if (mz.page_index !== pageIndex) continue;
      let pts: { x: number; y: number }[];
      try {
        pts = JSON.parse(mz.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 1) continue;
      const props = groupProps[mz.dimension_group_id];
      const offsetM = props?.default_offset ?? 0;
      const negative = (mz.polarity ?? 1) < 0;
      const color = negative ? props?.neg_colour ?? "#FF0000" : props?.pos_colour ?? "#4A9EFF";
      if (mz.measurement_type === "timber_framing") {
        if (pts.length < 2) continue;
        const settings = parseFramingSettings(props?.framing_props_json ?? null);
        members.push(...offsetMembers(computeWall3D(pts, settings, mmpp, parseWallFraming(mz.framing_json)), offsetM));
      } else if (mz.measurement_type === "count") {
        const marker = computeCountMarker3D(pts[0], mmpp, {
          widthM: props?.default_width ?? 0,
          heightM: props?.default_height ?? 0,
          countType: props?.count_type ?? "marker",
          offsetM,
          color,
        });
        if (marker) members.push(marker);
      } else if (mz.measurement_type === "area") {
        const mesh = computeAreaMesh3D(pts, mmpp, { heightM: props?.default_height ?? 0, offsetM, color });
        if (mesh) areas.push(mesh);
      } else if (mz.measurement_type === "array") {
        if (pts.length < 2) continue;
        const meta = parseArrayMeta(mz.framing_json ?? null);
        const joistRafter = parseJoistRafterSettings(props?.framing_props_json ?? null);
        members.push(
          ...computeArrayMembers3D(pts, mmpp, meta, joistRafter, {
            offsetM,
            color,
            pitchAngleDeg: props?.pitch_angle_deg ?? 0,
          }),
        );
      } else if (isWallSurfaceType(mz.measurement_type)) {
        const meta = parseWallSurfaceMeta(mz.framing_json);
        members.push(
          ...computeWallSurface3D(pts, mmpp, meta, {
            offsetM,
            color,
            deductOpenings: wallSurfaceDeducts(meta, { framing_props_json: props?.framing_props_json ?? null }),
            insulation: isWallInsulationType(mz.measurement_type),
          }),
        );
      } else if (mz.measurement_type === "length") {
        members.push(
          ...computeLengthMembers3D(pts, mmpp, {
            widthM: props?.default_width ?? 0,
            heightM: props?.default_height ?? 0,
            offsetM,
            color,
            display: props?.default_display ?? "length",
          }),
        );
      }
    }
    return { members3d: members, areas3d: areas };
  }, [view3d, overlayMeasurements, groupProps, pageScale, pageIndex]);
  // 3D scene pages for the multi-page view: each included page's measurement geometry, offset
  // along world Y by its configured Z-offset. The PDF page is never rendered as a ground
  // plane here — with no offset specified every page sits at world Y=0, so any ground
  // plane would Z-fight with every other page's ground plane at that same level.
  const pages3d = useMemo<Framing3DPage[]>(() => {
    if (!view3d || !view3dMulti || !multiPage3DConfig) return [];
    return multiPage3DConfig.pages
      .filter((p) => p.included)
      .map((p) => {
        const members: Member3D[] = [];
        const areas: AreaMesh3D[] = [];
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
            if (!Array.isArray(pts) || pts.length < 1) continue;
            const negative = (mz.polarity ?? 1) < 0;
            const color = negative ? g.negColour : g.posColour;
            if (g.measurementType === "timber_framing") {
              if (pts.length < 2) continue;
              members.push(...offsetMembers(computeWall3D(pts, settings, p.mmPerPoint, parseWallFraming(mz.framing_json)), g.defaultOffsetM));
            } else if (g.measurementType === "count") {
              const marker = computeCountMarker3D(pts[0], p.mmPerPoint, {
                widthM: g.defaultWidthM,
                heightM: g.defaultHeightM,
                countType: g.countType,
                offsetM: g.defaultOffsetM,
                color,
              });
              if (marker) members.push(marker);
            } else if (g.measurementType === "area") {
              const mesh = computeAreaMesh3D(pts, p.mmPerPoint, { heightM: g.defaultHeightM, offsetM: g.defaultOffsetM, color });
              if (mesh) areas.push(mesh);
            } else if (g.measurementType === "array") {
              if (pts.length < 2) continue;
              const meta = parseArrayMeta(mz.framing_json ?? null);
              const joistRafter = parseJoistRafterSettings(g.framingPropsJson);
              members.push(
                ...computeArrayMembers3D(pts, p.mmPerPoint, meta, joistRafter, {
                  offsetM: g.defaultOffsetM,
                  color,
                  pitchAngleDeg: g.pitchAngleDeg,
                }),
              );
            } else if (isWallSurfaceType(g.measurementType)) {
              const meta = parseWallSurfaceMeta(mz.framing_json);
              members.push(
                ...computeWallSurface3D(pts, p.mmPerPoint, meta, {
                  offsetM: g.defaultOffsetM,
                  color,
                  deductOpenings: wallSurfaceDeducts(meta, { framing_props_json: g.framingPropsJson }),
                  insulation: isWallInsulationType(g.measurementType),
                }),
              );
            } else if (g.measurementType === "length") {
              members.push(
                ...computeLengthMembers3D(pts, p.mmPerPoint, {
                  widthM: g.defaultWidthM,
                  heightM: g.defaultHeightM,
                  offsetM: g.defaultOffsetM,
                  color,
                  display: g.defaultDisplay,
                }),
              );
            }
          }
        }
        return {
          members,
          areas,
          offsetM: p.offsetM,
          showGround: false,
        };
      });
  }, [view3d, view3dMulti, multiPage3DConfig]);

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

  // Debug/QA: dumps every timber-framing wall on the current page as JSON (points, settings,
  // openings/rakes) — everything needed to reproduce a wall's exact geometry in a unit test.
  // Run `dumpFramingWalls()` in devtools (F12) and paste the console output when reporting a
  // framing bug.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).dumpFramingWalls = () => {
      const state = useAppStore.getState();
      const mmpp = state.pageScale?.mm_per_point ?? null;
      const dump = state.overlayMeasurements
        .filter((mz) => mz.measurement_type === "timber_framing" && mz.page_index === state.activePageIndex)
        .map((mz) => {
          let pts: unknown = null;
          try {
            pts = JSON.parse(mz.geometry_json);
          } catch {
            pts = mz.geometry_json;
          }
          let framing: unknown = null;
          try {
            framing = mz.framing_json ? JSON.parse(mz.framing_json) : null;
          } catch {
            framing = mz.framing_json;
          }
          return {
            measurementId: mz.id,
            dimensionGroupId: mz.dimension_group_id,
            mmPerPoint: mmpp,
            settings: state.groupProps[mz.dimension_group_id]?.framing_props_json
              ? JSON.parse(state.groupProps[mz.dimension_group_id]!.framing_props_json!)
              : null,
            points: pts,
            framing,
          };
        });
      console.log("[dumpFramingWalls]", JSON.stringify(dump, null, 2));
      return dump;
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).dumpFramingWalls;
    };
  }, []);

  const handleStatusChange = useCallback((nextStatus: string) => {
    setViewerStatus(nextStatus);
  }, [setViewerStatus]);

  useEffect(() => {
    if (!currentDocument) {
      setDoc(null);
      setPageIndex(0);
      setViewerStatus("");
      return;
    }
    setDoc(currentDocument);
    setPageIndex(currentPageIndex);
    setViewerStatus(`Opened: ${currentDocument.page_count} pages`);
  }, [currentDocument, currentPageIndex, setViewerStatus]);

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
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {view3d ? (
          view3dMulti && multiPage3DConfig ? (
            pages3d.some((p) => p.members.length > 0 || (p.areas?.length ?? 0) > 0) ? (
              <Framing3DView members={[]} pages={pages3d} />
            ) : (
              <div style={{ flex: 1, display: "grid", placeItems: "center", background: "#dfe4ea", color: "#5a636c", fontSize: 13 }}>
                No measurements found on the selected pages.
              </div>
            )
          ) : members3d.length > 0 || areas3d.length > 0 ? (
            <Framing3DView
              members={members3d}
              areas={areas3d}
              pageWidthM={pageWidthM3d}
              pageHeightM={pageHeightM3d}
              previewUrl={previewUrl3d}
            />
          ) : (
            <div style={{ flex: 1, display: "grid", placeItems: "center", background: "#dfe4ea", color: "#5a636c", fontSize: 13 }}>
              No measurements on this page to show in 3D (draw a measurement on a scaled page).
            </div>
          )
        ) : (
          <ViewerCanvas
            doc={doc}
            pageIndex={pageIndex}
            onStatusChange={handleStatusChange}
            overlayMeasurements={overlayMeasurements}
            overlayColour={overlayColour}
            groupColours={groupColours}
          />
        )}
      </div>
    </div>
  );
}
