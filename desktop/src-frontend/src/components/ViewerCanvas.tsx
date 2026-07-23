import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type SnapPoint, type SnapType, type TreeNodeDto } from "../store/appStore";
import {
  deriveQuantity,
  formatQuantity,
  parseArrayMeta,
  pitchedPolygonPerimeterPts,
  pitchedPolylineLengthPts,
  pitchedSegmentLengthPts,
  polygonAreaPts,
  polygonPerimeterPts,
  quantityValueText,
  serializeArrayMeta,
  MEASUREMENT_TYPE_ICONS,
  MEASUREMENT_TYPE_LABELS,
  type ArrayMeta,
  type ArrayTrim,
  type BoxTrim,
  type GroupProps,
} from "../lib/quantity";
import {
  computeFramingGeometry,
  computeFramingQuantities,
  extraStudRect,
  openingPreview,
  orthogonalConstrain,
  parseFramingSettings,
  parseJoistRafterSettings,
  parseWallFraming,
  projectOntoPath,
  reindexFramingForVertexDeletion,
  reindexFramingForVertexInsertion,
  serializeWallFraming,
  wallMembers,
  wallStudPositions,
  STUD_THICKNESS_MM,
  type Opening,
  type OpeningTemplate,
  type WallFraming,
} from "../lib/framing";
import {
  computeAreaMesh3D,
  computeArrayMembers3D,
  computeCountMarker3D,
  computeLengthMembers3D,
  computeWall3D,
  offsetMembers,
  type AreaMesh3D,
  type Member3D,
} from "../lib/framing3d";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { OpeningDialog } from "./OpeningDialog";
import { RakingDialog } from "./RakingDialog";
import { Framing3DView } from "./Framing3DView";
import { MeasurementHoverCard, type HoverCardData, type HoverCardRow } from "./MeasurementHoverCard";

type ViewerMenuItem = ContextMenuItem;

const TILE_SIZE = 512;

export interface PageMeta {
  index: number;
  width_pts: number;
  height_pts: number;
}

export interface DocumentMeta {
  path: string;
  page_count: number;
  pages: PageMeta[];
}

interface TileKey {
  page: number;
  zoom_level: number;
  tile_x: number;
  tile_y: number;
}

interface TileData {
  key: TileKey;
  image_path: string;
  x: number;
  y: number;
  generation: number;
}

interface PreviewData {
  page: number;
  width: number;
  height: number;
  image_path: string;
}

// Bluebeam-parity settle pass: a pixel-exact render of the current viewport at
// zoom*devicePixelRatio DPI, fetched once pan/zoom/page has been idle for a beat.
interface SettleViewMeta {
  key: string;
  width: number;
  height: number;
  crop_x: number;
  crop_y: number;
  dpi: number;
}

interface SettleViewState {
  page: number;
  zoom: number;
  panX: number;
  panY: number;
  dpr: number;
  cropX: number;
  cropY: number;
}

interface ViewportState {
  page_index: number;
  zoom: number;
  pan_x: number;
  pan_y: number;
  width: number;
  height: number;
}

export interface MeasurementDto {
  id: number;
  dimension_group_id: number;
  drawing_id: number;
  page_index: number;
  measurement_type: string;
  geometry_json: string;
  polarity: number;
  quantity: number | null;
  uom: string | null;
  framing_json: string | null;
}

interface ViewerCanvasProps {
  doc: DocumentMeta | null;
  pageIndex: number;
  onStatusChange: (status: string) => void;
  overlayMeasurements?: MeasurementDto[];
  overlayColour?: string;
  groupColours?: Record<number, string>;
}

function zoomBucket(zoom: number) {
  if (zoom <= 0.3) return 0;
  if (zoom <= 0.6) return 1;
  if (zoom <= 1.25) return 2;
  if (zoom <= 2.5) return 3;
  if (zoom <= 5.0) return 4;
  return 5;
}

function bucketZoom(zoomLevel: number) {
  return Math.pow(2, zoomLevel - 2);
}

function tileId(key: TileKey) {
  return `${key.page}:${key.zoom_level}:${key.tile_x}:${key.tile_y}`;
}

function pagePixelSize(page: PageMeta, zoom: number) {
  return {
    width: Math.ceil((page.width_pts * zoom * 96) / 72),
    height: Math.ceil((page.height_pts * zoom * 96) / 72),
  };
}

// PDF points → screen pixels at 96 DPI, before pan/zoom.
function pageScaleFactor(zoom: number) {
  return (zoom * 96) / 72;
}

function pageToScreen(
  ptX: number,
  ptY: number,
  pageHeightPts: number,
  pan: { x: number; y: number },
  zoom: number,
) {
  const scale = pageScaleFactor(zoom);
  return {
    x: ptX * scale - pan.x,
    y: (pageHeightPts - ptY) * scale - pan.y,
  };
}

const MEASURE_LINE_WIDTH = 7;
// Timber-framing plate outlines intentionally use their own weight — framing has its own
// stud/plate line hierarchy and shouldn't track the general measurement line weight.
const FRAMING_LINE_WIDTH = 2.5;
const VERTEX_RADIUS = 4;

type PagePoint = { x: number; y: number };

/** Shortest distance from point (px,py) to segment (ax,ay)-(bx,by), in the same units. */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Formats a length in PDF points as real-world units when a page scale exists, else "pt". */
function formatLength(pts: number, scale: { mm_per_point: number; unit: string } | null) {
  if (!scale) return `${pts.toFixed(0)} pt`;
  const mm = pts * scale.mm_per_point;
  if (scale.unit === "m") return `${(mm / 1000).toFixed(3)} m`;
  if (scale.unit === "cm") return `${(mm / 10).toFixed(1)} cm`;
  return `${mm.toFixed(0)} mm`;
}

/** Total polyline length in PDF points. */
function pathLengthPts(points: PagePoint[]) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Recursively finds a dimension-group tree node by id, for the hover card's group name/size. */
function findGroupNode(nodes: TreeNodeDto[], childCache: Record<number, TreeNodeDto[]>, targetId: number): TreeNodeDto | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    const found = findGroupNode(childCache[node.id] ?? [], childCache, targetId);
    if (found) return found;
  }
  return null;
}

// Length, timber-framing, and array dimensions are open polylines; area-type displays close
// into a polygon; count is a point set. Centralised so every hit-test/render agrees.
function isAreaType(measurementType: string) {
  return measurementType !== "length" && measurementType !== "count" && measurementType !== "timber_framing" && measurementType !== "array";
}

// Dash/dot/dash-dot segment lengths below are tuned at this reference stroke width;
// lineDash() scales them proportionally to whatever width is actually being stroked,
// so thicker lines get proportionally longer dashes/gaps instead of a fixed tiny pattern.
const DASH_REFERENCE_WIDTH = 2.5;

/** Canvas dash pattern for a CostX line style, scaled to the given stroke width. */
function lineDash(style: string | undefined, width: number = DASH_REFERENCE_WIDTH): number[] {
  const scale = width / DASH_REFERENCE_WIDTH;
  switch (style) {
    case "dashed":
      return [9 * scale, 6 * scale];
    case "dotted":
      return [2 * scale, 5 * scale];
    case "dash_dot":
      return [9 * scale, 5 * scale, 2 * scale, 5 * scale];
    default:
      return [];
  }
}

/** Count marker: a ringed cross at a point (CostX count style). */
function drawCountMarker(ctx: CanvasRenderingContext2D, x: number, y: number, colour: string, selected = false) {
  const r = selected ? 8 : 6;
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
  ctx.restore();
}

/** Custom count shape: a rectangle centred at a point, sized to the group's real-world Height/Width. */
function drawCustomCountShape(ctx: CanvasRenderingContext2D, x: number, y: number, halfW: number, halfH: number, colour: string, selected = false, style?: string) {
  ctx.save();
  ctx.strokeStyle = colour;
  const shapeWidth = selected ? 3 : 2;
  ctx.lineWidth = shapeWidth;
  ctx.setLineDash(lineDash(style, shapeWidth));
  ctx.strokeRect(x - halfW, y - halfH, halfW * 2, halfH * 2);
  ctx.restore();
}

/**
 * Screen-space half-extents for a custom count shape, or null when it can't be sized (no page
 * scale yet, or Height/Width not set) — callers should fall back to the standard marker.
 */
function customCountHalfExtentsPx(props: GroupProps, mmPerPoint: number | null, zoom: number): { halfW: number; halfH: number } | null {
  if (!mmPerPoint || props.default_width <= 0 || props.default_height <= 0) return null;
  const scale = pageScaleFactor(zoom);
  const wPts = (props.default_width * 1000) / mmPerPoint;
  const hPts = (props.default_height * 1000) / mmPerPoint;
  return { halfW: (wPts * scale) / 2, halfH: (hPts * scale) / 2 };
}

function drawVertices(ctx: CanvasRenderingContext2D, screenPts: PagePoint[], colour: string, selected = false) {
  // Selected dimensions show larger hollow handles to signal they are draggable.
  const radius = selected ? VERTEX_RADIUS + 2 : VERTEX_RADIUS;
  ctx.lineWidth = selected ? 2 : 1.5;
  for (const point of screenPts) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = selected ? "#ffffff" : colour;
    ctx.strokeStyle = selected ? colour : "#ffffff";
    ctx.fill();
    ctx.stroke();
  }
}

// Renders one timber-framing wall: the two plate outlines plus studs (each a rectangle with a
// corner-to-corner cross, transparent fill, solid same-colour outline — the architectural stud
// symbol). Geometry is computed in PDF points and projected through pageToScreen. With no page
// scale the members can't be sized, so we fall back to drawing the bare centre path.
function drawFraming(
  ctx: CanvasRenderingContext2D,
  points: PagePoint[],
  settings: ReturnType<typeof parseFramingSettings>,
  mmPerPoint: number | null,
  colour: string,
  style: string | undefined,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  selected: boolean,
  showVertices: boolean,
  framing?: WallFraming,
) {
  const toScreen = (p: PagePoint) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom);
  const geom = computeFramingGeometry(points, settings, mmPerPoint, framing);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (geom.studs.length === 0) {
    // No scale (or degenerate path) — show the centre path so the wall is still visible.
    if (points.length >= 2) {
      const sp = points.map(toScreen);
      ctx.strokeStyle = colour;
      const centreWidth = selected ? FRAMING_LINE_WIDTH + 1 : FRAMING_LINE_WIDTH;
      ctx.lineWidth = centreWidth;
      ctx.setLineDash(lineDash(style, centreWidth));
      ctx.beginPath();
      ctx.moveTo(sp[0].x, sp[0].y);
      for (const s of sp.slice(1)) ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (showVertices || selected) drawVertices(ctx, points.map(toScreen), colour, selected);
    ctx.restore();
    return;
  }

  // Plate outlines — solid and unbroken, including across door/window openings (the opening
  // itself is still legible from the jamb studs and, for a window, the glass centreline below).
  const baseWidth = selected ? FRAMING_LINE_WIDTH + 1 : FRAMING_LINE_WIDTH;
  ctx.strokeStyle = colour;
  ctx.lineWidth = baseWidth;
  ctx.setLineDash(lineDash(style, baseWidth));
  for (const edge of [geom.plateLeft, geom.plateRight]) {
    if (edge.length < 2) continue;
    const sp = edge.map(toScreen);
    ctx.beginPath();
    ctx.moveTo(sp[0].x, sp[0].y);
    for (const s of sp.slice(1)) ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Studs.
  ctx.lineWidth = selected ? 1.8 : 1.3;
  for (const stud of geom.studs) {
    const c = stud.rect.map(toScreen);
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    ctx.lineTo(c[1].x, c[1].y);
    ctx.lineTo(c[2].x, c[2].y);
    ctx.lineTo(c[3].x, c[3].y);
    ctx.closePath();
    ctx.fillStyle = `${colour}22`;
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c[0].x, c[0].y);
    ctx.lineTo(c[2].x, c[2].y);
    if (stud.continuous) {
      // Corner-to-corner cross (architectural symbol for a continuous full-height member).
      ctx.moveTo(c[1].x, c[1].y);
      ctx.lineTo(c[3].x, c[3].y);
    }
    // Non-continuous members (trimmer/jack) get a single corner-to-corner diagonal only.
    ctx.stroke();
  }

  // Raked segments get a small plan label (the rake isn't visible in plan, but the heights matter).
  for (const rake of framing?.rakes ?? []) {
    const a = points[rake.segmentIndex];
    const b = points[rake.segmentIndex + 1];
    if (!a || !b) continue;
    const m = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    ctx.save();
    ctx.fillStyle = colour;
    ctx.font = "10px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`⟋ ${Math.round(rake.startMm)}→${Math.round(rake.endMm)}`, m.x, m.y - 8);
    ctx.restore();
  }

  // Windows get a glass centreline through the opening (the standard plan symbol).
  for (const opening of geom.openings) {
    if (opening.kind !== "window") continue;
    const d = opening.daylight.map(toScreen);
    const mid = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    const a = mid(d[0], d[3]);
    const b = mid(d[1], d[2]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = 1;
    ctx.strokeStyle = colour;
    ctx.stroke();
  }

  if (showVertices || selected) drawVertices(ctx, points.map(toScreen), colour, selected);
  ctx.restore();
}

// Measurement geometry is stored in `geometry_json` as PDF points with a
// Y-up, bottom-left origin — the same convention the snap engine produces
// (see resolveSnap / scheduleSnapResolution). Render it through pageToScreen
// so overlays and snap indicators stay in the same coordinate space.
// CostX styling: bold coloured outline, filled fill for closed (area) types,
// and filled circular vertex handles.
function drawOverlays(
  ctx: CanvasRenderingContext2D,
  measurements: MeasurementDto[],
  groupColours: Record<number, string>,
  groupProps: Record<number, GroupProps>,
  fallbackColour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  pageIndex: number,
  selectedIds: ReadonlySet<number>,
  editPreview: { id: number; points: PagePoint[] } | null,
  mmPerPoint: number | null,
) {
  const pageMeasurements = measurements.filter((measurement) => measurement.page_index === pageIndex);
  if (pageMeasurements.length === 0) return;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const measurement of pageMeasurements) {
    let points: PagePoint[];
    if (editPreview && editPreview.id === measurement.id) {
      points = editPreview.points;
    } else {
      try {
        points = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
    }

    if (!Array.isArray(points) || points.length < 1) continue;

    // Negative dimensions render in the group's negative colour/style; positive in its colour.
    const props = groupProps[measurement.dimension_group_id];
    const negative = (measurement.polarity ?? 1) < 0;
    const colour = negative
      ? props?.neg_colour ?? "#FF0000"
      : groupColours[measurement.dimension_group_id] ?? props?.pos_colour ?? fallbackColour;
    const style = negative ? props?.neg_style : props?.pos_style;
    const selected = selectedIds.has(measurement.id);

    // Count dimensions are point markers, not paths. "custom" groups stamp a scaled rectangle
    // instead of the ringed-cross marker, falling back to the marker if there's no page scale.
    if (measurement.measurement_type === "count") {
      const extents = props?.count_type === "custom" ? customCountHalfExtentsPx(props, mmPerPoint, zoom) : null;
      for (const point of points) {
        const s = pageToScreen(point.x, point.y, page.height_pts, pan, zoom);
        if (extents) {
          drawCustomCountShape(ctx, s.x, s.y, extents.halfW, extents.halfH, colour, selected, style);
        } else {
          drawCountMarker(ctx, s.x, s.y, colour, selected);
        }
      }
      continue;
    }

    // Timber-framing walls render as plates + studs (+ any openings), not a bare polyline.
    if (measurement.measurement_type === "timber_framing") {
      const settings = parseFramingSettings(props?.framing_props_json ?? null);
      const wallFraming = parseWallFraming(measurement.framing_json);
      drawFraming(ctx, points, settings, mmPerPoint, colour, style, pan, zoom, page, selected, false, wallFraming);
      continue;
    }

    // Array measurements render as N parallel line segments.
    if (measurement.measurement_type === "array") {
      if (points.length >= 2) {
        const meta = parseArrayMeta(measurement.framing_json ?? null);
        drawArray(ctx, [points[0], points[1]], meta, colour, style, pan, zoom, page, selected, false, mmPerPoint);
      }
      continue;
    }

    if (points.length < 2) continue;
    // "length"/"timber_framing"/"count" are open; everything else closes into an area.
    const isArea = isAreaType(measurement.measurement_type);
    const screenPts = points.map((point) => pageToScreen(point.x, point.y, page.height_pts, pan, zoom));

    ctx.strokeStyle = colour;
    const strokeWidth = selected ? MEASURE_LINE_WIDTH + 1.5 : MEASURE_LINE_WIDTH;
    ctx.lineWidth = strokeWidth;
    ctx.setLineDash(lineDash(style, strokeWidth));
    ctx.beginPath();
    ctx.moveTo(screenPts[0].x, screenPts[0].y);
    for (const screen of screenPts.slice(1)) {
      ctx.lineTo(screen.x, screen.y);
    }
    if (isArea) {
      ctx.closePath();
      ctx.fillStyle = `${colour}33`;
      ctx.fill();
    }
    ctx.stroke();
    ctx.setLineDash([]);

    drawVertices(ctx, screenPts, colour, selected);
  }

  ctx.restore();
}

/** Renders the in-progress path: committed draft vertices + a live rubber-band to the
 *  cursor. When `closed` (area draw), the polygon closes and fills as a preview. */
function drawDraft(
  ctx: CanvasRenderingContext2D,
  draftPoints: PagePoint[],
  livePoint: PagePoint | null,
  colour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  style?: string,
  closed = false,
) {
  if (draftPoints.length === 0) return;

  const pathPoints = livePoint ? [...draftPoints, livePoint] : draftPoints;
  const screenPts = pathPoints.map((point) => pageToScreen(point.x, point.y, page.height_pts, pan, zoom));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = colour;
  ctx.lineWidth = MEASURE_LINE_WIDTH;
  ctx.setLineDash(lineDash(style, MEASURE_LINE_WIDTH));
  ctx.beginPath();
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (const screen of screenPts.slice(1)) {
    ctx.lineTo(screen.x, screen.y);
  }
  if (closed && screenPts.length >= 3) {
    ctx.closePath();
    ctx.fillStyle = `${colour}33`;
    ctx.fill();
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Placed vertices are filled; the live endpoint (following the cursor) is hollow.
  const placedCount = draftPoints.length;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < screenPts.length; i += 1) {
    const isLive = livePoint !== null && i >= placedCount;
    ctx.beginPath();
    ctx.arc(screenPts[i].x, screenPts[i].y, VERTEX_RADIUS, 0, Math.PI * 2);
    if (isLive) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = colour;
    } else {
      ctx.fillStyle = colour;
      ctx.strokeStyle = "#ffffff";
    }
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawSnapIndicator(
  ctx: CanvasRenderingContext2D,
  snapPoint: SnapPoint | null,
  snapType: SnapType | null,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
) {
  if (!snapPoint || !snapType) return;

  const screen = pageToScreen(snapPoint.x, snapPoint.y, page.height_pts, pan, zoom);
  ctx.save();
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;

  if (snapType === "endpoint") {
    ctx.strokeRect(screen.x - 5, screen.y - 5, 10, 10);
  } else if (snapType === "midpoint") {
    ctx.beginPath();
    ctx.moveTo(screen.x, screen.y - 5);
    ctx.lineTo(screen.x + 5, screen.y + 5);
    ctx.lineTo(screen.x - 5, screen.y + 5);
    ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(screen.x - 5, screen.y - 5);
    ctx.lineTo(screen.x + 5, screen.y + 5);
    ctx.moveTo(screen.x + 5, screen.y - 5);
    ctx.lineTo(screen.x - 5, screen.y + 5);
    ctx.stroke();
  }

  ctx.restore();
}

/** Draws the line-mode proposed measurement: a bold coloured segment with endpoint dots. */
function drawLineSnapPreview(
  ctx: CanvasRenderingContext2D,
  start: SnapPoint,
  end: SnapPoint,
  colour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
) {
  const a = pageToScreen(start.x, start.y, page.height_pts, pan, zoom);
  const b = pageToScreen(end.x, end.y, page.height_pts, pan, zoom);
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = MEASURE_LINE_WIDTH + 1;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  // Endpoint diamonds as snap indicators.
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;
  ctx.globalAlpha = 1;
  for (const pt of [a, b]) {
    ctx.strokeRect(pt.x - 5, pt.y - 5, 10, 10);
  }
  ctx.restore();
}

/** Returns copies of measurements with all geometry points shifted by (dx, dy) in PDF points. */
function shiftMeasurements(measurements: MeasurementDto[], dx: number, dy: number): MeasurementDto[] {
  return measurements.map((m) => {
    try {
      const pts = JSON.parse(m.geometry_json) as PagePoint[];
      return { ...m, geometry_json: JSON.stringify(pts.map((p) => ({ x: p.x + dx, y: p.y + dy }))) };
    } catch {
      return m;
    }
  });
}

/** Flip a set of measurements about a centroid, mirroring the x or y coordinate of every vertex. */
function flipMeasurements(measurements: MeasurementDto[], centroid: PagePoint, axis: "x" | "y"): MeasurementDto[] {
  return measurements.map((m) => {
    try {
      const pts = JSON.parse(m.geometry_json) as PagePoint[];
      const flipped =
        axis === "x"
          ? pts.map((p) => ({ x: 2 * centroid.x - p.x, y: p.y }))
          : pts.map((p) => ({ x: p.x, y: 2 * centroid.y - p.y }));
      return { ...m, geometry_json: JSON.stringify(flipped) };
    } catch {
      return m;
    }
  });
}

/** Rotate a set of measurements 90° about a centroid; ccw=false rotates clockwise. */
function rotateMeasurements(measurements: MeasurementDto[], centroid: PagePoint, ccw: boolean): MeasurementDto[] {
  return measurements.map((m) => {
    try {
      const pts = JSON.parse(m.geometry_json) as PagePoint[];
      const rotated = pts.map((p) => {
        const rx = p.x - centroid.x;
        const ry = p.y - centroid.y;
        return ccw ? { x: centroid.x - ry, y: centroid.y + rx } : { x: centroid.x + ry, y: centroid.y - rx };
      });
      return { ...m, geometry_json: JSON.stringify(rotated) };
    } catch {
      return m;
    }
  });
}

/** Centroid (average of all vertices) of a set of measurements, in PDF points. */
function measurementsCentroid(measurements: MeasurementDto[]): PagePoint {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const m of measurements) {
    try {
      const pts = JSON.parse(m.geometry_json) as PagePoint[];
      for (const p of pts) {
        sumX += p.x;
        sumY += p.y;
        count += 1;
      }
    } catch {
      // skip unparseable
    }
  }
  return count > 0 ? { x: sumX / count, y: sumY / count } : { x: 0, y: 0 };
}

// ─── Array measurement utilities ──────────────────────────────────────────────

/** Unit perpendicular vector to the segment p1→p2, rotated 90° CCW (leftward). */
function arrayPerp(p1: PagePoint, p2: PagePoint): PagePoint {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 0, y: 1 };
  return { x: -dy / len, y: dx / len };
}

/** Signed perpendicular distance of cursor from the baseline (positive = left/CCW side). */
function arraySignedOffset(p1: PagePoint, p2: PagePoint, cursor: PagePoint): number {
  const perp = arrayPerp(p1, p2);
  return (cursor.x - p1.x) * perp.x + (cursor.y - p1.y) * perp.y;
}

/**
 * Compute all member line segments for an array.
 * Member 0 is the baseline; members 1..extraMembers are offset by spacingPts × direction.
 */
function getArrayMembers(p1: PagePoint, p2: PagePoint, meta: ArrayMeta): [PagePoint, PagePoint][] {
  const perp = arrayPerp(p1, p2);
  const members: [PagePoint, PagePoint][] = [];
  for (let i = 0; i <= meta.extraMembers; i += 1) {
    const offset = i * meta.spacingPts * meta.direction;
    members.push([
      { x: p1.x + perp.x * offset, y: p1.y + perp.y * offset },
      { x: p2.x + perp.x * offset, y: p2.y + perp.y * offset },
    ]);
  }
  return members;
}

/** Signed distance of point (px,py) from the infinite line through (lx1,ly1)→(lx2,ly2). */
function sideOfLine(px: number, py: number, lx1: number, ly1: number, lx2: number, ly2: number): number {
  return (lx2 - lx1) * (py - ly1) - (ly2 - ly1) * (px - lx1);
}

/**
 * Convert relative-stored trim coords back to absolute page coords by adding the baseline origin.
 * Trims are stored relative to the measurement's pts[0] so they move with the array automatically.
 */
function absTrims(trims: ArrayTrim[], origin: PagePoint): ArrayTrim[] {
  if (trims.length === 0) return trims;
  return trims.map((t): ArrayTrim => {
    if (t.kind === "box") {
      return {
        kind: "box",
        points: t.points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })),
        keepX: t.keepX + origin.x, keepY: t.keepY + origin.y,
      };
    }
    return {
      x1: t.x1 + origin.x, y1: t.y1 + origin.y,
      x2: t.x2 + origin.x, y2: t.y2 + origin.y,
      keepX: t.keepX + origin.x, keepY: t.keepY + origin.y,
    };
  });
}

/** Even-odd point-in-polygon test. */
function pointInPolygon(pt: PagePoint, poly: PagePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Parameter values t in (0,1) where segment AB crosses an edge of poly. */
function segmentPolygonCrossings(seg: [PagePoint, PagePoint], poly: PagePoint[]): number[] {
  const [a, b] = seg;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const c = poly[i];
    const d = poly[(i + 1) % poly.length];
    const ex = d.x - c.x;
    const ey = d.y - c.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denom;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denom;
    if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts;
}

/** Clip a segment to the inside or outside of a polygon, per trim.keepX/keepY. May yield 0..n pieces. */
function clipSegmentToBox(seg: [PagePoint, PagePoint], trim: BoxTrim): [PagePoint, PagePoint][] {
  const poly = trim.points;
  if (poly.length < 3) return [seg];
  const keepInside = pointInPolygon({ x: trim.keepX, y: trim.keepY }, poly);
  const [a, b] = seg;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-12) {
    return pointInPolygon(a, poly) === keepInside ? [seg] : [];
  }
  const ts = segmentPolygonCrossings(seg, poly).sort((x, y) => x - y);
  const breakpoints = [0, ...ts, 1];
  const result: [PagePoint, PagePoint][] = [];
  for (let i = 0; i < breakpoints.length - 1; i += 1) {
    const t0 = breakpoints[i];
    const t1 = breakpoints[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    const inside = pointInPolygon({ x: a.x + dx * tm, y: a.y + dy * tm }, poly);
    if (inside === keepInside) {
      result.push([
        { x: a.x + dx * t0, y: a.y + dy * t0 },
        { x: a.x + dx * t1, y: a.y + dy * t1 },
      ]);
    }
  }
  return result;
}

/**
 * Clips segment [A,B] to the half-plane containing trim.keepPt (line trim) or to the
 * inside/outside of the polygon containing trim.keepPt (box trim). May yield 0..n pieces.
 */
function clipSegmentToSide(seg: [PagePoint, PagePoint], trim: ArrayTrim): [PagePoint, PagePoint][] {
  if (trim.kind === "box") return clipSegmentToBox(seg, trim);

  const { x1, y1, x2, y2, keepX, keepY } = trim;
  // Negate sign: sideOfLine gives positive=left in math orientation, but in the Y-up page
  // coordinate system rendered to a Y-down screen the perceived left/right is inverted.
  const keepSign = -Math.sign(sideOfLine(keepX, keepY, x1, y1, x2, y2));
  if (keepSign === 0) return [seg]; // degenerate trim line

  const dA = sideOfLine(seg[0].x, seg[0].y, x1, y1, x2, y2);
  const dB = sideOfLine(seg[1].x, seg[1].y, x1, y1, x2, y2);
  const sideA = Math.sign(dA);
  const sideB = Math.sign(dB);

  const aKept = sideA === 0 || sideA === keepSign;
  const bKept = sideB === 0 || sideB === keepSign;

  if (aKept && bKept) return [seg];
  if (!aKept && !bKept) return [];

  // Compute intersection of segment with trim line.
  const denom = dA - dB;
  if (Math.abs(denom) < 1e-12) return aKept ? [seg] : [];
  const t = Math.max(0, Math.min(1, dA / denom));
  const ix = seg[0].x + t * (seg[1].x - seg[0].x);
  const iy = seg[0].y + t * (seg[1].y - seg[0].y);
  const inter: PagePoint = { x: ix, y: iy };

  // The member crosses the *infinite* trim line, but only clip it if that crossing
  // point falls within the drawn trim segment's extent — members outside the trim
  // line's extent are left untouched.
  const trimDx = x2 - x1;
  const trimDy = y2 - y1;
  const trimLenSq = trimDx * trimDx + trimDy * trimDy;
  if (trimLenSq > 1e-12) {
    const tTrim = ((ix - x1) * trimDx + (iy - y1) * trimDy) / trimLenSq;
    if (tTrim < 0 || tTrim > 1) return [seg];
  }

  return aKept ? [[seg[0], inter]] : [[inter, seg[1]]];
}

/** Apply all trims sequentially to a segment. Each trim may split a segment into multiple pieces. */
function applyTrimsToSegment(seg: [PagePoint, PagePoint], trims: ArrayTrim[]): [PagePoint, PagePoint][] {
  let segments: [PagePoint, PagePoint][] = [seg];
  for (const trim of trims) {
    const next: [PagePoint, PagePoint][] = [];
    for (const s of segments) next.push(...clipSegmentToSide(s, trim));
    segments = next;
    if (segments.length === 0) return [];
  }
  return segments;
}

/** Whether applying `trim` to `seg` changes it (i.e. the trim shape actually crosses this member). */
function trimAffectsSegment(seg: [PagePoint, PagePoint], trim: ArrayTrim): boolean {
  const result = clipSegmentToSide(seg, trim);
  if (result.length !== 1) return true;
  const [r] = result;
  const eps = 1e-9;
  const same =
    Math.abs(r[0].x - seg[0].x) < eps && Math.abs(r[0].y - seg[0].y) < eps &&
    Math.abs(r[1].x - seg[1].x) < eps && Math.abs(r[1].y - seg[1].y) < eps;
  return !same;
}

/** A member rectangle (4 corners) for a Joist/Rafter member run from `a` to `b`, `halfWidthPts`
 *  either side of the centreline — the same "45mm wide" plan-view footprint used by Timber
 *  Framing's studs (STUD_THICKNESS_MM is constant across every FRAMING_SIZES option). */
function arrayMemberRect(a: PagePoint, b: PagePoint, halfWidthPts: number): PagePoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  return [
    { x: a.x + nx * halfWidthPts, y: a.y + ny * halfWidthPts },
    { x: b.x + nx * halfWidthPts, y: b.y + ny * halfWidthPts },
    { x: b.x - nx * halfWidthPts, y: b.y - ny * halfWidthPts },
    { x: a.x - nx * halfWidthPts, y: a.y - ny * halfWidthPts },
  ];
}

/** Fill+stroke one member as a plain dimensional rectangle (no corner-to-corner cross — unlike
 *  Timber Framing's stud symbol, a Joist/Rafter member is just its real-world footprint).
 *  `screenRect` is already in screen space. */
function fillArrayMemberRect(ctx: CanvasRenderingContext2D, screenRect: { x: number; y: number }[], colour: string, lineWidth: number) {
  const [c0, c1, c2, c3] = screenRect;
  ctx.beginPath();
  ctx.moveTo(c0.x, c0.y);
  ctx.lineTo(c1.x, c1.y);
  ctx.lineTo(c2.x, c2.y);
  ctx.lineTo(c3.x, c3.y);
  ctx.closePath();
  ctx.fillStyle = `${colour}22`;
  ctx.fill();
  ctx.strokeStyle = colour;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

/** Render a committed or draft array onto the canvas. Each (trimmed) member is drawn as a
 *  dimensional rectangle at the timber's real-world 45mm plan-view width when a page scale is
 *  available, falling back to a plain centreline (like Timber Framing's own no-scale fallback)
 *  otherwise. */
function drawArray(
  ctx: CanvasRenderingContext2D,
  baseline: [PagePoint, PagePoint],
  meta: ArrayMeta,
  colour: string,
  style: string | undefined,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  selected: boolean,
  showVertices: boolean,
  mmPerPoint: number | null,
) {
  const members = getArrayMembers(baseline[0], baseline[1], meta);
  const absTrimsList = absTrims(meta.trims, baseline[0]);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const halfWidthPts = mmPerPoint && mmPerPoint > 0 ? STUD_THICKNESS_MM / mmPerPoint / 2 : 0;

  if (halfWidthPts > 0) {
    const lineWidth = selected ? 1.8 : 1.3;
    for (const member of members) {
      for (const clipped of applyTrimsToSegment(member, absTrimsList)) {
        const rect = arrayMemberRect(clipped[0], clipped[1], halfWidthPts).map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
        fillArrayMemberRect(ctx, rect, colour, lineWidth);
      }
    }
  } else {
    ctx.strokeStyle = colour;
    const arrayWidth = selected ? MEASURE_LINE_WIDTH + 1.5 : MEASURE_LINE_WIDTH;
    ctx.lineWidth = arrayWidth;
    ctx.setLineDash(lineDash(style, arrayWidth));
    for (const member of members) {
      for (const clipped of applyTrimsToSegment(member, absTrimsList)) {
        const a = pageToScreen(clipped[0].x, clipped[0].y, page.height_pts, pan, zoom);
        const b = pageToScreen(clipped[1].x, clipped[1].y, page.height_pts, pan, zoom);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  if (showVertices || selected) {
    const screenPts = baseline.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
    drawVertices(ctx, screenPts, colour, selected);
  }
  ctx.restore();
}

/** Render a ghost array during extrusion (in-progress drawing). */
function drawArrayDraft(
  ctx: CanvasRenderingContext2D,
  baseline: [PagePoint, PagePoint],
  extraMembers: number,
  direction: number,
  spacingPts: number,
  colour: string,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  mmPerPoint: number | null,
) {
  const meta: ArrayMeta = { extraMembers, spacingPts, direction, trims: [] };
  const members = getArrayMembers(baseline[0], baseline[1], meta);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([]);

  const halfWidthPts = mmPerPoint && mmPerPoint > 0 ? STUD_THICKNESS_MM / mmPerPoint / 2 : 0;

  // Baseline drawn at full opacity; extra members at reduced opacity.
  for (let i = 0; i < members.length; i += 1) {
    ctx.globalAlpha = i === 0 ? 1 : 0.7;
    if (halfWidthPts > 0) {
      const rect = arrayMemberRect(members[i][0], members[i][1], halfWidthPts).map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
      fillArrayMemberRect(ctx, rect, colour, 1.3);
    } else {
      const a = pageToScreen(members[i][0].x, members[i][0].y, page.height_pts, pan, zoom);
      const b = pageToScreen(members[i][1].x, members[i][1].y, page.height_pts, pan, zoom);
      ctx.strokeStyle = colour;
      ctx.lineWidth = MEASURE_LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Draw the pitch-direction pick's live preview: a dashed line from the clicked start point to
 * the cursor, snapped to whichever page axis (X or Y) the cursor's offset from start currently
 * favours — small arrowheads at both ends echo the double-headed direction indicator shown on
 * hover once a pitch is set.
 */
function drawPitchDirectionOutline(
  ctx: CanvasRenderingContext2D,
  start: PagePoint,
  livePoint: PagePoint,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
) {
  const dx = livePoint.x - start.x;
  const dy = livePoint.y - start.y;
  if (Math.hypot(dx, dy) < 1e-6) return;
  const axisIsX = Math.abs(dx) >= Math.abs(dy);
  const end: PagePoint = axisIsX ? { x: livePoint.x, y: start.y } : { x: start.x, y: livePoint.y };

  const a = pageToScreen(start.x, start.y, page.height_pts, pan, zoom);
  const b = pageToScreen(end.x, end.y, page.height_pts, pan, zoom);
  ctx.save();
  ctx.strokeStyle = "#00E5FF";
  ctx.fillStyle = "#00E5FF";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // Small arrowheads at both ends, oriented along the snapped line.
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const headLen = 9;
  const headAngle = Math.PI / 7;
  for (const [tip, dir] of [
    [a, angle + Math.PI],
    [b, angle],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - headLen * Math.cos(dir - headAngle), tip.y - headLen * Math.sin(dir - headAngle));
    ctx.lineTo(tip.x - headLen * Math.cos(dir + headAngle), tip.y - headLen * Math.sin(dir + headAngle));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Page-space anchor for the pitch-direction hover indicator: the shape's centroid (average of its
 * points, a good-enough anchor for this affordance) plus its own extent *along the pitch
 * direction*, used as the arrow's reach — not the bounding-box diagonal, which is ≥ the shape's
 * extent along any single axis and so overshoots past the shape's edges for anything that isn't
 * square. Projecting each point onto the direction vector and taking half the (max − min) span
 * keeps the arrow inscribed inside the shape, touching its edges rather than extending past them.
 * Deliberately left in page space — see the `pitchIndicator` field comment on `HoverCardData` for
 * why the screen transform is applied at render time instead of here.
 */
function computePitchIndicator(points: PagePoint[], pitchDeg: number, dirRad: number) {
  const cxPt = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cyPt = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const dirX = Math.cos(dirRad);
  const dirY = Math.sin(dirRad);
  const projections = points.map((p) => (p.x - cxPt) * dirX + (p.y - cyPt) * dirY);
  // A little inset (0.85x) so the arrowheads sit just inside the shape's outline rather than
  // exactly on top of it.
  const halfDiagPts = ((Math.max(...projections) - Math.min(...projections)) / 2 || 40) * 0.85;
  return { cxPt, cyPt, dirRad, pitchDeg, halfDiagPts };
}

/** Draw the in-progress trim outline: a dashed line for "line" trim, or a dashed polygon for "box" trim. */
function drawArrayTrimOutline(
  ctx: CanvasRenderingContext2D,
  draft: PagePoint[],
  livePoint: PagePoint | null,
  trimType: "line" | "box",
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
) {
  const path = livePoint ? [...draft, livePoint] : draft;
  if (path.length < 2) return;
  ctx.save();
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  const screenPts = path.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
  ctx.moveTo(screenPts[0].x, screenPts[0].y);
  for (let i = 1; i < screenPts.length; i += 1) ctx.lineTo(screenPts[i].x, screenPts[i].y);
  if (trimType === "box" && draft.length >= 3) {
    // Close the polygon back to the start once at least a triangle is drawn.
    ctx.lineTo(screenPts[0].x, screenPts[0].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Render the ghost trim preview: ghost highlighting showing which array
 * members on the kept side of `ghostTrim` are still visible.
 */
function drawArrayTrimPreview(
  ctx: CanvasRenderingContext2D,
  ghostTrim: ArrayTrim,
  measurements: MeasurementDto[],
  groupProps: Record<number, GroupProps>,
  pan: { x: number; y: number },
  zoom: number,
  page: PageMeta,
  pageIndex: number,
  activeDimensionGroupId: number | null,
) {
  ctx.save();

  for (const m of measurements) {
    if (m.page_index !== pageIndex) continue;
    if (m.measurement_type !== "array") continue;
    if (activeDimensionGroupId !== null && m.dimension_group_id !== activeDimensionGroupId) continue;
    let pts: PagePoint[];
    try { pts = JSON.parse(m.geometry_json); } catch { continue; }
    if (!Array.isArray(pts) || pts.length < 2) continue;

    const meta = parseArrayMeta(m.framing_json ?? null);
    const members = getArrayMembers(pts[0], pts[1], meta);
    const props = groupProps[m.dimension_group_id];
    const col = props?.pos_colour ?? "#4A9EFF";

    ctx.strokeStyle = col;
    ctx.lineWidth = MEASURE_LINE_WIDTH;
    ctx.lineCap = "round";
    ctx.setLineDash([]);

    const absMeta = absTrims(meta.trims, pts[0]);

    // Pass 1: draw all existing-trimmed members dimly (shows the full shape as context).
    ctx.globalAlpha = 0.2;
    for (const member of members) {
      for (const seg of applyTrimsToSegment(member, absMeta)) {
        const a = pageToScreen(seg[0].x, seg[0].y, page.height_pts, pan, zoom);
        const b = pageToScreen(seg[1].x, seg[1].y, page.height_pts, pan, zoom);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Pass 2: draw only the kept portions brightly (shows what will survive the trim).
    ctx.globalAlpha = 0.9;
    for (const member of members) {
      for (const afterExisting of applyTrimsToSegment(member, absMeta)) {
        for (const kept of clipSegmentToSide(afterExisting, ghostTrim)) {
          const a = pageToScreen(kept[0].x, kept[0].y, page.height_pts, pan, zoom);
          const b = pageToScreen(kept[1].x, kept[1].y, page.height_pts, pan, zoom);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

type ScaleUnit = "mm" | "cm" | "m";

/** Prompts for the real-world length of a drawn calibration line, then reports it in mm. */
function CalibrationDialog({
  pixelLength,
  onConfirm,
  onCancel,
}: {
  pixelLength: number;
  onConfirm: (realMm: number, unit: ScaleUnit) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<ScaleUnit>("m");

  function confirm() {
    const numeric = Number.parseFloat(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    const mm = unit === "m" ? numeric * 1000 : unit === "cm" ? numeric * 10 : numeric;
    onConfirm(mm, unit);
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.4)",
        zIndex: 20,
      }}
    >
      <div
        style={{
          width: 300,
          padding: 16,
          background: "var(--bg-pane)",
          color: "var(--text-primary)",
          border: "1px solid var(--border-divider)",
          borderRadius: 4,
          fontFamily: "Segoe UI, sans-serif",
          fontSize: 12,
        }}
      >
        <div style={{ fontSize: 13, marginBottom: 10 }}>Set page scale</div>
        <div style={{ color: "var(--text-secondary)", marginBottom: 12 }}>
          Enter the real-world length of the line you drew ({pixelLength.toFixed(1)} pt).
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          <input
            autoFocus
            type="number"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirm();
              if (event.key === "Escape") onCancel();
            }}
            placeholder="e.g. 2.5"
            style={{
              flex: 1,
              height: 28,
              padding: "0 8px",
              background: "var(--bg-input)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-divider)",
              borderRadius: 3,
            }}
          />
          <select
            value={unit}
            onChange={(event) => setUnit(event.target.value as ScaleUnit)}
            style={{
              height: 28,
              padding: "0 6px",
              background: "var(--bg-input)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-divider)",
              borderRadius: 3,
            }}
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="m">m</option>
          </select>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ height: 26, padding: "0 12px", background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--border-divider)", borderRadius: 3, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            style={{ height: 26, padding: "0 12px", background: "var(--color-accent)", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer" }}
          >
            Set Scale
          </button>
        </div>
      </div>
    </div>
  );
}

export function ViewerCanvas({
  doc,
  pageIndex,
  onStatusChange,
  overlayMeasurements = [],
  overlayColour = "#4A9EFF",
  groupColours = {},
}: ViewerCanvasProps) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 });
  const [tiles, setTiles] = useState<Map<string, TileData>>(new Map());
  const [previews, setPreviews] = useState<Map<number, PreviewData>>(new Map());
  const [imageVersion, setImageVersion] = useState(0);
  // Settle-pass state: only drawn when it exactly matches the current pan/zoom/page/dpr
  // (checked at draw time) — any subsequent input makes it stale and it's simply not
  // drawn until a fresh one lands, falling back to the tile layer in the meantime.
  const [settleView, setSettleView] = useState<SettleViewState | null>(null);
  const settleImageRef = useRef<ImageBitmap | null>(null);
  const settleRequestIdRef = useRef(0);

  // --- Linear measure tool (M2) ---
  const [draftPoints, setDraftPoints] = useState<PagePoint[]>([]);
  const [cursorPagePoint, setCursorPagePoint] = useState<PagePoint | null>(null);
  const [cursorClient, setCursorClient] = useState<{ x: number; y: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverCardData | null>(null);
  // Live geometry of the dimension whose vertex is being dragged (select mode).
  const [editPreview, setEditPreview] = useState<{ id: number; points: PagePoint[] } | null>(null);
  const [viewerMenu, setViewerMenu] = useState<{ x: number; y: number; items: ViewerMenuItem[] } | null>(null);
  // Live ghost position while placing a door/window opening (select the wall + arc-length).
  const [openingGhost, setOpeningGhost] = useState<{ measurementId: number; segmentIndex: number; centreMm: number } | null>(null);
  // Right-click → Door options: the opening being edited in place.
  const [pendingOpeningEdit, setPendingOpeningEdit] = useState<{ measurementId: number; index: number; template: OpeningTemplate } | null>(null);
  // Right-click → Set Raking Frame: the segment being raked.
  const [pendingRake, setPendingRake] = useState<{
    measurementId: number;
    segmentIndex: number;
    start: number;
    end: number;
    gable: boolean;
    middle?: number;
    middlePosition?: number;
    segLenMm: number;
    startPoint: PagePoint;
    endPoint: PagePoint;
  } | null>(null);
  // Ctrl-hover (select mode): ghost position for a manually-placed extra stud.
  const [studGhost, setStudGhost] = useState<{ measurementId: number; segmentIndex: number; centreMm: number } | null>(null);
  // Right-click → Double studs → Select studs: interactive stud-pick mode.
  const [doubleStudSelect, setDoubleStudSelect] = useState<{
    measurementId: number;
    pending: { segmentIndex: number; centreMm: number }[];
    hoverPos: { segmentIndex: number; centreMm: number } | null;
  } | null>(null);
  // Right-click → View wall in 3D: the wall shown in the isolated 3D modal.
  const [wall3dId, setWall3dId] = useState<number | null>(null);
  // Marquee rubber-band selection
  const [marqueeState, setMarqueeState] = useState<{ startClient: { x: number; y: number }; endClient: { x: number; y: number } } | null>(null);
  const marqueeRef = useRef<{ startClient: { x: number; y: number }; pointerId: number } | null>(null);
  // Move mode: selected measurements follow the cursor; anchorPage = centroid when move started
  const [moveMode, setMoveMode] = useState<{ anchorPage: PagePoint } | null>(null);
  const moveModeRef = useRef<{ anchorPage: PagePoint } | null>(null);
  // Copy/paste clipboard
  const [clipboard, setClipboard] = useState<MeasurementDto[]>([]);
  const clipboardRef = useRef<MeasurementDto[]>([]);
  // Paste ghost mode: centroid = clipboard centroid; ghost follows cursor
  const [pasteMode, setPasteMode] = useState<{ centroid: PagePoint } | null>(null);
  const pasteModeRef = useRef<{ centroid: PagePoint } | null>(null);

  // Array extrusion: how many extra members (beyond the baseline) and in which direction.
  const [arrayExtraMembers, setArrayExtraMembers] = useState(0);
  const [arrayDirection, setArrayDirection] = useState(1);
  const arrayExtraMembersRef = useRef(0);
  const arrayDirectionRef = useRef(1);
  // Array trim tool: in-progress trim line (0, 1, or 2 points) and the kept-side reference point.
  const [arrayTrimDraft, setArrayTrimDraft] = useState<PagePoint[]>([]);
  const [arrayTrimKeepPt, setArrayTrimKeepPt] = useState<PagePoint | null>(null);
  const arrayTrimDraftRef = useRef<PagePoint[]>([]);
  // Pitch-direction pick gesture: the first click's page point, or null before it's placed.
  const [pitchPickStart, setPitchPickStart] = useState<PagePoint | null>(null);

  const vertexDragRef = useRef<{ measurementId: number; vertexIndex: number } | null>(null);
  const draftPointsRef = useRef<PagePoint[]>([]);
  const shiftHeldRef = useRef(false);
  const [shiftHeld, setShiftHeld] = useState(false);
  // Scale-calibration capture: up to two clicked points, then the length dialog.
  const [calibPoints, setCalibPoints] = useState<PagePoint[]>([]);
  const [calibDialog, setCalibDialog] = useState<{ pixelLength: number } | null>(null);
  const calibPointsRef = useRef<PagePoint[]>([]);
  // Last placed vertex on this page; lets Ctrl+click resume a path even after the
  // previous dimension was committed (CostX behaviour).
  const lastEndpointRef = useRef<PagePoint | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageCacheRef = useRef<Map<string, HTMLImageElement | ImageBitmap>>(new Map());
  const loadingImagesRef = useRef<Set<string>>(new Set());
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; panX: number; panY: number } | null>(null);
  const snapFrameRef = useRef<number | null>(null);
  const latestSnapPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastViewerCommandSeq = useRef(0);

  const lightMode = useAppStore((state) => state.lightMode);
  const snapPoint = useAppStore((state) => state.snapPoint);
  const snapType = useAppStore((state) => state.snapType);
  const drawingType = useAppStore((state) => state.drawingType);
  const lineSnapResult = useAppStore((state) => state.lineSnapResult);
  const loadVectors = useAppStore((state) => state.loadVectors);
  const resolveSnap = useAppStore((state) => state.resolveSnap);
  const resolveLineSnap = useAppStore((state) => state.resolveLineSnap);
  const clearSnap = useAppStore((state) => state.clearSnap);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const createMeasurement = useAppStore((state) => state.createMeasurement);
  const updateMeasurementGeometry = useAppStore((state) => state.updateMeasurementGeometry);
  const viewerCommand = useAppStore((state) => state.viewerCommand);
  const updateMeasurementFraming = useAppStore((state) => state.updateMeasurementFraming);
  const deleteMeasurement = useAppStore((state) => state.deleteMeasurement);
  const openingPlacement = useAppStore((state) => state.openingPlacement);
  const setOpeningPlacement = useAppStore((state) => state.setOpeningPlacement);
  const arrayTrimMode = useAppStore((state) => state.arrayTrimMode);
  const setArrayTrimMode = useAppStore((state) => state.setArrayTrimMode);
  const arrayTrimType = useAppStore((state) => state.arrayTrimType);
  const pitchDirectionMode = useAppStore((state) => state.pitchDirectionMode);
  const resolvePitchDirectionPick = useAppStore((state) => state.resolvePitchDirectionPick);
  const activeDimensionGroupId = useAppStore((state) => state.activeDimensionGroupId);
  const activeDrawingId = useAppStore((state) => state.activeDrawingId);
  const viewerMode = useAppStore((state) => state.viewerMode);
  const selectedMeasurementIds = useAppStore((state) => state.selectedMeasurementIds);
  const selectMeasurement = useAppStore((state) => state.selectMeasurement);
  const toggleSelectMeasurement = useAppStore((state) => state.toggleSelectMeasurement);
  const setSelectedMeasurementIds = useAppStore((state) => state.setSelectedMeasurementIds);
  const pageScale = useAppStore((state) => state.pageScale);
  const calibrating = useAppStore((state) => state.calibrating);
  const setCalibrating = useAppStore((state) => state.setCalibrating);
  const setPageScale = useAppStore((state) => state.setPageScale);
  const loadPageScale = useAppStore((state) => state.loadPageScale);
  const groupProps = useAppStore((state) => state.groupProps);
  const dimensionRoots = useAppStore((state) => state.dimensionRoots);
  const childCache = useAppStore((state) => state.childCache);
  const drawPolarity = useAppStore((state) => state.drawPolarity);
  const drawingDimmer = useAppStore((state) => state.drawingDimmer);

  // Colour/style the in-progress draft takes from the active group + current polarity.
  const activeProps = activeDimensionGroupId !== null ? groupProps[activeDimensionGroupId] : undefined;
  const draftNegative = drawPolarity < 0;
  const draftColour = draftNegative ? activeProps?.neg_colour ?? "#FF0000" : overlayColour;
  const draftStyle = draftNegative ? activeProps?.neg_style : activeProps?.pos_style;
  // Area groups draw closed polygons (≥3 vertices); count groups place single-click markers.
  const drawingArea = activeProps?.measurement_type === "area";
  const drawingCount = activeProps?.measurement_type === "count";
  const drawingFraming = activeProps?.measurement_type === "timber_framing";
  const drawingArray = activeProps?.measurement_type === "array";
  // Spacing in PDF points: default_width stores metres; convert using page scale.
  const arraySpacingPts = (() => {
    const spacingM = activeProps?.default_width ?? 0.6;
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!mmpp || mmpp <= 0) return 0;
    return (spacingM * 1000) / mmpp;
  })();

  const selectedSet = useMemo(() => new Set(selectedMeasurementIds), [selectedMeasurementIds]);
  // Vertex drag only available when exactly one measurement is selected.
  const singleSelectedId = selectedMeasurementIds.length === 1 ? selectedMeasurementIds[0] : null;

  const page = doc?.pages[pageIndex] ?? null;
  // Add-mode is active when a dimension group is selected, a page is open, and the
  // viewer isn't in select/edit or scale-calibration mode.
  // Opening placement overrides add/select while active.
  const measuring = viewerMode === "add" && activeDimensionGroupId !== null && page !== null && !calibrating && !openingPlacement;
  const selectMode = viewerMode === "select" && page !== null && !calibrating && !openingPlacement;
  const preview = previews.get(pageIndex) ?? null;
  const pageSize = useMemo(() => (page ? pagePixelSize(page, zoom) : { width: 0, height: 0 }), [page, zoom]);
  const activeZoomBucket = zoomBucket(zoom);

  // Read by mergeTiles (a stable-identity callback held by the tile-event listener)
  // to evict against the *current* page/bucket without resubscribing the listener.
  const pageIndexRef = useRef(pageIndex);
  const activeZoomBucketRef = useRef(activeZoomBucket);
  // 0 so the very first viewport update after a document/page load fires immediately.
  const lastViewportRequestRef = useRef(0);
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  }, [pageIndex]);
  useEffect(() => {
    activeZoomBucketRef.current = activeZoomBucket;
  }, [activeZoomBucket]);

  // Update draft vertices through one helper so the ref (read synchronously by
  // pointer/keyboard handlers) and the state (drives rendering) never diverge —
  // a plain mirror effect can lag within a single double-click burst.
  const applyDraft = useCallback((updater: PagePoint[] | ((prev: PagePoint[]) => PagePoint[])) => {
    const next = typeof updater === "function" ? updater(draftPointsRef.current) : updater;
    draftPointsRef.current = next;
    setDraftPoints(next);
  }, []);

  // Abandon any in-progress path when add-mode ends.
  useEffect(() => {
    if (!measuring) {
      applyDraft([]);
      lastEndpointRef.current = null;
      arrayExtraMembersRef.current = 0;
      arrayDirectionRef.current = 1;
      setArrayExtraMembers(0);
      setArrayDirection(1);
    }
  }, [measuring, applyDraft]);

  // Reset trim state when trim mode is toggled off, or the trim type is switched mid-draft.
  useEffect(() => {
    if (!arrayTrimMode) {
      setArrayTrimDraft([]);
      arrayTrimDraftRef.current = [];
      setArrayTrimKeepPt(null);
    }
  }, [arrayTrimMode]);

  // Reset the pitch-direction pick whenever the mode is toggled off (committed or cancelled).
  useEffect(() => {
    if (!pitchDirectionMode) setPitchPickStart(null);
  }, [pitchDirectionMode]);

  useEffect(() => {
    setArrayTrimDraft([]);
    arrayTrimDraftRef.current = [];
    setArrayTrimKeepPt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrayTrimType]);

  // A fresh page has no in-progress path or resumable endpoint.
  useEffect(() => {
    applyDraft([]);
    lastEndpointRef.current = null;
    setHoverInfo(null);
    setArrayTrimDraft([]);
    arrayTrimDraftRef.current = [];
    setArrayTrimKeepPt(null);
  }, [pageIndex, doc?.path, applyDraft]);

  // Load the scale for whichever drawing page is in view.
  useEffect(() => {
    if (activeDrawingId === null || !page) return;
    void loadPageScale(activeDrawingId, pageIndex);
  }, [activeDrawingId, pageIndex, page, loadPageScale]);

  const applyCalib = useCallback((points: PagePoint[]) => {
    calibPointsRef.current = points;
    setCalibPoints(points);
  }, []);

  // Reset the calibration capture whenever it is started or stopped.
  useEffect(() => {
    applyCalib([]);
    setCalibDialog(null);
  }, [calibrating, pageIndex, doc?.path, applyCalib]);

  // Screen (client) coords → page point in PDF points, Y-up.
  const clientToPagePoint = useCallback(
    (clientX: number, clientY: number): PagePoint | null => {
      const element = viewportRef.current;
      if (!element || !page) return null;
      const rect = element.getBoundingClientRect();
      const scale = (zoom * 96) / 72;
      return {
        x: (clientX - rect.left + pan.x) / scale,
        y: page.height_pts - (clientY - rect.top + pan.y) / scale,
      };
    },
    [page, pan.x, pan.y, zoom],
  );

  // The point to commit at a click: snap target if one is live (and Shift is not held), else raw cursor.
  const placementPoint = useCallback(
    (clientX: number, clientY: number): PagePoint | null => {
      if (!shiftHeldRef.current) {
        const snap = useAppStore.getState().snapPoint;
        if (snap) return snap;
      }
      return clientToPagePoint(clientX, clientY);
    },
    [clientToPagePoint],
  );

  const commitDraft = useCallback(
    async (points: PagePoint[]) => {
      // Drop consecutive duplicate vertices (e.g. a click that lands on the last point).
      const cleaned = points.filter(
        (point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 1e-6,
      );
      // Areas need ≥3 vertices to enclose a region; lines need ≥2.
      const minPoints = drawingArea ? 3 : 2;
      if (cleaned.length < minPoints) {
        if (cleaned.length >= 1) onStatusChange(drawingArea ? "An area needs at least 3 points" : "A line needs at least 2 points");
        return;
      }
      // Remember the path's end so Ctrl+click can resume from it after commit.
      lastEndpointRef.current = cleaned[cleaned.length - 1];
      try {
        // The active group's measurement type and the current draw polarity are applied
        // in the store; here we only supply the geometry.
        await createMeasurement({ geometryJson: JSON.stringify(cleaned) });
      } catch (error) {
        onStatusChange(`ERROR: ${error}`);
      }
    },
    [createMeasurement, onStatusChange, drawingArea],
  );

  const commitArrayDraft = useCallback(
    async (baseline: [PagePoint, PagePoint], extraMembers: number, direction: number) => {
      const meta: ArrayMeta = {
        extraMembers,
        spacingPts: arraySpacingPts,
        direction,
        trims: [],
      };
      try {
        const created = await createMeasurement({ geometryJson: JSON.stringify(baseline) });
        if (created) {
          await updateMeasurementFraming(created.id, serializeArrayMeta(meta));
        }
        lastEndpointRef.current = baseline[1];
      } catch (error) {
        onStatusChange(`ERROR: ${error}`);
      }
    },
    [arraySpacingPts, createMeasurement, updateMeasurementFraming, onStatusChange],
  );

  const commitArrayTrim = useCallback(
    async (absTrim: ArrayTrim) => {
      const targets = overlayMeasurements.filter(
        (m) => m.page_index === pageIndex && m.measurement_type === "array" &&
          (activeDimensionGroupId === null || m.dimension_group_id === activeDimensionGroupId),
      );
      // Only trim measurements whose members are actually affected by the trim shape.
      for (const m of targets) {
        let pts: PagePoint[];
        try { pts = JSON.parse(m.geometry_json); } catch { continue; }
        if (!Array.isArray(pts) || pts.length < 2) continue;
        const existingMeta = parseArrayMeta(m.framing_json ?? null);
        const members = getArrayMembers(pts[0], pts[1], existingMeta);
        const anyAffected = members.some((seg) => trimAffectsSegment(seg, absTrim));
        if (!anyAffected) continue;
        // Store trim relative to pts[0] so it follows the array if the geometry is moved.
        const [relTrim] = absTrims([absTrim], { x: -pts[0].x, y: -pts[0].y });
        const updated: ArrayMeta = { ...existingMeta, trims: [...existingMeta.trims, relTrim] };
        try {
          await updateMeasurementFraming(m.id, serializeArrayMeta(updated));
        } catch (error) {
          onStatusChange(`ERROR: ${error}`);
        }
      }
      // Clear trim draft after committing.
      setArrayTrimDraft([]);
      arrayTrimDraftRef.current = [];
      setArrayTrimKeepPt(null);
    },
    [overlayMeasurements, pageIndex, activeDimensionGroupId, updateMeasurementFraming, onStatusChange],
  );

  // Metadata entries only (tiles map), but each one keeps a decoded ImageBitmap alive
  // in imageCacheRef (~1 MB uncompressed per 512² tile regardless of PNG size) — so an
  // unbounded map on a long session is a real memory leak, not just bookkeeping bloat.
  // Cap it and evict tiles for other pages / far zoom buckets first.
  const MAX_TILE_ENTRIES = 800;

  const mergeTiles = useCallback((incoming: TileData[]) => {
    if (incoming.length === 0) return;
    setTiles((current) => {
      const next = new Map(current);
      for (const tile of incoming) {
        next.set(tileId(tile.key), tile);
      }
      if (next.size > MAX_TILE_ENTRIES) {
        const currentPage = pageIndexRef.current;
        const currentBucket = activeZoomBucketRef.current;
        for (const [id, tile] of next) {
          if (next.size <= MAX_TILE_ENTRIES) break;
          const keep = tile.key.page === currentPage && Math.abs(tile.key.zoom_level - currentBucket) <= 1;
          if (keep) continue;
          next.delete(id);
          const image = imageCacheRef.current.get(tile.image_path);
          if (image instanceof ImageBitmap) image.close();
          imageCacheRef.current.delete(tile.image_path);
          loadingImagesRef.current.delete(tile.image_path);
        }
      }
      return next;
    });
  }, []);

  // Previews are still PNG files on disk, loaded through the asset protocol.
  const loadPreviewImage = useCallback((imagePath: string) => {
    if (imageCacheRef.current.has(imagePath) || loadingImagesRef.current.has(imagePath)) return;

    loadingImagesRef.current.add(imagePath);
    const image = new Image();
    image.onload = () => {
      imageCacheRef.current.set(imagePath, image);
      loadingImagesRef.current.delete(imagePath);
      setImageVersion((version) => version + 1);
    };
    image.onerror = () => {
      loadingImagesRef.current.delete(imagePath);
    };
    image.src = convertFileSrc(imagePath);
  }, []);

  // Tiles live in the backend's in-memory store, served over the custom `tile`
  // scheme (WebView2 exposes it as http://tile.localhost/). createImageBitmap
  // decodes off the main thread, unlike <img>. A 404 means the store evicted the
  // entry; the next update_viewport round re-queues the tile, so just drop it.
  const loadTileImage = useCallback((key: string) => {
    if (imageCacheRef.current.has(key) || loadingImagesRef.current.has(key)) return;

    loadingImagesRef.current.add(key);
    fetch(`http://tile.localhost/${key}`)
      .then((response) => {
        if (!response.ok) throw new Error(`tile fetch failed: ${response.status}`);
        return response.blob();
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        imageCacheRef.current.set(key, bitmap);
        loadingImagesRef.current.delete(key);
        setImageVersion((version) => version + 1);
      })
      .catch(() => {
        loadingImagesRef.current.delete(key);
      });
  }, []);

  useEffect(() => {
    setTiles(new Map());
    setPreviews(new Map());
    for (const image of imageCacheRef.current.values()) {
      // ImageBitmaps hold GPU-backed memory; release deterministically rather than
      // waiting for GC.
      if (image instanceof ImageBitmap) image.close();
    }
    imageCacheRef.current.clear();
    loadingImagesRef.current.clear();
    settleImageRef.current?.close();
    settleImageRef.current = null;
    setSettleView(null);
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, [doc?.path]);

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
    clearSnap();
    settleImageRef.current?.close();
    settleImageRef.current = null;
    setSettleView(null);
  }, [pageIndex]);

  useEffect(() => {
    if (!doc || !page) {
      clearSnap();
      return;
    }

    let cancelled = false;
    loadVectors(pageIndex).catch((e) => {
      if (!cancelled) onStatusChange(`ERROR: ${e}`);
    });

    return () => {
      cancelled = true;
    };
  }, [clearSnap, doc, loadVectors, onStatusChange, page, pageIndex]);

  useEffect(() => {
    return () => {
      if (snapFrameRef.current !== null) {
        window.cancelAnimationFrame(snapFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const updateSize = () => {
      setViewportSize({
        width: Math.max(1, element.clientWidth),
        height: Math.max(1, element.clientHeight),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    for (const previewData of previews.values()) {
      loadPreviewImage(previewData.image_path);
    }
    for (const tile of tiles.values()) {
      loadTileImage(tile.image_path);
    }
  }, [loadPreviewImage, loadTileImage, previews, tiles]);

  useEffect(() => {
    if (!doc || previews.has(pageIndex)) return;

    let cancelled = false;
    onStatusChange(`Preparing page ${pageIndex + 1}`);
    invoke<PreviewData>("render_preview", { pageIndex })
      .then((previewData) => {
        if (cancelled) return;
        setPreviews((current) => {
          const next = new Map(current);
          next.set(pageIndex, previewData);
          return next;
        });
        onStatusChange(`Page ${pageIndex + 1} ready`);
      })
      .catch((e) => {
        if (!cancelled) onStatusChange(`ERROR: ${e}`);
      });

    return () => {
      cancelled = true;
    };
  }, [doc, onStatusChange, pageIndex, previews]);

  // Immediate-then-throttle: a plain debounce (fire N ms after the last change) never
  // actually invokes update_viewport while pan/zoom state is still changing every
  // pointermove, so a fast drag fetched zero tiles until the user let go — all the
  // fill-in landed in one visible burst right at release. Firing immediately whenever
  // the throttle window has elapsed, and otherwise scheduling one trailing call for the
  // final state, keeps tiles streaming in during the gesture instead of only after it.
  useEffect(() => {
    if (!doc || !page) return;

    const viewport: ViewportState = {
      page_index: pageIndex,
      zoom,
      pan_x: pan.x,
      pan_y: pan.y,
      width: viewportSize.width,
      height: viewportSize.height,
    };

    const THROTTLE_MS = 16;
    let cancelled = false;
    let timer: number | undefined;

    const fire = () => {
      lastViewportRequestRef.current = performance.now();
      invoke<TileData[]>("update_viewport", { viewport })
        .then((newTiles) => {
          if (!cancelled) mergeTiles(newTiles);
        })
        .catch((e) => {
          if (!cancelled) onStatusChange(`ERROR: ${e}`);
        });
    };

    const elapsed = performance.now() - lastViewportRequestRef.current;
    if (elapsed >= THROTTLE_MS) {
      fire();
    } else {
      timer = window.setTimeout(fire, THROTTLE_MS - elapsed);
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [doc, page, pageIndex, pan.x, pan.y, viewportSize.height, viewportSize.width, zoom, mergeTiles, onStatusChange]);

  // Bluebeam-parity settle pass: once pan/zoom/page/dpr has been stable for ~200ms,
  // request a pixel-exact viewport render (render_settle_view / SettleStore on the
  // backend) to replace the interactive tile layer's bucketed-DPI/dpr-scaled softness —
  // this is what makes the settled view read as crisp vector linework instead of a
  // slightly-off raster, matching Bluebeam Revu. Skipped when the tile layer is already
  // pixel-exact (dpr 1 and zoom sitting exactly on a bucket's native zoom) — the common
  // case on first page load at 100% Windows scaling.
  useEffect(() => {
    if (!doc || !page) return;
    const requestId = ++settleRequestIdRef.current;

    const dpr = window.devicePixelRatio || 1;
    if (dpr === 1 && zoom === bucketZoom(activeZoomBucket)) return;

    const timer = window.setTimeout(async () => {
      try {
        const meta = await invoke<SettleViewMeta | null>("render_settle_view", {
          viewport: {
            page_index: pageIndex,
            zoom,
            pan_x: pan.x,
            pan_y: pan.y,
            width: viewportSize.width,
            height: viewportSize.height,
            device_pixel_ratio: dpr,
          },
        });
        if (requestId !== settleRequestIdRef.current || !meta) return;

        const response = await fetch(`http://settle.localhost/${meta.key}`);
        if (!response.ok) throw new Error(`settle fetch failed: ${response.status}`);
        const blob = await response.blob();
        const bitmap = await createImageBitmap(blob);
        if (requestId !== settleRequestIdRef.current) {
          bitmap.close();
          return;
        }

        settleImageRef.current?.close();
        settleImageRef.current = bitmap;
        setSettleView({
          page: pageIndex,
          zoom,
          panX: pan.x,
          panY: pan.y,
          dpr,
          cropX: meta.crop_x,
          cropY: meta.crop_y,
        });
      } catch (e) {
        if (requestId === settleRequestIdRef.current) onStatusChange(`ERROR: ${e}`);
      }
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [doc, page, pageIndex, pan.x, pan.y, viewportSize.height, viewportSize.width, zoom, activeZoomBucket, onStatusChange]);

  // Completed tiles are pushed from the backend per tile; coalesce bursts into one
  // merge (and hence one canvas redraw) per animation frame.
  useEffect(() => {
    let frame: number | null = null;
    const queue: TileData[] = [];
    const unlistenPromise = listen<TileData>("tile-rendered", (event) => {
      queue.push(event.payload);
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          mergeTiles(queue.splice(0, queue.length));
        });
      }
    });

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [mergeTiles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = viewportSize.width;
    const height = viewportSize.height;
    const targetWidth = Math.max(1, Math.floor(width * dpr));
    const targetHeight = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = lightMode ? "#D0D5DE" : "#15171a";
    ctx.fillRect(0, 0, width, height);

    if (!doc || !page) {
      ctx.fillStyle = lightMode ? "#555555" : "#6f7682";
      ctx.font = "14px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Open a PDF to begin", width / 2, height / 2);
      return;
    }

    const pageLeft = -pan.x;
    const pageTop = -pan.y;
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(pageLeft, pageTop, pageSize.width, pageSize.height);
    ctx.strokeStyle = lightMode ? "#AAAAAA" : "#3c4048";
    ctx.strokeRect(pageLeft, pageTop, pageSize.width, pageSize.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pageLeft, pageTop, pageSize.width, pageSize.height);
    ctx.clip();

    if (preview?.page === pageIndex) {
      const previewImage = imageCacheRef.current.get(preview.image_path);
      if (previewImage) {
        ctx.drawImage(previewImage, pageLeft, pageTop, pageSize.width, pageSize.height);
      }
    }

    const loadedTiles = Array.from(tiles.values()).filter(
      (tile) => tile.key.page === pageIndex && imageCacheRef.current.has(tile.image_path),
    );

    // Loaded active-bucket tiles form an exact grid (tile_x/tile_y are already grid
    // indices, and every zoom bucket's pixel grid is a power-of-two subdivision of the
    // same page origin) — so a coarser, stale-bucket tile maps onto an exact integer
    // range of active-bucket cells with no floating-point rounding involved.
    const activeCells = new Set<string>();
    for (const tile of loadedTiles) {
      if (tile.key.zoom_level === activeZoomBucket) {
        activeCells.add(`${tile.key.tile_x}:${tile.key.tile_y}`);
      }
    }
    const isFullyCoveredByActive = (tile: TileData) => {
      if (tile.key.zoom_level >= activeZoomBucket || activeCells.size === 0) return false;
      const ratio = 2 ** (activeZoomBucket - tile.key.zoom_level);
      const gxStart = tile.key.tile_x * ratio;
      const gyStart = tile.key.tile_y * ratio;
      for (let dy = 0; dy < ratio; dy++) {
        for (let dx = 0; dx < ratio; dx++) {
          if (!activeCells.has(`${gxStart + dx}:${gyStart + dy}`)) return false;
        }
      }
      return true;
    };

    const pageTiles = loadedTiles
      .map((tile) => {
        const scale = zoom / bucketZoom(tile.key.zoom_level);
        return {
          tile,
          scale,
          screenLeft: pageLeft + tile.x * scale,
          screenTop: pageTop + tile.y * scale,
          screenSize: TILE_SIZE * scale,
        };
      })
      // Offscreen cull: skip tiles whose screen footprint doesn't intersect the viewport.
      .filter(
        ({ screenLeft, screenTop, screenSize }) =>
          screenLeft < width && screenTop < height && screenLeft + screenSize > 0 && screenTop + screenSize > 0,
      )
      // A fully-occluded stale tile is invisible either way — skip the draw call.
      .filter((entry) => !isFullyCoveredByActive(entry.tile))
      .sort((a, b) => {
        const aDistance = Math.abs(a.tile.key.zoom_level - activeZoomBucket);
        const bDistance = Math.abs(b.tile.key.zoom_level - activeZoomBucket);
        if (aDistance !== bDistance) return bDistance - aDistance;
        return a.tile.key.zoom_level - b.tile.key.zoom_level;
      });

    for (const { tile, screenLeft, screenTop, screenSize } of pageTiles) {
      const image = imageCacheRef.current.get(tile.image_path)!;
      ctx.drawImage(image, screenLeft, screenTop, screenSize, screenSize);
    }

    // Bluebeam-parity settle pass: only drawn when it exactly matches the live pan/
    // zoom/page/dpr — any input since it was captured makes it stale, and we simply
    // fall back to the (already-drawn) tile layer until a fresh settle image lands.
    // Drawn with an identity (1:1 device-pixel) transform rather than the dpr-scaled
    // CSS-pixel transform this whole effect otherwise uses, so the browser never
    // resamples it — that resampling is exactly what makes the tile layer read as "a
    // raster" at non-bucket-exact zooms or fractional Windows display scaling. The
    // page-rect clip established above is in device-space already, so it still applies
    // correctly under the identity transform.
    const currentDpr = window.devicePixelRatio || 1;
    if (
      settleView &&
      settleImageRef.current &&
      settleView.page === pageIndex &&
      settleView.zoom === zoom &&
      settleView.panX === pan.x &&
      settleView.panY === pan.y &&
      settleView.dpr === currentDpr
    ) {
      const deviceX = -settleView.panX * settleView.dpr + settleView.cropX;
      const deviceY = -settleView.panY * settleView.dpr + settleView.cropY;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(settleImageRef.current, Math.round(deviceX), Math.round(deviceY));
      ctx.restore();
    }

    // Dimmer: white overlay over the page linework so measurements stand out.
    // We overlay rather than reducing tile alpha to avoid ghosting against the preview image.
    if (drawingDimmer < 1) {
      ctx.fillStyle = `rgba(247,247,247,${1 - drawingDimmer})`;
      ctx.fillRect(pageLeft, pageTop, pageSize.width, pageSize.height);
    }

    ctx.restore();
  }, [activeZoomBucket, doc, drawingDimmer, imageVersion, page, pageIndex, pageSize.height, pageSize.width, pan.x, pan.y, preview, settleView, tiles, viewportSize.height, viewportSize.width, zoom]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = viewportSize.width;
    const height = viewportSize.height;
    const targetWidth = Math.max(1, Math.floor(width * dpr));
    const targetHeight = Math.max(1, Math.floor(height * dpr));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!doc || !page) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(-pan.x, -pan.y, pageSize.width, pageSize.height);
    ctx.clip();
    // During trim preview (trim line placed, cursor determines kept side) exclude the active-group
    // arrays from the normal render — drawArrayTrimPreview draws them with ghost opacities instead.
    const trimDraftReady = arrayTrimType === "box" ? arrayTrimDraft.length >= 3 : arrayTrimDraft.length === 2;
    const trimPreviewActive = arrayTrimMode && trimDraftReady && activeDimensionGroupId !== null;
    const overlaysToRender = trimPreviewActive
      ? overlayMeasurements.filter((m) => !(m.measurement_type === "array" && m.dimension_group_id === activeDimensionGroupId))
      : overlayMeasurements;
    drawOverlays(ctx, overlaysToRender, groupColours, groupProps, overlayColour, pan, zoom, page, pageIndex, selectedSet, editPreview, pageScale?.mm_per_point ?? null);
    if (pendingRake) {
      // While the raking-frame dialog is open, mark which real wall vertex is "Start" vs "End" —
      // the dialog's mm-from-start fields are otherwise ambiguous relative to the drawing.
      const sp = pageToScreen(pendingRake.startPoint.x, pendingRake.startPoint.y, page.height_pts, pan, zoom);
      const ep = pageToScreen(pendingRake.endPoint.x, pendingRake.endPoint.y, page.height_pts, pan, zoom);
      ctx.save();
      ctx.font = "bold 12px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      for (const [pt, label] of [[sp, "S"], [ep, "E"]] as const) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = "#FFB300";
        ctx.fill();
        ctx.strokeStyle = "#00000066";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#000000";
        ctx.fillText(label, pt.x, pt.y + 4);
      }
      ctx.restore();
    }
    if (measuring) {
      if (drawingType === "line") {
        // Line mode: draw the detected wall segment as the live preview instead of a rubber-band.
        if (lineSnapResult) {
          drawLineSnapPreview(ctx, lineSnapResult.start, lineSnapResult.end, draftColour, pan, zoom, page);
        }
      } else if (drawingFraming) {
        // Framing: preview plates + studs live as the wall is drawn (incl. the rubber-band point),
        // with the live segment constrained to 90° off the previous one (unless Shift overrides).
        const rawLive = snapPoint ?? cursorPagePoint;
        const livePoint = rawLive ? (shiftHeld ? rawLive : orthogonalConstrain(draftPoints, rawLive)) : rawLive;
        const draftPath = livePoint ? [...draftPoints, livePoint] : draftPoints;
        const settings = parseFramingSettings(activeProps?.framing_props_json ?? null);
        drawFraming(ctx, draftPath, settings, pageScale?.mm_per_point ?? null, draftColour, draftStyle, pan, zoom, page, false, true);
      } else if (drawingArray) {
        const livePoint = snapPoint ?? cursorPagePoint;
        if (draftPoints.length >= 2) {
          // Extruding phase: show ghost array based on cursor's perpendicular offset.
          const baseline: [PagePoint, PagePoint] = [draftPoints[0], draftPoints[1]];
          drawArrayDraft(ctx, baseline, arrayExtraMembers, arrayDirection, arraySpacingPts, draftColour, pan, zoom, page, pageScale?.mm_per_point ?? null);
        } else {
          // Baseline phase: rubber-band the first segment.
          drawDraft(ctx, draftPoints, livePoint, draftColour, pan, zoom, page, draftStyle, false);
        }
      } else if (drawingCount) {
        // Count: ghost the marker/shape that will be stamped at the cursor, same translucent
        // treatment as the move-ghost below (reuses drawOverlays so marker vs. custom-shape
        // rendering stays in one place).
        const livePoint = snapPoint ?? cursorPagePoint;
        if (livePoint && activeDimensionGroupId !== null) {
          const ghost: MeasurementDto = {
            id: -1,
            dimension_group_id: activeDimensionGroupId,
            drawing_id: activeDrawingId ?? 0,
            page_index: pageIndex,
            measurement_type: "count",
            geometry_json: JSON.stringify([livePoint]),
            polarity: draftNegative ? -1 : 1,
            quantity: null,
            uom: null,
            framing_json: null,
          };
          ctx.save();
          ctx.globalAlpha = 0.65;
          drawOverlays(ctx, [ghost], groupColours, groupProps, overlayColour, pan, zoom, page, pageIndex, new Set(), null, pageScale?.mm_per_point ?? null);
          ctx.restore();
        }
      } else {
        const livePoint = snapPoint ?? cursorPagePoint;
        drawDraft(ctx, draftPoints, livePoint, draftColour, pan, zoom, page, draftStyle, drawingArea);
      }
    }
    if (calibrating) {
      // The calibration line is drawn in a distinct colour to set it apart from dimensions.
      const livePoint = calibDialog ? null : snapPoint ?? cursorPagePoint;
      drawDraft(ctx, calibPoints, livePoint, "#FFD700", pan, zoom, page);
    }
    // Door/window placement ghost: the opening's daylight gap + jamb studs on the hovered wall.
    if (openingPlacement && openingGhost) {
      const measurement = overlayMeasurements.find((m) => m.id === openingGhost.measurementId);
      let ghostPts: PagePoint[] | null = null;
      try {
        ghostPts = measurement ? JSON.parse(measurement.geometry_json) : null;
      } catch {
        ghostPts = null;
      }
      if (measurement && Array.isArray(ghostPts)) {
        const settings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
        const ghostOpening = { ...openingPlacement, segmentIndex: openingGhost.segmentIndex, centreMm: openingGhost.centreMm };
        const preview = openingPreview(ghostPts, settings, pageScale?.mm_per_point ?? null, ghostOpening);
        if (preview) {
          ctx.save();
          const ghostColour = "#FFD700";
          ctx.strokeStyle = ghostColour;
          ctx.lineWidth = 1.5;
          const dl = preview.daylight.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
          ctx.beginPath();
          ctx.moveTo(dl[0].x, dl[0].y);
          for (const s of dl.slice(1)) ctx.lineTo(s.x, s.y);
          ctx.closePath();
          ctx.fillStyle = `${ghostColour}33`;
          ctx.fill();
          ctx.stroke();
          for (const jamb of preview.jambs) {
            const c = jamb.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
            ctx.beginPath();
            ctx.moveTo(c[0].x, c[0].y);
            for (const s of c.slice(1)) ctx.lineTo(s.x, s.y);
            ctx.closePath();
            ctx.stroke();
          }
          ctx.restore();
        }
      }
    }
    // Extra-stud ghost (select mode + Ctrl): a single stud aligned to the hovered wall.
    if (studGhost) {
      const measurement = overlayMeasurements.find((m) => m.id === studGhost.measurementId);
      let pts: PagePoint[] | null = null;
      try {
        pts = measurement ? JSON.parse(measurement.geometry_json) : null;
      } catch {
        pts = null;
      }
      if (measurement && Array.isArray(pts)) {
        const settings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
        const rect = extraStudRect(pts, settings, pageScale?.mm_per_point ?? null, studGhost.segmentIndex, studGhost.centreMm);
        if (rect) {
          const c = rect.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(c[0].x, c[0].y);
          for (const s of c.slice(1)) ctx.lineTo(s.x, s.y);
          ctx.closePath();
          ctx.fillStyle = "#FFD70033";
          ctx.fill();
          ctx.strokeStyle = "#FFD700";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(c[0].x, c[0].y);
          ctx.lineTo(c[2].x, c[2].y);
          ctx.moveTo(c[1].x, c[1].y);
          ctx.lineTo(c[3].x, c[3].y);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    // Select-studs-to-double overlay: pending (selected) studs drawn in gold; hovered stud in
    // lighter gold. Both are drawn as the stud rect + cross so they read as timber members.
    if (doubleStudSelect && page) {
      const measurement = overlayMeasurements.find((m) => m.id === doubleStudSelect.measurementId);
      if (measurement) {
        let pts: PagePoint[] | null = null;
        try { pts = JSON.parse(measurement.geometry_json); } catch { pts = null; }
        if (Array.isArray(pts) && pts.length >= 2) {
          const settings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
          const mmpp = pageScale?.mm_per_point ?? null;
          const positions = mmpp ? wallStudPositions(pts, settings, mmpp) : [];
          const drawStudHighlight = (pos: { segmentIndex: number; centreMm: number }, fill: string, stroke: string) => {
            if (!mmpp) return;
            const rect = extraStudRect(pts!, settings, mmpp, pos.segmentIndex, pos.centreMm);
            if (!rect) return;
            const c = rect.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(c[0].x, c[0].y);
            for (const s of c.slice(1)) ctx.lineTo(s.x, s.y);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(c[0].x, c[0].y); ctx.lineTo(c[2].x, c[2].y);
            ctx.moveTo(c[1].x, c[1].y); ctx.lineTo(c[3].x, c[3].y);
            ctx.stroke();
            ctx.restore();
          };
          // Pending (selected) studs.
          for (const pos of positions) {
            const selected = doubleStudSelect.pending.some((d) => d.segmentIndex === pos.segmentIndex && Math.abs(d.centreMm - pos.centreMm) < 0.5);
            if (selected) drawStudHighlight(pos, "#FFD70055", "#FFD700");
          }
          // Hover ghost.
          if (doubleStudSelect.hoverPos) {
            const isSelected = doubleStudSelect.pending.some((d) => d.segmentIndex === doubleStudSelect.hoverPos!.segmentIndex && Math.abs(d.centreMm - doubleStudSelect.hoverPos!.centreMm) < 0.5);
            if (!isSelected) drawStudHighlight(doubleStudSelect.hoverPos, "#FFD70022", "#FFD70099");
          }
        }
      }
    }
    // Move ghost: selected measurements rendered semi-transparent at the offset position.
    if (moveMode && cursorPagePoint) {
      const dx = cursorPagePoint.x - moveMode.anchorPage.x;
      const dy = cursorPagePoint.y - moveMode.anchorPage.y;
      const movingMs = overlayMeasurements.filter((m) => selectedSet.has(m.id) && m.page_index === pageIndex);
      if (movingMs.length > 0) {
        const shifted = shiftMeasurements(movingMs, dx, dy);
        ctx.save();
        ctx.globalAlpha = 0.65;
        drawOverlays(ctx, shifted, groupColours, groupProps, overlayColour, pan, zoom, page, pageIndex, new Set(), null, pageScale?.mm_per_point ?? null);
        ctx.restore();
      }
    }
    // Paste ghost: clipboard measurements rendered semi-transparent at the cursor-centroid offset.
    if (pasteMode && clipboardRef.current.length > 0 && cursorPagePoint) {
      const dx = cursorPagePoint.x - pasteMode.centroid.x;
      const dy = cursorPagePoint.y - pasteMode.centroid.y;
      const shifted = shiftMeasurements(clipboardRef.current, dx, dy);
      ctx.save();
      ctx.globalAlpha = 0.55;
      drawOverlays(ctx, shifted, groupColours, groupProps, overlayColour, pan, zoom, page, pageIndex, new Set(), null, pageScale?.mm_per_point ?? null);
      ctx.restore();
    }

    // Pitch-direction pick: dashed axis-snapped preview from the clicked start point to the cursor.
    if (pitchDirectionMode && page && pitchPickStart) {
      const livePoint = cursorPagePoint;
      if (livePoint) drawPitchDirectionOutline(ctx, pitchPickStart, livePoint, pan, zoom, page);
    }

    // Array trim tool: draw in-progress trim outline and ghost of the trim result.
    if (arrayTrimMode && page) {
      const livePoint = snapPoint ?? cursorPagePoint;
      // Use cursor position as keep-side reference; falls back to cursorPagePoint
      // so the ghost renders immediately once enough points are placed.
      const effectiveKeepPt = arrayTrimKeepPt ?? cursorPagePoint;

      if (arrayTrimType === "line") {
        if (arrayTrimDraft.length === 1) {
          drawArrayTrimOutline(ctx, arrayTrimDraft, livePoint, "line", pan, zoom, page);
        } else if (arrayTrimDraft.length === 2 && effectiveKeepPt) {
          const ghostTrim: ArrayTrim = {
            x1: arrayTrimDraft[0].x, y1: arrayTrimDraft[0].y,
            x2: arrayTrimDraft[1].x, y2: arrayTrimDraft[1].y,
            keepX: effectiveKeepPt.x, keepY: effectiveKeepPt.y,
          };
          drawArrayTrimPreview(ctx, ghostTrim, overlayMeasurements, groupProps, pan, zoom, page, pageIndex, activeDimensionGroupId);
        }
      } else {
        // Box trim: draw the in-progress polygon outline (rubber-banded to the cursor).
        if (arrayTrimDraft.length >= 1) {
          drawArrayTrimOutline(ctx, arrayTrimDraft, livePoint, "box", pan, zoom, page);
        }
        if (arrayTrimDraft.length >= 3 && effectiveKeepPt) {
          const ghostTrim: BoxTrim = {
            kind: "box",
            points: arrayTrimDraft,
            keepX: effectiveKeepPt.x, keepY: effectiveKeepPt.y,
          };
          drawArrayTrimPreview(ctx, ghostTrim, overlayMeasurements, groupProps, pan, zoom, page, pageIndex, activeDimensionGroupId);
        }
      }
    }

    // Show the point-snap indicator only in point mode; line mode uses the segment preview.
    if (drawingType !== "line") {
      drawSnapIndicator(ctx, snapPoint, snapType, pan, zoom, page);
    }
    ctx.restore();

    // Marquee: drawn outside the page clip so it spans the full viewport.
    if (marqueeState) {
      const el = viewportRef.current;
      if (el) {
        const domRect = el.getBoundingClientRect();
        const x1 = marqueeState.startClient.x - domRect.left;
        const y1 = marqueeState.startClient.y - domRect.top;
        const x2 = marqueeState.endClient.x - domRect.left;
        const y2 = marqueeState.endClient.y - domRect.top;
        const leftToRight = x2 >= x1;
        const rx = Math.min(x1, x2);
        const ry = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);
        if (rw > 2 || rh > 2) {
          ctx.save();
          ctx.lineWidth = 1;
          if (leftToRight) {
            // Window select — solid blue border, light blue fill
            ctx.setLineDash([]);
            ctx.fillStyle = "rgba(74, 158, 255, 0.10)";
            ctx.strokeStyle = "rgba(74, 158, 255, 0.85)";
          } else {
            // Crossing select — dashed green border, light green fill
            ctx.setLineDash([5, 3]);
            ctx.fillStyle = "rgba(80, 220, 100, 0.08)";
            ctx.strokeStyle = "rgba(80, 220, 100, 0.85)";
          }
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
          ctx.restore();
        }
      }
    }
  }, [activeProps, activeDimensionGroupId, arrayDirection, arrayExtraMembers, arraySpacingPts, arrayTrimDraft, arrayTrimKeepPt, arrayTrimMode, arrayTrimType, calibDialog, calibPoints, calibrating, clipboard, cursorPagePoint, doc, doubleStudSelect, draftColour, draftPoints, draftStyle, drawingArea, drawingArray, drawingFraming, drawingType, editPreview, groupColours, groupProps, lightMode, lineSnapResult, marqueeState, measuring, moveMode, openingGhost, openingPlacement, overlayColour, overlayMeasurements, page, pageIndex, pageScale, pageSize.height, pageSize.width, pan, pasteMode, pendingRake, pitchDirectionMode, pitchPickStart, selectedSet, shiftHeld, snapPoint, snapType, studGhost, viewportSize.height, viewportSize.width, zoom]);

  function clampPan(nextPan: { x: number; y: number }, nextZoom = zoom) {
    if (!page) return nextPan;
    const size = pagePixelSize(page, nextZoom);
    // When the page is smaller than the viewport (zoomed out), size - viewportSize is negative —
    // allow panning across that whole negative..0 range instead of pinning to 0, so the page is
    // freely moveable rather than glued to the top-left corner.
    const minX = Math.min(0, size.width - viewportSize.width);
    const maxX = Math.max(0, size.width - viewportSize.width);
    const minY = Math.min(0, size.height - viewportSize.height);
    const maxY = Math.max(0, size.height - viewportSize.height);
    return {
      x: Math.max(minX, Math.min(nextPan.x, maxX)),
      y: Math.max(minY, Math.min(nextPan.y, maxY)),
    };
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!doc) return;

    // Middle button always pans.
    if (event.button === 1) {
      startPan(event);
      return;
    }
    if (event.button !== 0) return;

    // Opening placement takes priority: a left click drops the door/window onto the ghosted wall.
    if (openingPlacement && page) {
      if (openingGhost) commitOpening();
      return;
    }

    if (calibrating && page) {
      // Capture two points spanning a known real-world dimension.
      if (calibDialog) return; // waiting on the length dialog
      const point = placementPoint(event.clientX, event.clientY);
      if (!point) return;
      const current = calibPointsRef.current;
      if (current.length === 0) {
        applyCalib([point]);
      } else if (current.length === 1) {
        const start = current[0];
        const pixelLength = Math.hypot(point.x - start.x, point.y - start.y);
        applyCalib([start, point]);
        if (pixelLength > 1e-6) setCalibDialog({ pixelLength });
      }
      return;
    }

    // Pitch-direction pick: first click sets the start point, second click commits — snapped to
    // whichever page axis (X or Y) the drag's dominant component aligns with.
    if (pitchDirectionMode && page) {
      const point = placementPoint(event.clientX, event.clientY);
      if (!point) return;
      if (!pitchPickStart) {
        setPitchPickStart(point);
      } else {
        const dx = point.x - pitchPickStart.x;
        const dy = point.y - pitchPickStart.y;
        if (Math.hypot(dx, dy) > 1e-6) {
          resolvePitchDirectionPick(Math.abs(dx) >= Math.abs(dy) ? "x" : "y");
        }
      }
      return;
    }

    // Array trim mode: left click places trim shape points.
    if (arrayTrimMode && page && activeDimensionGroupId !== null) {
      const point = placementPoint(event.clientX, event.clientY);
      if (!point) return;
      const current = arrayTrimDraftRef.current;
      if (arrayTrimType === "line") {
        if (current.length === 0) {
          arrayTrimDraftRef.current = [point];
          setArrayTrimDraft([point]);
        } else if (current.length === 1) {
          arrayTrimDraftRef.current = [current[0], point];
          setArrayTrimDraft([current[0], point]);
          // Keep-side will be determined by cursor on the next move.
        } else if (current.length === 2) {
          // Third click commits the trim with the current keep-side.
          if (arrayTrimKeepPt) {
            const absTrim: ArrayTrim = {
              x1: current[0].x, y1: current[0].y,
              x2: current[1].x, y2: current[1].y,
              keepX: arrayTrimKeepPt.x, keepY: arrayTrimKeepPt.y,
            };
            void commitArrayTrim(absTrim);
          }
        }
      } else {
        // Box trim: each click adds a polygon vertex; Enter closes and commits.
        const next = [...current, point];
        arrayTrimDraftRef.current = next;
        setArrayTrimDraft(next);
      }
      return;
    }

    if (measuring && page) {
      // Line mode: one click places a measurement along the detected wall segment.
      if (drawingType === "line") {
        const result = useAppStore.getState().lineSnapResult;
        if (!result) return;
        void createMeasurement({ geometryJson: JSON.stringify([result.start, result.end]) }).catch(
          (error) => onStatusChange(`ERROR: ${error}`),
        );
        return;
      }

      const rawPoint = placementPoint(event.clientX, event.clientY);
      if (!rawPoint) return;

      // Count: each click commits one marker immediately (no path).
      if (drawingCount) {
        void createMeasurement({ geometryJson: JSON.stringify([rawPoint]) }).catch((error) => onStatusChange(`ERROR: ${error}`));
        return;
      }

      // Array in extruding phase (baseline already drawn): ignore further clicks.
      if (drawingArray && draftPointsRef.current.length >= 2) {
        return;
      }

      // Default Spacing is required before a Joist/Rafter group can be drawn — block starting a
      // new baseline until it's set (via the group's Properties).
      if (drawingArray && draftPointsRef.current.length === 0 && arraySpacingPts <= 0) {
        onStatusChange("Set a Default Spacing for this Joist / Rafter group before drawing (Properties).");
        return;
      }

      // Framing corners are forced orthogonal to the previous segment, unless Shift overrides.
      const point = drawingFraming && !shiftHeldRef.current ? orthogonalConstrain(draftPointsRef.current, rawPoint) : rawPoint;

      // Click-to-place: each click drops a vertex (at the snap target if one is live).
      applyDraft((prev) => {
        if (prev.length === 0) {
          // Ctrl on the first click resumes the path from the previous endpoint,
          // even though that dimension is already committed.
          if (event.ctrlKey && lastEndpointRef.current) return [lastEndpointRef.current, point];
          return [point];
        }
        return [...prev, point];
      });
      return;
    }

    if (selectMode && page) {
      // Select-studs-to-double mode: click toggles the hovered stud.
      if (doubleStudSelect) {
        setDoubleStudSelect((prev) => {
          if (!prev?.hoverPos) return prev;
          const { segmentIndex, centreMm } = prev.hoverPos;
          const alreadyIn = prev.pending.some((d) => d.segmentIndex === segmentIndex && Math.abs(d.centreMm - centreMm) < 0.5);
          const next = alreadyIn
            ? prev.pending.filter((d) => !(d.segmentIndex === segmentIndex && Math.abs(d.centreMm - centreMm) < 0.5))
            : [...prev.pending, { segmentIndex, centreMm }];
          return { ...prev, pending: next };
        });
        return;
      }
      // Move mode: left-click commits the move at the current cursor position.
      if (moveMode && cursorPagePoint) {
        void commitMove(cursorPagePoint);
        return;
      }
      // Paste mode: left-click commits the paste at the current cursor position.
      if (pasteMode && cursorPagePoint) {
        void commitPaste(cursorPagePoint);
        return;
      }
      // Ctrl+click places a manually-positioned extra stud on the ghosted wall.
      if (event.ctrlKey && studGhost) {
        commitExtraStud();
        return;
      }
      // Drag a handle of the already-selected dimension to move that vertex.
      if (singleSelectedId !== null) {
        const vertexIndex = hitTestVertex(event.clientX, event.clientY, singleSelectedId);
        if (vertexIndex >= 0) {
          const points = measurementPoints(singleSelectedId);
          if (points) {
            // Block vertex drag on trimmed arrays — resizing the baseline would misalign the trims.
            const selectedM = overlayMeasurements.find((m) => m.id === singleSelectedId);
            const isTrimmedArray = selectedM?.measurement_type === "array" &&
              parseArrayMeta(selectedM.framing_json ?? null).trims.length > 0;
            if (!isTrimmedArray) {
              event.currentTarget.setPointerCapture(event.pointerId);
              vertexDragRef.current = { measurementId: singleSelectedId, vertexIndex };
              setEditPreview({ id: singleSelectedId, points });
              return;
            }
          }
        }
      }
      // Hit-test for a dimension under the cursor.
      const hitId = hitTestMeasurementId(event.clientX, event.clientY);
      if (hitId !== null) {
        if (event.ctrlKey) {
          toggleSelectMeasurement(hitId);
        } else {
          selectMeasurement(hitId);
        }
        return;
      }
      // Empty space: Ctrl+click just keeps the current selection; plain click clears it.
      if (!event.ctrlKey) selectMeasurement(null);
      // Start a marquee rubber-band selection (replaces pan in select mode).
      event.currentTarget.setPointerCapture(event.pointerId);
      marqueeRef.current = { startClient: { x: event.clientX, y: event.clientY }, pointerId: event.pointerId };
      setMarqueeState({ startClient: { x: event.clientX, y: event.clientY }, endClient: { x: event.clientX, y: event.clientY } });
      return;
    }

    // No group selected: left-drag pans.
    startPan(event);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    // While placing an opening, track the ghost (or pan on a middle-drag); skip snap/hover.
    if (openingPlacement) {
      const placingDrag = dragRef.current;
      if (placingDrag) {
        setPan(clampPan({ x: placingDrag.panX - (event.clientX - placingDrag.startX), y: placingDrag.panY - (event.clientY - placingDrag.startY) }));
      } else {
        resolveOpeningGhost(clientToPagePoint(event.clientX, event.clientY));
      }
      return;
    }

    // Select-studs-to-double mode: update hover stud position.
    if (doubleStudSelect) {
      resolveDoubleStudHover(event.clientX, event.clientY);
      return;
    }

    // Select mode + Ctrl: ghost an extra stud aligned to the wall under the cursor.
    if (selectMode && event.ctrlKey && !dragRef.current && !vertexDragRef.current) {
      resolveStudGhost(clientToPagePoint(event.clientX, event.clientY));
      setHoverInfo(null);
      return;
    }
    if (studGhost) setStudGhost(null);

    scheduleSnapResolution(event.clientX, event.clientY);

    // Marquee update — track the drag end point while rubber-banding.
    if (marqueeRef.current) {
      setMarqueeState((prev) => (prev ? { ...prev, endClient: { x: event.clientX, y: event.clientY } } : null));
      return;
    }

    // Vertex drag takes priority — move the dragged handle to the snapped cursor.
    const vertexDrag = vertexDragRef.current;
    if (vertexDrag) {
      const point = placementPoint(event.clientX, event.clientY);
      if (point) {
        setEditPreview((prev) => {
          if (!prev) return prev;
          const next = prev.points.slice();
          next[vertexDrag.vertexIndex] = point;
          return { id: prev.id, points: next };
        });
      }
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      setPan(
        clampPan({
          x: drag.panX - (event.clientX - drag.startX),
          y: drag.panY - (event.clientY - drag.startY),
        }),
      );
    }

    if (measuring || calibrating || moveMode || pasteMode || arrayTrimMode || pitchDirectionMode) {
      // Drive the live rubber-band endpoint (drawing a dimension, a calibration line,
      // or a move/paste ghost).
      setCursorClient({ x: event.clientX, y: event.clientY });
      const raw = clientToPagePoint(event.clientX, event.clientY);
      if (raw) setCursorPagePoint(raw);

      // Array extrusion: update ghost member count based on perpendicular offset from baseline.
      if (measuring && drawingArray && draftPointsRef.current.length >= 2 && raw) {
        const [p1, p2] = draftPointsRef.current;
        const spacing = arraySpacingPts;
        if (spacing > 0) {
          const signed = arraySignedOffset(p1, p2, raw);
          const count = Math.floor(Math.abs(signed) / spacing);
          const dir = signed >= 0 ? 1 : -1;
          arrayExtraMembersRef.current = count;
          arrayDirectionRef.current = dir;
          setArrayExtraMembers(count);
          setArrayDirection(dir);
        }
      }

      // Array trim keep-side: update based on which side/region of the in-progress trim shape the cursor is on.
      if (arrayTrimMode && raw) {
        const draftLen = arrayTrimDraftRef.current.length;
        const ready = arrayTrimType === "box" ? draftLen >= 3 : draftLen === 2;
        if (ready) setArrayTrimKeepPt({ x: raw.x, y: raw.y });
      }
    }

    // Hover-to-inspect committed dimensions works in add-mode too (add-mode is
    // always on while a group is selected). It's suppressed mid-path below, where
    // the live length readout takes over.
    if (!drag && !calibrating) {
      updateHover(event.clientX, event.clientY);
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    // Marquee: finalise selection based on drag direction.
    if (marqueeRef.current?.pointerId === event.pointerId) {
      const mq = marqueeRef.current;
      marqueeRef.current = null;
      if (marqueeState) {
        const dx = marqueeState.endClient.x - mq.startClient.x;
        const dy = marqueeState.endClient.y - mq.startClient.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          const ids = marqueeSelectIds(marqueeState.startClient, marqueeState.endClient);
          setSelectedMeasurementIds(ids);
        }
        setMarqueeState(null);
      }
      return;
    }

    const vertexDrag = vertexDragRef.current;
    if (vertexDrag) {
      vertexDragRef.current = null;
      const preview = editPreview;
      if (preview) {
        // Keep the preview (new position) on screen until the store has the updated
        // geometry, then clear it. Clearing early would briefly fall back to the old
        // stored geometry, making the vertex visibly snap back and forward.
        void updateMeasurementGeometry(preview.id, JSON.stringify(preview.points))
          .catch((error) => onStatusChange(`ERROR: ${error}`))
          .finally(() => setEditPreview(null));
      } else {
        setEditPreview(null);
      }
      return;
    }

    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  }

  function handleContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    // Trim mode: suppress context menu.
    if (arrayTrimMode) {
      event.preventDefault();
      return;
    }

    if (measuring) {
      if (drawingType === "line") {
        // No draft to finish in line mode; just suppress the context menu.
        event.preventDefault();
        return;
      }
      if (drawingArray) {
        // Array draw mode: right-click cancels the in-progress draft.
        event.preventDefault();
        applyDraft([]);
        arrayExtraMembersRef.current = 0;
        arrayDirectionRef.current = 1;
        setArrayExtraMembers(0);
        setArrayDirection(1);
        return;
      }
      // Right-click ends the current dimension (CostX finish gesture).
      event.preventDefault();
      finishDraft();
      return;
    }

    if (selectMode && page) {
      event.preventDefault();

      // A manually-placed extra stud under the cursor → Delete.
      const studHit = hitTestExtraStud(event.clientX, event.clientY);
      if (studHit) {
        setViewerMenu({
          x: event.clientX,
          y: event.clientY,
          items: [{ label: "Delete stud", danger: true, action: () => deleteExtraStud(studHit.measurementId, studHit.index) }],
        });
        return;
      }

      // A committed door/window under the cursor gets its own menu (Delete / Options / Move).
      const openingHit = hitTestOpening(event.clientX, event.clientY);
      if (openingHit) {
        const { measurementId, index, opening } = openingHit;
        const template: OpeningTemplate = {
          kind: opening.kind,
          daylightHeightMm: opening.daylightHeightMm,
          daylightWidthMm: opening.daylightWidthMm,
          lintelSize: opening.lintelSize,
          lintelPly: opening.lintelPly,
          sillHeightMm: opening.sillHeightMm,
        };
        const noun = opening.kind === "window" ? "window" : "door";
        setViewerMenu({
          x: event.clientX,
          y: event.clientY,
          items: [
            { label: `${noun[0].toUpperCase()}${noun.slice(1)} options…`, action: () => setPendingOpeningEdit({ measurementId, index, template }) },
            {
              label: `Move ${noun}`,
              action: () => {
                deleteOpening(measurementId, index);
                setOpeningPlacement(template);
              },
            },
            { label: `Delete ${noun}`, danger: true, action: () => deleteOpening(measurementId, index) },
          ],
        });
        return;
      }

      const id = hitTestMeasurementId(event.clientX, event.clientY);
      if (id === null) {
        // Empty space: offer Paste if there's content on the clipboard.
        if (clipboardRef.current.length > 0) {
          setViewerMenu({
            x: event.clientX,
            y: event.clientY,
            items: [{ label: "Paste", action: () => startPaste() }],
          });
        } else {
          setViewerMenu(null);
        }
        return;
      }
      // Right-click on a measurement: if it's not already in the selection, single-select it.
      if (!selectedSet.has(id)) selectMeasurement(id);

      const measurement = overlayMeasurements.find((m) => m.id === id);
      const points = measurementPoints(id);
      if (!measurement || !points) return;
      const isArea = isAreaType(measurement.measurement_type);
      const minPoints = isArea ? 3 : 2;

      const items: ViewerMenuItem[] = [];
      const multiSelected = selectedMeasurementIds.length > 1 && selectedSet.has(id);

      if (!multiSelected) {
        // Single-measurement geometry editing: delete/add vertex.
        const vertexIndex = nearestVertex(event.clientX, event.clientY, id, VERTEX_RADIUS + 8);
        if (vertexIndex >= 0 && points.length > minPoints) {
          items.push({ label: "Delete point", danger: true, action: () => deleteVertex(id, vertexIndex) });
        } else if (measurement.measurement_type !== "array") {
          const segment = hitTestSegment(event.clientX, event.clientY, id);
          if (segment) {
            items.push({ label: "Add point", action: () => addVertex(id, segment.segmentIndex, segment.point) });
          }
        }
        // View in 3D — any measurement type (marker/extrusion/mesh built from the group's
        // measurement_type; timber framing additionally gets raking-frame/double-stud extras below).
        items.push({ label: "View in 3D", action: () => setWall3dId(id) });
        if (measurement.measurement_type === "timber_framing") {
          const seg = hitTestSegment(event.clientX, event.clientY, id);
          if (seg) {
            const framing = parseWallFraming(measurement.framing_json);
            const existingRake = framing.rakes.find((r) => r.segmentIndex === seg.segmentIndex);
            const groupSettings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
            const mmpp = pageScale?.mm_per_point ?? null;
            const a = points[seg.segmentIndex];
            const b = points[seg.segmentIndex + 1];
            const segLenMm = mmpp && a && b ? Math.hypot(b.x - a.x, b.y - a.y) * mmpp : 0;
            items.push({
              label: existingRake ? "Edit raking frame…" : "Set raking frame…",
              action: () =>
                setPendingRake({
                  measurementId: id,
                  segmentIndex: seg.segmentIndex,
                  start: existingRake?.startMm ?? groupSettings.wallHeightMm,
                  end: existingRake?.endMm ?? groupSettings.wallHeightMm,
                  gable: existingRake?.gable ?? false,
                  middle: existingRake?.middleMm,
                  middlePosition: existingRake?.middlePositionMm,
                  segLenMm,
                  startPoint: a,
                  endPoint: b,
                }),
            });
            if (existingRake) items.push({ label: "Clear raking frame", danger: true, action: () => clearRake(id, seg.segmentIndex) });
          }
          // Double studs submenu.
          items.push({
            label: "Double studs",
            submenu: [
              {
                label: "Apply to entire wall",
                action: () => {
                  const wf = parseWallFraming(measurement.framing_json);
                  void updateMeasurementFraming(id, serializeWallFraming({ ...wf, doubleAllStuds: true, doubledStuds: undefined })).catch((e) => onStatusChange(`ERROR: ${e}`));
                },
              },
              {
                label: "Select studs…",
                action: () => {
                  const wf = parseWallFraming(measurement.framing_json);
                  setDoubleStudSelect({ measurementId: id, pending: wf.doubledStuds ?? [], hoverPos: null });
                },
              },
              ...(parseWallFraming(measurement.framing_json).doubleAllStuds || (parseWallFraming(measurement.framing_json).doubledStuds?.length ?? 0) > 0
                ? [{ label: "Clear doubled studs", danger: true as const, action: () => {
                    const wf = parseWallFraming(measurement.framing_json);
                    void updateMeasurementFraming(id, serializeWallFraming({ ...wf, doubleAllStuds: undefined, doubledStuds: undefined })).catch((e) => onStatusChange(`ERROR: ${e}`));
                  } }]
                : []),
            ],
          });
        }
      }

      // Move, Copy, Delete work for any selection (single or multi).
      const selectionLabel = multiSelected ? `${selectedMeasurementIds.length} measurements` : "measurement";
      items.push({ label: "Move", action: () => startMove() });
      items.push({ label: "Copy", action: () => copySelected() });
      if (clipboardRef.current.length > 0) {
        items.push({ label: "Paste", action: () => startPaste() });
      }
      items.push({
        label: `Delete ${selectionLabel}`,
        danger: true,
        action: () => {
          void deleteSelectedMeasurements();
        },
      });

      setViewerMenu({ x: event.clientX, y: event.clientY, items });
      return;
    }

    event.preventDefault();
  }

  // Nearest segment of `id` under the cursor, with the click projected onto it (page pts).
  function hitTestSegment(clientX: number, clientY: number, id: number): { segmentIndex: number; point: PagePoint } | null {
    const element = viewportRef.current;
    if (!element || !page) return null;
    const points = measurementPoints(id);
    if (!points || points.length < 2) return null;
    const measurement = overlayMeasurements.find((m) => m.id === id);
    const isArea = measurement ? isAreaType(measurement.measurement_type) : false;

    const rect = element.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const screenPts = points.map((point) => pageToScreen(point.x, point.y, page.height_pts, pan, zoom));
    const segmentCount = isArea ? screenPts.length : screenPts.length - 1;

    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < segmentCount; i += 1) {
      const a = screenPts[i];
      const b = screenPts[(i + 1) % screenPts.length];
      const d = distanceToSegment(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    if (bestIndex < 0 || bestDist > 8) return null;

    // Project the cursor onto the chosen segment (in screen space) and map back to page pts.
    const a = screenPts[bestIndex];
    const b = screenPts[(bestIndex + 1) % screenPts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((sx - a.x) * dx + (sy - a.y) * dy) / lengthSq));
    const aPage = points[bestIndex];
    const bPage = points[(bestIndex + 1) % points.length];
    return { segmentIndex: bestIndex, point: { x: aPage.x + t * (bPage.x - aPage.x), y: aPage.y + t * (bPage.y - aPage.y) } };
  }

  // Inserts a vertex after `segmentIndex` (on the closing edge for areas this appends).
  function addVertex(id: number, segmentIndex: number, point: PagePoint) {
    const points = measurementPoints(id);
    if (!points) return;
    const insertAt = segmentIndex + 1;
    const next = [...points.slice(0, insertAt), point, ...points.slice(insertAt)];
    void updateMeasurementGeometry(id, JSON.stringify(next)).catch((error) => onStatusChange(`ERROR: ${error}`));

    const measurement = overlayMeasurements.find((m) => m.id === id);
    const mmpp = pageScale?.mm_per_point ?? null;
    if (measurement?.measurement_type === "timber_framing" && mmpp) {
      const existing = parseWallFraming(measurement.framing_json);
      const { framing, warnings } = reindexFramingForVertexInsertion(existing, points, segmentIndex, point, mmpp);
      void updateMeasurementFraming(id, serializeWallFraming(framing)).catch((error) => onStatusChange(`ERROR: ${error}`));
      if (warnings.length) onStatusChange(warnings.join(" "));
    }
  }

  // Removes a vertex, leaving a straight segment between its neighbours.
  function deleteVertex(id: number, vertexIndex: number) {
    const points = measurementPoints(id);
    if (!points) return;
    const next = points.filter((_, index) => index !== vertexIndex);
    void updateMeasurementGeometry(id, JSON.stringify(next)).catch((error) => onStatusChange(`ERROR: ${error}`));

    const measurement = overlayMeasurements.find((m) => m.id === id);
    const mmpp = pageScale?.mm_per_point ?? null;
    if (measurement?.measurement_type === "timber_framing" && mmpp) {
      const existing = parseWallFraming(measurement.framing_json);
      const { framing, warnings } = reindexFramingForVertexDeletion(existing, points, vertexIndex, mmpp);
      void updateMeasurementFraming(id, serializeWallFraming(framing)).catch((error) => onStatusChange(`ERROR: ${error}`));
      if (warnings.length) onStatusChange(warnings.join(" "));
    }
  }

  function handleDoubleClick() {
    if (!measuring) return;
    finishDraft();
  }

  function finishDraft() {
    if (draftPointsRef.current.length >= 2) {
      void commitDraft(draftPointsRef.current);
    }
    applyDraft([]);
  }

  // While placing an opening, find the nearest framing wall to a page point and project onto it.
  function resolveOpeningGhost(pagePoint: PagePoint | null) {
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!pagePoint || !openingPlacement || !page || !mmpp) {
      setOpeningGhost(null);
      return;
    }
    const scale = (zoom * 96) / 72;
    const thresholdPts = 24 / scale;
    let best: { measurementId: number; segmentIndex: number; centreMm: number; dist: number } | null = null;
    for (const measurement of overlayMeasurements) {
      if (measurement.measurement_type !== "timber_framing" || measurement.page_index !== pageIndex) continue;
      let pts: PagePoint[];
      try {
        pts = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const proj = projectOntoPath(pts, pagePoint, mmpp);
      if (proj && proj.distancePts <= thresholdPts && (!best || proj.distancePts < best.dist)) {
        best = { measurementId: measurement.id, segmentIndex: proj.segmentIndex, centreMm: proj.centreMm, dist: proj.distancePts };
      }
    }
    setOpeningGhost(best ? { measurementId: best.measurementId, segmentIndex: best.segmentIndex, centreMm: best.centreMm } : null);
  }

  // Appends the current opening template onto the ghosted wall at the ghost position.
  function commitOpening() {
    if (!openingPlacement || !openingGhost) return;
    const measurement = overlayMeasurements.find((m) => m.id === openingGhost.measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const opening: Opening = { ...openingPlacement, segmentIndex: openingGhost.segmentIndex, centreMm: openingGhost.centreMm };
    void updateMeasurementFraming(measurement.id, serializeWallFraming({ ...existing, openings: [...existing.openings, opening] })).catch((error) =>
      onStatusChange(`ERROR: ${error}`),
    );
  }

  // Removes opening `index` from a measurement (right-click → Delete door).
  function deleteOpening(measurementId: number, index: number) {
    const measurement = overlayMeasurements.find((m) => m.id === measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const openings = existing.openings.filter((_, i) => i !== index);
    void updateMeasurementFraming(measurementId, serializeWallFraming({ ...existing, openings })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  // Replaces opening `index`'s parameters in place (right-click → Door options).
  function updateOpening(measurementId: number, index: number, template: import("../lib/framing").OpeningTemplate) {
    const measurement = overlayMeasurements.find((m) => m.id === measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const openings = existing.openings.map((o, i) => (i === index ? { ...o, ...template } : o));
    void updateMeasurementFraming(measurementId, serializeWallFraming({ ...existing, openings })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  // Sets (or replaces) the raking frame on one segment of a wall.
  function setRake(measurementId: number, segmentIndex: number, startMm: number, endMm: number, gable: boolean, middleMm?: number, middlePositionMm?: number) {
    const measurement = overlayMeasurements.find((m) => m.id === measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const rakes = [
      ...existing.rakes.filter((r) => r.segmentIndex !== segmentIndex),
      { segmentIndex, startMm, endMm, gable, middleMm: gable ? middleMm : undefined, middlePositionMm: gable ? middlePositionMm : undefined },
    ];
    void updateMeasurementFraming(measurementId, serializeWallFraming({ ...existing, rakes })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  function clearRake(measurementId: number, segmentIndex: number) {
    const measurement = overlayMeasurements.find((m) => m.id === measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const rakes = existing.rakes.filter((r) => r.segmentIndex !== segmentIndex);
    void updateMeasurementFraming(measurementId, serializeWallFraming({ ...existing, rakes })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  // Ctrl-hover: project onto the nearest framing wall to position a ghost extra stud.
  function resolveStudGhost(pagePoint: PagePoint | null) {
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!pagePoint || !page || !mmpp) {
      setStudGhost(null);
      return;
    }
    const scale = (zoom * 96) / 72;
    const thresholdPts = 24 / scale;
    let best: { measurementId: number; segmentIndex: number; centreMm: number; dist: number } | null = null;
    for (const measurement of overlayMeasurements) {
      if (measurement.measurement_type !== "timber_framing" || measurement.page_index !== pageIndex) continue;
      let pts: PagePoint[];
      try {
        pts = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const proj = projectOntoPath(pts, pagePoint, mmpp);
      if (proj && proj.distancePts <= thresholdPts && (!best || proj.distancePts < best.dist)) {
        best = { measurementId: measurement.id, segmentIndex: proj.segmentIndex, centreMm: proj.centreMm, dist: proj.distancePts };
      }
    }
    setStudGhost(best ? { measurementId: best.measurementId, segmentIndex: best.segmentIndex, centreMm: best.centreMm } : null);
  }

  function resolveDoubleStudHover(clientX: number, clientY: number) {
    if (!doubleStudSelect || !page) return;
    const element = viewportRef.current;
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!element || !mmpp) return;
    const measurement = overlayMeasurements.find((m) => m.id === doubleStudSelect.measurementId);
    if (!measurement) return;
    let pts: PagePoint[] | null = null;
    try { pts = JSON.parse(measurement.geometry_json); } catch { pts = null; }
    if (!Array.isArray(pts) || pts.length < 2) return;
    const settings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
    const positions = wallStudPositions(pts, settings, mmpp);
    const domRect = element.getBoundingClientRect();
    const sx = clientX - domRect.left;
    const sy = clientY - domRect.top;
    const RADIUS_PX = 20;
    let best: { segmentIndex: number; centreMm: number; distSq: number } | null = null;
    for (const pos of positions) {
      const a = pts[pos.segmentIndex];
      const b = pts[pos.segmentIndex + 1];
      if (!a || !b) continue;
      const dx = b.x - a.x; const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const dir = { x: dx / len, y: dy / len };
      const sPts = pos.centreMm / mmpp;
      const centre = pageToScreen(a.x + dir.x * sPts, a.y + dir.y * sPts, page.height_pts, pan, zoom);
      const distSq = (centre.x - sx) ** 2 + (centre.y - sy) ** 2;
      if (distSq <= RADIUS_PX ** 2 && (!best || distSq < best.distSq)) {
        best = { segmentIndex: pos.segmentIndex, centreMm: pos.centreMm, distSq };
      }
    }
    setDoubleStudSelect((prev) => prev ? { ...prev, hoverPos: best ? { segmentIndex: best.segmentIndex, centreMm: best.centreMm } : null } : null);
  }

  function commitExtraStud() {
    if (!studGhost) return;
    const measurement = overlayMeasurements.find((m) => m.id === studGhost.measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const extraStuds = [...existing.extraStuds, { segmentIndex: studGhost.segmentIndex, centreMm: studGhost.centreMm }];
    void updateMeasurementFraming(measurement.id, serializeWallFraming({ ...existing, extraStuds })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  function deleteExtraStud(measurementId: number, index: number) {
    const measurement = overlayMeasurements.find((m) => m.id === measurementId);
    if (!measurement) return;
    const existing = parseWallFraming(measurement.framing_json);
    const extraStuds = existing.extraStuds.filter((_, i) => i !== index);
    void updateMeasurementFraming(measurementId, serializeWallFraming({ ...existing, extraStuds })).catch((error) => onStatusChange(`ERROR: ${error}`));
  }

  // Id + index of a committed extra stud near the cursor (by its centre), or null.
  function hitTestExtraStud(clientX: number, clientY: number): { measurementId: number; index: number } | null {
    const element = viewportRef.current;
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!element || !page || !mmpp) return null;
    const rect = element.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    let best: { measurementId: number; index: number; dist: number } | null = null;
    for (const measurement of overlayMeasurements) {
      if (measurement.measurement_type !== "timber_framing" || measurement.page_index !== pageIndex) continue;
      let pts: PagePoint[];
      try {
        pts = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts)) continue;
      const extras = parseWallFraming(measurement.framing_json).extraStuds;
      const settings = parseFramingSettings(groupProps[measurement.dimension_group_id]?.framing_props_json ?? null);
      for (let index = 0; index < extras.length; index += 1) {
        const r = extraStudRect(pts, settings, mmpp, extras[index].segmentIndex, extras[index].centreMm);
        if (!r) continue;
        const c = r.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
        const cx = (c[0].x + c[2].x) / 2;
        const cy = (c[0].y + c[2].y) / 2;
        const dist = Math.hypot(sx - cx, sy - cy);
        if (dist <= 12 && (!best || dist < best.dist)) best = { measurementId: measurement.id, index, dist };
      }
    }
    return best ? { measurementId: best.measurementId, index: best.index } : null;
  }

  // Id + index of a committed opening near the cursor (by its daylight centre), or null.
  function hitTestOpening(clientX: number, clientY: number): { measurementId: number; index: number; opening: Opening } | null {
    const element = viewportRef.current;
    const mmpp = pageScale?.mm_per_point ?? null;
    if (!element || !page || !mmpp) return null;
    const rect = element.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const scale = (zoom * 96) / 72;
    let best: { measurementId: number; index: number; opening: Opening; dist: number } | null = null;
    for (const measurement of overlayMeasurements) {
      if (measurement.measurement_type !== "timber_framing" || measurement.page_index !== pageIndex) continue;
      let pts: PagePoint[];
      try {
        pts = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts)) continue;
      const openings = parseWallFraming(measurement.framing_json).openings;
      for (let index = 0; index < openings.length; index += 1) {
        const o = openings[index];
        const a = pts[o.segmentIndex];
        const b = pts[o.segmentIndex + 1];
        if (!a || !b) continue;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (segLen < 1e-6) continue;
        const sPts = o.centreMm / mmpp;
        const centre = { x: a.x + ((b.x - a.x) / segLen) * sPts, y: a.y + ((b.y - a.y) / segLen) * sPts };
        const screen = pageToScreen(centre.x, centre.y, page.height_pts, pan, zoom);
        const halfWidthPx = (o.daylightWidthMm / mmpp) * scale * 0.5;
        const dist = Math.hypot(sx - screen.x, sy - screen.y);
        if (dist <= Math.max(10, halfWidthPx) && (!best || dist < best.dist)) {
          best = { measurementId: measurement.id, index, opening: o, dist };
        }
      }
    }
    return best ? { measurementId: best.measurementId, index: best.index, opening: best.opening } : null;
  }

  // Parsed geometry of a measurement by id (PDF points), or null.
  function measurementPoints(id: number): PagePoint[] | null {
    const measurement = overlayMeasurements.find((m) => m.id === id);
    if (!measurement) return null;
    try {
      const points = JSON.parse(measurement.geometry_json);
      return Array.isArray(points) ? points : null;
    } catch {
      return null;
    }
  }

  // Index of the vertex of `id` under the cursor (within handle radius), or -1.
  function hitTestVertex(clientX: number, clientY: number, id: number): number {
    return nearestVertex(clientX, clientY, id, VERTEX_RADIUS + 5);
  }

  // Index of the closest vertex of `id` within `radius` screen px, or -1.
  function nearestVertex(clientX: number, clientY: number, id: number, radius: number): number {
    const element = viewportRef.current;
    if (!element || !page) return -1;
    const points = measurementPoints(id);
    if (!points) return -1;
    const rect = element.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    let bestIndex = -1;
    let bestDist = radius;
    for (let i = 0; i < points.length; i += 1) {
      const s = pageToScreen(points[i].x, points[i].y, page.height_pts, pan, zoom);
      const d = Math.hypot(screenX - s.x, screenY - s.y);
      if (d <= bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  // Id of the topmost committed dimension under the cursor, or null.
  function hitTestMeasurementId(clientX: number, clientY: number): number | null {
    const element = viewportRef.current;
    if (!element || !page) return null;
    const rect = element.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const tolerance = 6;

    // Iterate in reverse so the most-recently-drawn dimension wins.
    for (let m = overlayMeasurements.length - 1; m >= 0; m -= 1) {
      const measurement = overlayMeasurements[m];
      if (measurement.page_index !== pageIndex) continue;
      let points: PagePoint[];
      try {
        points = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(points) || points.length < 1) continue;
      const screenPts = points.map((point) => pageToScreen(point.x, point.y, page.height_pts, pan, zoom));

      // Count markers are hit by proximity to the point; custom shapes are hit by their
      // rendered rectangle footprint instead.
      if (measurement.measurement_type === "count") {
        const props = groupProps[measurement.dimension_group_id];
        const extents = props?.count_type === "custom" ? customCountHalfExtentsPx(props, pageScale?.mm_per_point ?? null, zoom) : null;
        const hit = extents
          ? screenPts.some((s) => Math.abs(screenX - s.x) <= extents.halfW + tolerance && Math.abs(screenY - s.y) <= extents.halfH + tolerance)
          : screenPts.some((s) => Math.hypot(screenX - s.x, screenY - s.y) <= 8);
        if (hit) return measurement.id;
        continue;
      }
      if (screenPts.length < 2) continue;

      // Array: test all (trimmed) member segments.
      if (measurement.measurement_type === "array") {
        const meta = parseArrayMeta(measurement.framing_json ?? null);
        const members = getArrayMembers(points[0], points[1], meta);
        const absTrimsList = absTrims(meta.trims, points[0]);
        for (const member of members) {
          for (const clipped of applyTrimsToSegment(member, absTrimsList)) {
            const sa = pageToScreen(clipped[0].x, clipped[0].y, page.height_pts, pan, zoom);
            const sb = pageToScreen(clipped[1].x, clipped[1].y, page.height_pts, pan, zoom);
            if (distanceToSegment(screenX, screenY, sa.x, sa.y, sb.x, sb.y) <= tolerance) return measurement.id;
          }
        }
        continue;
      }

      const isArea = isAreaType(measurement.measurement_type);
      const segmentCount = isArea ? screenPts.length : screenPts.length - 1;
      for (let i = 0; i < segmentCount; i += 1) {
        const a = screenPts[i];
        const b = screenPts[(i + 1) % screenPts.length];
        if (distanceToSegment(screenX, screenY, a.x, a.y, b.x, b.y) <= tolerance) return measurement.id;
      }
    }
    return null;
  }

  // Returns the IDs of measurements on this page that fall inside (or overlap) the marquee box.
  // Left-to-right (window): all vertices must be inside. Right-to-left (crossing): bounding box overlaps.
  function marqueeSelectIds(startClient: { x: number; y: number }, endClient: { x: number; y: number }): number[] {
    const element = viewportRef.current;
    if (!element || !page) return [];
    const domRect = element.getBoundingClientRect();
    const sx1 = startClient.x - domRect.left;
    const sy1 = startClient.y - domRect.top;
    const sx2 = endClient.x - domRect.left;
    const sy2 = endClient.y - domRect.top;
    const leftToRight = sx2 >= sx1;
    const minX = Math.min(sx1, sx2);
    const maxX = Math.max(sx1, sx2);
    const minY = Math.min(sy1, sy2);
    const maxY = Math.max(sy1, sy2);
    const ids: number[] = [];
    for (const m of overlayMeasurements) {
      if (m.page_index !== pageIndex) continue;
      let pts: PagePoint[];
      try {
        pts = JSON.parse(m.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(pts) || pts.length < 1) continue;
      const screenPts = pts.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
      if (leftToRight) {
        if (screenPts.every((s) => s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY)) ids.push(m.id);
      } else {
        const bMinX = Math.min(...screenPts.map((s) => s.x));
        const bMaxX = Math.max(...screenPts.map((s) => s.x));
        const bMinY = Math.min(...screenPts.map((s) => s.y));
        const bMaxY = Math.max(...screenPts.map((s) => s.y));
        if (bMaxX >= minX && bMinX <= maxX && bMaxY >= minY && bMinY <= maxY) ids.push(m.id);
      }
    }
    return ids;
  }

  function copySelected() {
    const selected = overlayMeasurements.filter((m) => selectedSet.has(m.id) && m.page_index === pageIndex);
    if (selected.length === 0) return;
    setClipboard(selected);
    clipboardRef.current = selected;
  }

  // Ribbon Takeoff Item group: rotate or flip the selected measurement(s) about their
  // shared centroid and persist. Same geometry math as the paste-ghost arrow-key
  // flip/rotate, just applied to an existing selection instead of the clipboard.
  async function rotateOrFlipSelected(action: "rotateCcw" | "rotateCw" | "flipH" | "flipV") {
    const pageIds = selectedMeasurementIds.filter((id) => overlayMeasurements.find((m) => m.id === id)?.page_index === pageIndex);
    if (pageIds.length === 0) return;
    const selected = overlayMeasurements.filter((m) => pageIds.includes(m.id));
    const centroid = measurementsCentroid(selected);
    const transformed =
      action === "rotateCcw" || action === "rotateCw"
        ? rotateMeasurements(selected, centroid, action === "rotateCcw")
        : flipMeasurements(selected, centroid, action === "flipH" ? "x" : "y");
    for (const m of transformed) {
      await updateMeasurementGeometry(m.id, m.geometry_json).catch((e) => onStatusChange(`ERROR: ${e}`));
    }
  }

  // Ribbon → viewer bridge: the ribbon's Takeoff Item buttons bump `viewerCommand.seq`.
  useEffect(() => {
    if (!viewerCommand || viewerCommand.seq === lastViewerCommandSeq.current) return;
    lastViewerCommandSeq.current = viewerCommand.seq;
    void rotateOrFlipSelected(viewerCommand.action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewerCommand]);

  function startMove() {
    const pageIds = selectedMeasurementIds.filter((id) => overlayMeasurements.find((m) => m.id === id)?.page_index === pageIndex);
    if (pageIds.length === 0) return;
    const selected = overlayMeasurements.filter((m) => pageIds.includes(m.id));
    const centroid = measurementsCentroid(selected);
    moveModeRef.current = { anchorPage: centroid };
    setMoveMode({ anchorPage: centroid });
  }

  async function commitMove(cursor: PagePoint) {
    const anchor = moveModeRef.current;
    if (!anchor) return;
    moveModeRef.current = null;
    setMoveMode(null);
    const dx = cursor.x - anchor.anchorPage.x;
    const dy = cursor.y - anchor.anchorPage.y;
    for (const id of selectedMeasurementIds) {
      const m = overlayMeasurements.find((x) => x.id === id);
      if (!m) continue;
      try {
        const pts = JSON.parse(m.geometry_json) as PagePoint[];
        const newPts = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        await updateMeasurementGeometry(id, JSON.stringify(newPts)).catch((e) => onStatusChange(`ERROR: ${e}`));
        // Trims are stored relative to pts[0], so they follow the geometry automatically —
        // no framing_json update needed here.
      } catch {
        // skip unparseable
      }
    }
  }

  function startPaste() {
    const cb = clipboardRef.current;
    if (cb.length === 0) return;
    const centroid = measurementsCentroid(cb);
    pasteModeRef.current = { centroid };
    setPasteMode({ centroid });
    // Ensure cursor tracking is active so the ghost appears immediately.
  }

  async function commitPaste(cursor: PagePoint) {
    const pm = pasteModeRef.current;
    const cb = clipboardRef.current;
    if (!pm || cb.length === 0) return;
    pasteModeRef.current = null;
    setPasteMode(null);
    const dx = cursor.x - pm.centroid.x;
    const dy = cursor.y - pm.centroid.y;
    const newIds: number[] = [];
    for (const m of cb) {
      try {
        const pts = JSON.parse(m.geometry_json) as PagePoint[];
        const newPts = pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        const created = await createMeasurement({
          measurementType: m.measurement_type,
          geometryJson: JSON.stringify(newPts),
          polarity: m.polarity,
        }).catch((e) => { onStatusChange(`ERROR: ${e}`); return null; });
        if (created) {
          // For timber-framing walls, carry over openings (doors/windows), extra studs,
          // and raking frames.  These are all stored as arc-length positions along the
          // wall path (in mm), so they're valid regardless of where the wall is placed.
          if (m.framing_json) {
            await updateMeasurementFraming(created.id, m.framing_json).catch((e) => onStatusChange(`ERROR: ${e}`));
          }
          newIds.push(created.id);
        }
      } catch {
        // skip
      }
    }
    if (newIds.length > 0) setSelectedMeasurementIds(newIds);
  }

  async function deleteSelectedMeasurements() {
    await Promise.all(
      selectedMeasurementIds.map((id) => deleteMeasurement(id).catch((e) => onStatusChange(`ERROR: ${e}`))),
    );
  }

  // Hover card over committed measurements.
  function updateHover(clientX: number, clientY: number) {
    const element = viewportRef.current;
    if (!element || !page) {
      setHoverInfo(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    const screenX = clientX - rect.left;
    const screenY = clientY - rect.top;
    const tolerance = 6;

    for (const measurement of overlayMeasurements) {
      if (measurement.page_index !== pageIndex) continue;
      let points: PagePoint[];
      try {
        points = JSON.parse(measurement.geometry_json);
      } catch {
        continue;
      }
      if (!Array.isArray(points) || points.length < 1) continue;

      const screenPts = points.map((point) => pageToScreen(point.x, point.y, page.height_pts, pan, zoom));
      const props = groupProps[measurement.dimension_group_id];
      const groupNode = findGroupNode(dimensionRoots, childCache, measurement.dimension_group_id);
      const groupName = groupNode?.name ?? "";
      const mPerPt = pageScale ? pageScale.mm_per_point / 1000 : null;

      // Count markers: hover by proximity to the point (or the shape footprint for custom
      // shapes), showing the count value.
      if (measurement.measurement_type === "count") {
        const extents = props?.count_type === "custom" ? customCountHalfExtentsPx(props, pageScale?.mm_per_point ?? null, zoom) : null;
        const hovered = extents
          ? screenPts.some((s) => Math.abs(screenX - s.x) <= extents.halfW && Math.abs(screenY - s.y) <= extents.halfH)
          : screenPts.some((s) => Math.hypot(screenX - s.x, screenY - s.y) <= 8);
        if (hovered) {
          const quantity = props ? deriveQuantity(points, pageScale?.mm_per_point ?? null, props) : null;
          const rows: HoverCardRow[] = [{ label: "Total Count", value: quantity ? formatQuantity(quantity) : "1" }];
          if (props?.count_type === "custom") {
            rows.push({ label: "Custom Height", value: `${Math.round(props.default_height * 1000)}mm` });
            rows.push({ label: "Custom Width", value: `${Math.round(props.default_width * 1000)}mm` });
          }
          setHoverInfo({
            x: clientX,
            y: clientY,
            icon: MEASUREMENT_TYPE_ICONS.count,
            groupTypeLabel: MEASUREMENT_TYPE_LABELS.count,
            groupName,
            mainValue: quantity ? quantityValueText(quantity) : "1",
            mainValueUom: quantity?.uom ?? "no",
            rows,
          });
          return;
        }
        continue;
      }
      if (screenPts.length < 2) continue;

      // Array: hit-test all member segments (after trim); remember which trimmed piece was hit
      // so we can report its own length as the "current segment".
      if (measurement.measurement_type === "array") {
        const meta = parseArrayMeta(measurement.framing_json ?? null);
        const members = getArrayMembers(points[0], points[1], meta);
        const absTrimsList = absTrims(meta.trims, points[0]);
        let hitSeg: [PagePoint, PagePoint] | null = null;
        for (const member of members) {
          for (const clipped of applyTrimsToSegment(member, absTrimsList)) {
            const sa = pageToScreen(clipped[0].x, clipped[0].y, page.height_pts, pan, zoom);
            const sb = pageToScreen(clipped[1].x, clipped[1].y, page.height_pts, pan, zoom);
            if (distanceToSegment(screenX, screenY, sa.x, sa.y, sb.x, sb.y) <= tolerance) { hitSeg = clipped; break; }
          }
          if (hitSeg) break;
        }
        if (hitSeg) {
          const quantity = props ? deriveQuantity(points, pageScale?.mm_per_point ?? null, props, measurement.framing_json) : null;
          const lengthQty = props ? deriveQuantity(points, pageScale?.mm_per_point ?? null, { ...props, default_display: "length" }, measurement.framing_json) : null;
          const countQty = props ? deriveQuantity(points, pageScale?.mm_per_point ?? null, { ...props, default_display: "count" }, measurement.framing_json) : null;
          const m = props?.default_multiplier ?? 1;
          // Array pitch is a flat 1/cos(angle) scale (no direction), same as a single-segment
          // Length — applies uniformly to every member, including this hit-tested one.
          const arrayPitchRad = ((props?.pitch_angle_deg ?? 0) * Math.PI) / 180;
          const arrayPitchScale = arrayPitchRad !== 0 ? 1 / Math.cos(arrayPitchRad) : 1;
          const segLenM = mPerPt != null ? Math.hypot(hitSeg[1].x - hitSeg[0].x, hitSeg[1].y - hitSeg[0].y) * mPerPt * m * arrayPitchScale : null;
          setHoverInfo({
            x: clientX,
            y: clientY,
            icon: MEASUREMENT_TYPE_ICONS.array,
            groupTypeLabel: MEASUREMENT_TYPE_LABELS.array,
            groupName,
            mainValue: quantity ? quantityValueText(quantity) : formatLength(pathLengthPts(points), pageScale),
            mainValueUom: quantity?.uom,
            rows: [
              { label: "Length (Current Segment)", value: segLenM != null ? formatQuantity({ value: segLenM, uom: "m" }) : "—" },
              { label: "Total Length", value: lengthQty ? formatQuantity(lengthQty) : formatLength(pathLengthPts(points), pageScale) },
              { label: "Count", value: countQty ? formatQuantity(countQty) : "—" },
            ],
          });
          return;
        }
        continue;
      }

      // Timber-framing door/window openings: hit-test the opening's own daylight footprint (the
      // void in the wall) BEFORE the generic per-edge wall test below, so hovering directly over a
      // door/window shows its own king/trimmer/lintel/jack/sill breakdown instead of just the wall
      // segment's totals — previously an opening had no dedicated hover at all.
      if (measurement.measurement_type === "timber_framing") {
        const settings = parseFramingSettings(props?.framing_props_json ?? null);
        const wallFraming = parseWallFraming(measurement.framing_json);
        const geometry = computeFramingGeometry(points, settings, pageScale?.mm_per_point ?? null, wallFraming);
        const hitOpening = geometry.openings.find((opening) => {
          const screenRect = opening.daylight.map((p) => pageToScreen(p.x, p.y, page.height_pts, pan, zoom));
          return pointInPolygon({ x: screenX, y: screenY }, screenRect);
        });
        const openingData = hitOpening
          ? wallFraming.openings.find((o) => o.segmentIndex === hitOpening.segmentIndex && Math.abs(o.centreMm - hitOpening.centreMm) < 1)
          : null;
        if (hitOpening && openingData) {
          // Filter the ONE full-wall member list by the opening identity tagged in wallMembers()
          // (openingSegmentIndex/openingCentreMm) — same "filter the real computation" approach as
          // the per-segment breakdown above, so corner/rake context stays correct.
          const allMembers = wallMembers(points, settings, pageScale?.mm_per_point ?? null, wallFraming);
          const openingMembers = allMembers.filter(
            (mem) => mem.openingSegmentIndex === hitOpening.segmentIndex && Math.abs((mem.openingCentreMm ?? -Infinity) - hitOpening.centreMm) < 1,
          );
          const sumKind = (kind: string) => openingMembers.filter((mem) => mem.kind === kind).reduce((sum, mem) => sum + mem.lengthM, 0);
          const kingM = sumKind("king");
          const trimmerM = sumKind("trimmer");
          const lintelM = sumKind("lintel");
          const jackM = sumKind("jack");
          const sillJackM = sumKind("sill_jack");
          const sillM = sumKind("sill");
          const totalM = openingMembers.reduce((sum, mem) => sum + mem.lengthM, 0);
          const isWindow = openingData.kind === "window";
          const rows: HoverCardRow[] = [
            { label: "King Studs", value: formatQuantity({ value: kingM, uom: "m" }) },
            { label: "Trimmer Studs", value: formatQuantity({ value: trimmerM, uom: "m" }) },
            { label: "Lintel", value: formatQuantity({ value: lintelM, uom: "m" }) },
          ];
          if (isWindow) {
            rows.push({ label: "Jack Studs", value: formatQuantity({ value: jackM, uom: "m" }) });
            rows.push({ label: "Sill Jacks", value: formatQuantity({ value: sillJackM, uom: "m" }) });
            rows.push({ label: "Sill Plates", value: formatQuantity({ value: sillM, uom: "m" }) });
          } else if (jackM > 1e-6) {
            // Not in the reference template's baseline door card, but a wide-enough door still gets
            // real interior cripple studs above the head — surface them rather than silently drop.
            rows.push({ label: "Jack Studs", value: formatQuantity({ value: jackM, uom: "m" }) });
          }
          setHoverInfo({
            x: clientX,
            y: clientY,
            icon: isWindow ? "window_closed" : "door_front",
            groupTypeLabel: isWindow ? "Window Opening" : "Door Opening",
            groupName: `${openingData.daylightWidthMm}mm x ${openingData.daylightHeightMm}mm`,
            mainValue: totalM.toFixed(2),
            mainValueUom: "m",
            rows,
          });
          return;
        }
      }

      const isArea = isAreaType(measurement.measurement_type);
      const segmentCount = isArea ? screenPts.length : screenPts.length - 1;
      for (let i = 0; i < segmentCount; i += 1) {
        const a = screenPts[i];
        const b = screenPts[(i + 1) % screenPts.length];
        if (distanceToSegment(screenX, screenY, a.x, a.y, b.x, b.y) <= tolerance) {
          if (measurement.measurement_type === "timber_framing") {
            const settings = parseFramingSettings(props?.framing_props_json ?? null);
            const wallFraming = parseWallFraming(measurement.framing_json);
            const q = computeFramingQuantities(points, settings, pageScale?.mm_per_point ?? null, wallFraming);
            // Filter the ONE full-wall member list (correct corner-makeup/packer geometry, since
            // it sees every neighbouring segment) down to members tagged with this edge's index,
            // rather than recomputing framing on an isolated 2-point sub-wall — that would lose
            // corner context and mis-place/omit the corner studs & packers shown in the reference
            // diagram.
            const allMembers = wallMembers(points, settings, pageScale?.mm_per_point ?? null, wallFraming);
            const segMembers = allMembers.filter((mem) => mem.segmentIndex === i);
            const segStudCount = segMembers.filter((mem) => mem.kind === "stud").length;
            // "matchingTotalM" convention (see CLAUDE.md / framing-multi-size-model): lintels are
            // excluded from the group's own-size total, since a lintel can be a different framing
            // size to the wall (sizeOverride is set only on lintel members) — summing it in would
            // mix two different timber sizes into one lineal-metre figure.
            const matchingTotalM = (members: typeof allMembers) => members.filter((mem) => !mem.sizeOverride).reduce((sum, mem) => sum + mem.lengthM, 0);
            const wholeWallMatchingTotalM = matchingTotalM(allMembers);
            const segMatchingTotalM = matchingTotalM(segMembers);
            const segLenM = mPerPt != null ? Math.hypot(points[i].x - points[i + 1].x, points[i].y - points[i + 1].y) * mPerPt : null;
            setHoverInfo({
              x: clientX,
              y: clientY,
              icon: MEASUREMENT_TYPE_ICONS.timber_framing,
              groupTypeLabel: MEASUREMENT_TYPE_LABELS.timber_framing,
              groupName,
              framingSize: settings.framingSize.replace("x", " × "),
              mainValue: wholeWallMatchingTotalM.toFixed(2),
              mainValueUom: "m",
              rows: [
                { label: "Plate Run", value: q ? `${q.wallLengthM.toFixed(2)} M` : "—" },
                { label: "Total Studs", value: q ? `${q.studCount} NO` : "—" },
                { label: "Wall Height", value: `${(settings.wallHeightMm / 1000).toFixed(2)} M` },
                { label: "Studs in Current Segment", value: `${segStudCount} NO` },
                { label: "Plate Run (Current Segment)", value: segLenM != null ? `${segLenM.toFixed(2)} M` : "—" },
                { label: "Current Segment Total", value: `${segMatchingTotalM.toFixed(2)} M` },
              ],
            });
            return;
          }

          const quantity = props ? deriveQuantity(points, pageScale?.mm_per_point ?? null, props) : null;
          const h = props?.default_height ?? 0;
          const m = props?.default_multiplier ?? 1;
          const pitchRad = ((props?.pitch_angle_deg ?? 0) * Math.PI) / 180;
          const dirRad = ((props?.pitch_direction_deg ?? 0) * Math.PI) / 180;
          const hasPitch = pitchRad !== 0;

          if (isArea) {
            const perimeterM = mPerPt != null ? (hasPitch ? pitchedPolygonPerimeterPts(points, pitchRad, dirRad) : polygonPerimeterPts(points)) * mPerPt : null;
            // Area total is direction-independent for a mono-pitch: plan_area / cos(pitchRad).
            const areaM2 = mPerPt != null ? (hasPitch ? polygonAreaPts(points) / Math.cos(pitchRad) : polygonAreaPts(points)) * mPerPt * mPerPt : null;
            const nextIdx = (i + 1) % points.length;
            const segLenM =
              mPerPt != null
                ? (hasPitch
                    ? pitchedSegmentLengthPts(points[nextIdx].x - points[i].x, points[nextIdx].y - points[i].y, pitchRad, dirRad)
                    : Math.hypot(points[i].x - points[nextIdx].x, points[i].y - points[nextIdx].y)) * mPerPt
                : null;
            setHoverInfo({
              x: clientX,
              y: clientY,
              icon: MEASUREMENT_TYPE_ICONS.area,
              groupTypeLabel: MEASUREMENT_TYPE_LABELS.area,
              groupName,
              mainValue: quantity ? quantityValueText(quantity) : formatLength(pathLengthPts(points), pageScale),
              mainValueUom: quantity?.uom,
              rows: [
                { label: "Current Segment Length", value: segLenM != null ? formatQuantity({ value: segLenM * m, uom: "m" }) : "—" },
                { label: "Current Segment Wall Area", value: segLenM != null ? formatQuantity({ value: segLenM * h * m, uom: "m²" }) : "—" },
                { label: "Area", value: areaM2 != null ? formatQuantity({ value: areaM2 * m, uom: "m²" }) : "—" },
                { label: "Wall Area", value: perimeterM != null ? formatQuantity({ value: perimeterM * h * m, uom: "m²" }) : "—" },
                { label: "Perimeter Total", value: perimeterM != null ? formatQuantity({ value: perimeterM * m, uom: "m" }) : "—" },
                { label: "Volume Total", value: areaM2 != null ? formatQuantity({ value: areaM2 * h * m, uom: "m³" }) : "—" },
              ],
              pitchIndicator: hasPitch ? computePitchIndicator(points, props?.pitch_angle_deg ?? 0, dirRad) : undefined,
            });
            return;
          }

          const boundaryM =
            mPerPt != null
              ? (hasPitch
                  ? points.length === 2
                    ? pathLengthPts(points) / Math.cos(pitchRad)
                    : pitchedPolylineLengthPts(points, pitchRad, dirRad)
                  : pathLengthPts(points)) * mPerPt
              : null;
          // Single 2-point Length measurement: no direction dependency (same flat rule as
          // boundaryM above), so this row always matches "Total Length" for that case.
          const segLenM =
            mPerPt != null
              ? (hasPitch
                  ? points.length === 2
                    ? Math.hypot(points[i].x - points[i + 1].x, points[i].y - points[i + 1].y) / Math.cos(pitchRad)
                    : pitchedSegmentLengthPts(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y, pitchRad, dirRad)
                  : Math.hypot(points[i].x - points[i + 1].x, points[i].y - points[i + 1].y)) * mPerPt
              : null;
          setHoverInfo({
            x: clientX,
            y: clientY,
            icon: MEASUREMENT_TYPE_ICONS.length,
            groupTypeLabel: MEASUREMENT_TYPE_LABELS.length,
            groupName,
            mainValue: quantity ? quantityValueText(quantity) : formatLength(pathLengthPts(points), pageScale),
            mainValueUom: quantity?.uom,
            rows: [
              { label: "Length (Current Segment)", value: segLenM != null ? formatQuantity({ value: segLenM * m, uom: "m" }) : "—" },
              { label: "Wall Area (Current Segment)", value: segLenM != null ? formatQuantity({ value: segLenM * h * m, uom: "m²" }) : "—" },
              { label: "Total Length", value: boundaryM != null ? formatQuantity({ value: boundaryM * m, uom: "m" }) : formatLength(pathLengthPts(points), pageScale) },
              { label: "Total Wall Area", value: boundaryM != null ? formatQuantity({ value: boundaryM * h * m, uom: "m²" }) : "—" },
            ],
            pitchIndicator: hasPitch ? computePitchIndicator(points, props?.pitch_angle_deg ?? 0, dirRad) : undefined,
          });
          return;
        }
      }
    }
    setHoverInfo(null);
  }

  function scheduleSnapResolution(clientX: number, clientY: number) {
    latestSnapPointerRef.current = { clientX, clientY };
    if (snapFrameRef.current !== null) return;

    snapFrameRef.current = window.requestAnimationFrame(() => {
      snapFrameRef.current = null;
      const latest = latestSnapPointerRef.current;
      const element = viewportRef.current;
      if (!latest || !element || !doc || !page) {
        clearSnap();
        return;
      }

      // Shift held or snap disabled: free-cursor mode — no snapping, no ortho-lock.
      if (shiftHeldRef.current || !useAppStore.getState().snapEnabled) {
        clearSnap();
        return;
      }

      const rect = element.getBoundingClientRect();
      const screenX = latest.clientX - rect.left;
      const screenY = latest.clientY - rect.top;
      const scale = (zoom * 96) / 72;
      const pagePtX = (screenX + pan.x) / scale;
      const pagePtY = page.height_pts - (screenY + pan.y) / scale;
      const currentDrawingType = useAppStore.getState().drawingType;
      if (currentDrawingType === "line") {
        const lineRadius = 20 / scale;
        resolveLineSnap(pagePtX, pagePtY, pageIndex, lineRadius);
      } else {
        const radiusPts = 12 / scale;
        resolveSnap(pagePtX, pagePtY, pageIndex, radiusPts);
      }
    });
  }

  function handleWheel(event: WheelEvent) {
    if (!doc || !page) return;
    event.preventDefault();

    const element = viewportRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const oldZoom = zoom;
    const nextZoom = Math.max(0.08, Math.min(8, oldZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const scale = nextZoom / oldZoom;
    const nextPan = {
      x: (pan.x + cursorX) * scale - cursorX,
      y: (pan.y + cursorY) * scale - cursorY,
    };

    setZoom(nextZoom);
    setPan(clampPan(nextPan, nextZoom));
  }

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  });

  // Linear-tool keyboard shortcuts: Esc cancels, Enter finishes a polyline, Backspace undoes a vertex.
  useEffect(() => {
    if (!measuring) return;
    function onKeyDown(event: KeyboardEvent) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      if (event.key === "Escape") {
        applyDraft([]);
        arrayExtraMembersRef.current = 0;
        arrayDirectionRef.current = 1;
        setArrayExtraMembers(0);
        setArrayDirection(1);
      } else if (event.key === "Enter") {
        const pts = draftPointsRef.current;
        if (drawingArray) {
          // Array: Enter commits with current extrusion (0 extra = single member).
          if (pts.length < 2) {
            onStatusChange("An array needs at least 2 points for the baseline");
            return;
          }
          void commitArrayDraft(
            [pts[0], pts[1]],
            arrayExtraMembersRef.current,
            arrayDirectionRef.current,
          ).then(() => {
            applyDraft([]);
            arrayExtraMembersRef.current = 0;
            arrayDirectionRef.current = 1;
            setArrayExtraMembers(0);
            setArrayDirection(1);
          });
        } else {
          finishDraft();
        }
      } else if (event.key === "Backspace") {
        event.preventDefault();
        if (drawingArray && draftPointsRef.current.length >= 2) {
          // In extruding phase: Backspace cancels extrusion and returns to baseline phase.
          applyDraft((prev) => prev.slice(0, 1));
          arrayExtraMembersRef.current = 0;
          arrayDirectionRef.current = 1;
          setArrayExtraMembers(0);
          setArrayDirection(1);
        } else {
          applyDraft((prev) => prev.slice(0, -1));
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, drawingArray, commitDraft, commitArrayDraft, applyDraft]);

  // Opening placement: Esc cancels; leaving placement clears any ghost.
  useEffect(() => {
    if (!openingPlacement) {
      setOpeningGhost(null);
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpeningPlacement(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openingPlacement, setOpeningPlacement]);

  // Array trim mode keyboard: Esc cancels the in-progress trim, Enter commits it.
  useEffect(() => {
    if (!arrayTrimMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setArrayTrimDraft([]);
        arrayTrimDraftRef.current = [];
        setArrayTrimKeepPt(null);
      } else if (event.key === "Enter") {
        const draft = arrayTrimDraftRef.current;
        if (!arrayTrimKeepPt) return;
        if (arrayTrimType === "line" && draft.length === 2) {
          const absTrim: ArrayTrim = {
            x1: draft[0].x, y1: draft[0].y,
            x2: draft[1].x, y2: draft[1].y,
            keepX: arrayTrimKeepPt.x, keepY: arrayTrimKeepPt.y,
          };
          void commitArrayTrim(absTrim);
        } else if (arrayTrimType === "box" && draft.length >= 3) {
          const absTrim: BoxTrim = {
            kind: "box",
            points: draft,
            keepX: arrayTrimKeepPt.x, keepY: arrayTrimKeepPt.y,
          };
          void commitArrayTrim(absTrim);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrayTrimMode, arrayTrimType, arrayTrimKeepPt, commitArrayTrim]);

  // Pitch-direction pick keyboard: Esc cancels (dialog reopens with direction unchanged).
  useEffect(() => {
    if (!pitchDirectionMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") resolvePitchDirectionPick(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pitchDirectionMode, resolvePitchDirectionPick]);

  // Select-studs-to-double mode: Enter commits, Escape cancels.
  useEffect(() => {
    if (!doubleStudSelect) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDoubleStudSelect(null);
      } else if (event.key === "Enter") {
        setDoubleStudSelect((prev) => {
          if (!prev) return null;
          const measurement = overlayMeasurements.find((m) => m.id === prev.measurementId);
          if (measurement) {
            const wf = parseWallFraming(measurement.framing_json);
            void updateMeasurementFraming(prev.measurementId, serializeWallFraming({ ...wf, doubleAllStuds: undefined, doubledStuds: prev.pending.length > 0 ? prev.pending : undefined })).catch((e) => onStatusChange(`ERROR: ${e}`));
          }
          return null;
        });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doubleStudSelect, overlayMeasurements]);

  // Releasing Ctrl (or leaving select mode) clears the extra-stud ghost.
  useEffect(() => {
    if (!selectMode) {
      setStudGhost(null);
      return;
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Control") setStudGhost(null);
    }
    window.addEventListener("keyup", onKeyUp);
    return () => window.removeEventListener("keyup", onKeyUp);
  }, [selectMode]);

  // Shift held: temporarily disables snapping and ortho-lock for all measurement types.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Shift" && !shiftHeldRef.current) {
        shiftHeldRef.current = true;
        setShiftHeld(true);
        clearSnap();
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") {
        shiftHeldRef.current = false;
        setShiftHeld(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [clearSnap]);

  // Select-mode keyboard shortcuts.
  useEffect(() => {
    if (!selectMode) return;
    function onKeyDown(event: KeyboardEvent) {
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) return;
      // Esc cancels move or paste ghost mode.
      if (event.key === "Escape") {
        if (moveModeRef.current) { moveModeRef.current = null; setMoveMode(null); }
        if (pasteModeRef.current) { pasteModeRef.current = null; setPasteMode(null); }
        return;
      }
      // Delete / Backspace — remove all selected measurements.
      if ((event.key === "Delete" || event.key === "Backspace") && selectedMeasurementIds.length > 0) {
        event.preventDefault();
        void Promise.all(
          selectedMeasurementIds.map((id) => deleteMeasurement(id).catch((e) => onStatusChange(`ERROR: ${e}`))),
        );
        return;
      }
      // Ctrl+A — select all measurements on this page.
      if (event.ctrlKey && event.key === "a") {
        event.preventDefault();
        const pageIds = overlayMeasurements.filter((m) => m.page_index === pageIndex).map((m) => m.id);
        setSelectedMeasurementIds(pageIds);
        return;
      }
      // Ctrl+C — copy selected measurements.
      if (event.ctrlKey && event.key === "c" && selectedMeasurementIds.length > 0) {
        const selected = overlayMeasurements.filter((m) => selectedSet.has(m.id) && m.page_index === pageIndex);
        if (selected.length > 0) { setClipboard(selected); clipboardRef.current = selected; }
        return;
      }
      // Ctrl+V — enter paste ghost mode.
      if (event.ctrlKey && event.key === "v") {
        if (clipboardRef.current.length > 0) startPaste();
        return;
      }
      // Arrow keys while in paste ghost mode — flip the clipboard contents about their
      // centroid so the ghost preview mirrors left/right or up/down.
      if (pasteModeRef.current && (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "x" : "y";
        const centroid = measurementsCentroid(clipboardRef.current);
        const flipped = flipMeasurements(clipboardRef.current, centroid, axis);
        clipboardRef.current = flipped;
        setClipboard(flipped);
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // startPaste is defined in the component body (stable for this effect's lifetime).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectMode, selectedMeasurementIds, selectedSet, overlayMeasurements, pageIndex, deleteMeasurement, setSelectedMeasurementIds, onStatusChange]);

  // Live length readout near the cursor, for either a dimension being drawn or a
  // calibration line being placed. Shows real units once the page is scaled.
  const liveReadout = (() => {
    if (!cursorClient) return null;
    const livePoint = snapPoint ?? cursorPagePoint;
    if (calibrating && !calibDialog && calibPoints.length >= 1 && livePoint) {
      return formatLength(pathLengthPts([...calibPoints, livePoint]), pageScale);
    }
    if (measuring && draftPoints.length >= 1) {
      if (drawingArray) {
        const pts = livePoint && draftPoints.length < 2 ? [...draftPoints, livePoint] : draftPoints;
        if (pts.length < 2) return null;
        const baseLenM = pathLengthPts([pts[0], pts[1]]) * ((pageScale?.mm_per_point ?? 0) / 1000);
        const totalMembers = 1 + arrayExtraMembers;
        const totalM = totalMembers * baseLenM;
        return baseLenM > 0
          ? `${totalMembers} member${totalMembers !== 1 ? "s" : ""} · ${totalM.toFixed(3)} m`
          : null;
      }
      const pts = livePoint ? [...draftPoints, livePoint] : draftPoints;
      if (pts.length < 2) return null;
      if (drawingFraming) {
        const settings = parseFramingSettings(activeProps?.framing_props_json ?? null);
        const q = computeFramingQuantities(pts, settings, pageScale?.mm_per_point ?? null);
        return q ? `${q.studCount} studs · ${q.totalM.toFixed(2)} m` : formatLength(pathLengthPts(pts), pageScale);
      }
      const quantity = activeProps ? deriveQuantity(pts, pageScale?.mm_per_point ?? null, activeProps) : null;
      return quantity ? formatQuantity(quantity) : formatLength(pathLengthPts(pts), pageScale);
    }
    return null;
  })();

  // Pitch indicator's on-screen geometry, computed fresh every render from the current page/pan/
  // zoom — NOT cached from whenever the hover was detected. pan/zoom can change without a
  // mousemove event (scroll-to-zoom with the cursor stationary), so caching this in hoverInfo
  // state would leave the arrow's size/position stuck at whatever zoom level was active the last
  // time the mouse actually moved.
  const pitchIndicatorScreen = (() => {
    const ind = hoverInfo?.pitchIndicator;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!ind || !page || !rect) return null;

    // cx/cy are deliberately viewport-relative (no rect.left/top offset) — the wrapper div below
    // is itself positioned+sized to `rect` with overflow:hidden, so the indicator is clipped to
    // the canvas viewport and can never bleed into the side panels either side of it.
    const centreScreen = pageToScreen(ind.cxPt, ind.cyPt, page.height_pts, pan, zoom);
    const tipScreen = pageToScreen(
      ind.cxPt + Math.cos(ind.dirRad) * ind.halfDiagPts,
      ind.cyPt + Math.sin(ind.dirRad) * ind.halfDiagPts,
      page.height_pts,
      pan,
      zoom,
    );
    const screenAngleDeg = (Math.atan2(tipScreen.y - centreScreen.y, tipScreen.x - centreScreen.x) * 180) / Math.PI;
    const halfLengthPx = Math.max(12, Math.hypot(tipScreen.x - centreScreen.x, tipScreen.y - centreScreen.y));

    // Angle label offset perpendicular to the arrow (not just "up" in screen space) so it sits
    // beside the line instead of running through it when the arrow is vertical.
    const perpRad = ((screenAngleDeg - 90) * Math.PI) / 180;
    const labelDist = 14;

    return {
      rectLeft: rect.left,
      rectTop: rect.top,
      rectWidth: rect.width,
      rectHeight: rect.height,
      cx: centreScreen.x,
      cy: centreScreen.y,
      screenAngleDeg,
      halfLengthPx,
      pitchDeg: ind.pitchDeg,
      labelX: Math.cos(perpRad) * labelDist,
      labelY: Math.sin(perpRad) * labelDist,
    };
  })();

  return (
    <>
    <div
      ref={viewportRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onPointerLeave={() => {
        clearSnap();
        setHoverInfo(null);
        setStudGhost(null);
      }}
      style={{
        flex: 1,
        position: "relative",
        minHeight: 0,
        overflow: "hidden",
        cursor: doc
          ? measuring || calibrating || openingPlacement || arrayTrimMode || pitchDirectionMode
            ? "crosshair"
            : moveMode || pasteMode
              ? "crosshair"
              : selectMode
                ? hoverInfo
                  ? "pointer"
                  : "default"
                : dragRef.current
                  ? "grabbing"
                  : "grab"
          : "default",
        background: "var(--bg-canvas)",
        touchAction: "none",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block" }} />
      <canvas
        ref={overlayCanvasRef}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
        }}
      />
      {liveReadout && cursorClient ? (
        <div
          style={{
            position: "fixed",
            left: cursorClient.x + 14,
            top: cursorClient.y + 14,
            padding: "2px 6px",
            background: "rgba(20,22,26,0.9)",
            color: "#ffffff",
            border: "1px solid rgba(255,255,255,0.25)",
            borderRadius: 3,
            fontSize: 11,
            fontFamily: "Segoe UI, sans-serif",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          {liveReadout}
        </div>
      ) : null}
      {hoverInfo && !liveReadout ? (
        <div
          style={{
            position: "fixed",
            left: hoverInfo.x + 14,
            top: hoverInfo.y + 14,
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <MeasurementHoverCard data={hoverInfo} />
        </div>
      ) : null}
      {pitchIndicatorScreen && !liveReadout ? (
        <div
          style={{
            position: "fixed",
            left: pitchIndicatorScreen.rectLeft,
            top: pitchIndicatorScreen.rectTop,
            width: pitchIndicatorScreen.rectWidth,
            height: pitchIndicatorScreen.rectHeight,
            overflow: "hidden",
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          <svg style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible" }}>
            <g transform={`translate(${pitchIndicatorScreen.cx} ${pitchIndicatorScreen.cy})`}>
              <g transform={`rotate(${pitchIndicatorScreen.screenAngleDeg})`}>
                <line
                  x1={-pitchIndicatorScreen.halfLengthPx}
                  y1={0}
                  x2={pitchIndicatorScreen.halfLengthPx}
                  y2={0}
                  stroke="#00E676"
                  strokeWidth={2.5}
                />
                {[-1, 1].map((side) => (
                  <polygon
                    key={side}
                    fill="#00E676"
                    points={`${side * pitchIndicatorScreen.halfLengthPx},0 ${side * (pitchIndicatorScreen.halfLengthPx - 10)},-5 ${side * (pitchIndicatorScreen.halfLengthPx - 10)},5`}
                  />
                ))}
              </g>
              {/* Not nested inside the rotated group, so the label always reads horizontally.
                  Offset perpendicular to the arrow (not just "up" in screen space) so it sits
                  beside the line instead of running through it when the arrow is vertical. */}
              <text
                x={pitchIndicatorScreen.labelX}
                y={pitchIndicatorScreen.labelY}
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#00E676"
                fontSize={14}
                fontWeight={700}
                fontFamily="Arial, sans-serif"
              >
                {`${pitchIndicatorScreen.pitchDeg}°`}
              </text>
            </g>
          </svg>
        </div>
      ) : null}
      {doubleStudSelect ? (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            padding: "6px 16px",
            background: "rgba(20,22,26,0.92)",
            color: "#FFD700",
            border: "1px solid #FFD700",
            borderRadius: 4,
            fontSize: 12,
            fontFamily: "Segoe UI, sans-serif",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          Click studs to toggle doubled — Enter to confirm · Esc to cancel ({doubleStudSelect.pending.length} selected)
        </div>
      ) : null}
      {calibDialog ? (
        <CalibrationDialog
          pixelLength={calibDialog.pixelLength}
          onCancel={() => {
            setCalibDialog(null);
            applyCalib([]);
            setCalibrating(false);
          }}
          onConfirm={(realMm, unit) => {
            if (activeDrawingId === null) return;
            const mmPerPoint = realMm / calibDialog.pixelLength;
            void setPageScale(activeDrawingId, pageIndex, mmPerPoint, unit)
              .then(() => {
                setCalibDialog(null);
                applyCalib([]);
              })
              .catch((error) => onStatusChange(`ERROR: ${error}`));
          }}
        />
      ) : null}
    </div>
    {/* Rendered as a sibling (not a child) of the viewport so its synthetic pointer
        events don't bubble through the React tree into the viewport's pan handler. */}
    {viewerMenu ? (
      <ContextMenu x={viewerMenu.x} y={viewerMenu.y} items={viewerMenu.items} onClose={() => setViewerMenu(null)} />
    ) : null}
    {pendingOpeningEdit ? (
      <OpeningDialog
        title={pendingOpeningEdit.template.kind === "window" ? "Window options" : "Door options"}
        initial={pendingOpeningEdit.template}
        confirmLabel={pendingOpeningEdit.template.kind === "window" ? "Update Window" : "Update Door"}
        onCancel={() => setPendingOpeningEdit(null)}
        onConfirm={(template) => {
          updateOpening(pendingOpeningEdit.measurementId, pendingOpeningEdit.index, template);
          setPendingOpeningEdit(null);
        }}
      />
    ) : null}
    {pendingRake ? (
      <RakingDialog
        initialStart={pendingRake.start}
        initialEnd={pendingRake.end}
        initialMiddle={pendingRake.middle}
        initialMiddlePosition={pendingRake.middlePosition}
        initialGable={pendingRake.gable}
        segLenMm={pendingRake.segLenMm}
        onCancel={() => setPendingRake(null)}
        onConfirm={(startMm, endMm, gable, middleMm, middlePositionMm) => {
          setRake(pendingRake.measurementId, pendingRake.segmentIndex, startMm, endMm, gable, middleMm, middlePositionMm);
          setPendingRake(null);
        }}
      />
    ) : null}
    {wall3dId !== null ? (
      <div style={{ position: "fixed", inset: 0, zIndex: 1300, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.55)" }} onClick={() => setWall3dId(null)}>
        <div onClick={(e) => e.stopPropagation()} style={{ width: "82vw", height: "82vh", background: "#dfe4ea", border: "1px solid var(--border-divider)", boxShadow: "0 18px 48px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ height: 34, display: "flex", alignItems: "center", padding: "0 12px", background: "var(--bg-ribbon)", color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
            View in 3D
            <button onClick={() => setWall3dId(null)} style={{ marginLeft: "auto", width: 24, height: 24, background: "transparent", color: "var(--text-primary)", border: "none", cursor: "pointer", fontSize: 16 }}>×</button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {(() => {
              const m = overlayMeasurements.find((x) => x.id === wall3dId);
              let pts: PagePoint[] | null = null;
              try {
                pts = m ? JSON.parse(m.geometry_json) : null;
              } catch {
                pts = null;
              }
              if (!m || !Array.isArray(pts) || pts.length < 1) return null;
              const props = groupProps[m.dimension_group_id];
              const mmpp = pageScale?.mm_per_point ?? null;
              const offsetM = props?.default_offset ?? 0;
              const negative = (m.polarity ?? 1) < 0;
              const color = negative ? props?.neg_colour ?? "#FF0000" : props?.pos_colour ?? "#4A9EFF";
              let members: Member3D[] = [];
              let areas: AreaMesh3D[] = [];
              if (m.measurement_type === "timber_framing" && pts.length >= 2) {
                const settings = parseFramingSettings(props?.framing_props_json ?? null);
                members = offsetMembers(computeWall3D(pts, settings, mmpp, parseWallFraming(m.framing_json)), offsetM);
              } else if (m.measurement_type === "count") {
                const marker = computeCountMarker3D(pts[0], mmpp, {
                  widthM: props?.default_width ?? 0,
                  heightM: props?.default_height ?? 0,
                  countType: props?.count_type ?? "marker",
                  offsetM,
                  color,
                });
                if (marker) members = [marker];
              } else if (m.measurement_type === "area" && pts.length >= 3) {
                const mesh = computeAreaMesh3D(pts, mmpp, { heightM: props?.default_height ?? 0, offsetM, color });
                if (mesh) areas = [mesh];
              } else if (m.measurement_type === "array" && pts.length >= 2) {
                const meta = parseArrayMeta(m.framing_json ?? null);
                const joistRafter = parseJoistRafterSettings(props?.framing_props_json ?? null);
                members = computeArrayMembers3D(pts, mmpp, meta, joistRafter.framingSize, {
                  offsetM,
                  color,
                  pitchAngleDeg: props?.pitch_angle_deg ?? 0,
                });
              } else if (m.measurement_type === "length" && pts.length >= 2) {
                members = computeLengthMembers3D(pts, mmpp, {
                  widthM: props?.default_width ?? 0,
                  heightM: props?.default_height ?? 0,
                  offsetM,
                  color,
                  display: props?.default_display ?? "length",
                });
              }
              const page3d = doc?.pages[m.page_index] ?? null;
              const S = mmpp ? mmpp / 1000 : null;
              const pageWidthM = S && page3d ? page3d.width_pts * S : undefined;
              const pageHeightM = S && page3d ? page3d.height_pts * S : undefined;
              // Use the current page's preview; fall back through all loaded previews for this page.
              const previewEntry = preview?.image_path
                ? preview
                : (previews.get(m.page_index) ?? null);
              const previewUrl = previewEntry?.image_path
                ? convertFileSrc(previewEntry.image_path)
                : undefined;
              return <Framing3DView members={members} areas={areas} pageWidthM={pageWidthM} pageHeightM={pageHeightM} previewUrl={previewUrl} />;
            })()}
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
