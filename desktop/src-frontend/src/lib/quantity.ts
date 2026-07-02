// CostX-style quantity derivation. Geometry is in PDF points; scale (mm per point)
// converts to real-world metres. Width/height come from the dimension group and are
// in metres. See docs/phase3-plan.md for the derivation matrix.

export interface GroupProps {
  node_id: number;
  measurement_type: string; // count | length | area  (how it's drawn)
  default_display: string; // count | length | area | wall_area | volume | weight
  default_multiplier: number;
  default_width: number; // metres
  default_height: number; // metres
  default_offset: number; // metres (Z datum; no 2D effect)
  add_to_gfa: boolean;
  pos_colour: string;
  pos_style: string;
  neg_colour: string;
  neg_style: string;
  weight_uom: string | null;
  // Timber-framing settings (framing size, stud spacing, plate config, wall height, dwang
  // centres) as a JSON blob; null for non-framing groups. Parsed via lib/framing.ts.
  framing_props_json: string | null;
  // "marker" | "custom" — only meaningful when measurement_type === "count". "custom" renders
  // a rectangle sized by default_width/default_height instead of the ringed-cross marker.
  count_type: string;
}

export interface PagePoint {
  x: number;
  y: number;
}

export interface Quantity {
  value: number;
  uom: string;
}

export function polylineLengthPts(points: PagePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Closed-polygon perimeter (includes the closing edge back to the first point). */
export function polygonPerimeterPts(points: PagePoint[]): number {
  if (points.length < 2) return 0;
  return polylineLengthPts(points) + Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
}

/** Absolute polygon area via the shoelace formula (PDF points²). */
export function polygonAreaPts(points: PagePoint[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Parsed array metadata from framing_json for an array-type measurement. */
export interface ArrayMeta {
  extraMembers: number;
  spacingPts: number;
  direction: number;
  trims: ArrayTrim[];
}

/** A straight cut line: members are clipped to the half-plane containing (keepX, keepY). */
export interface LineTrim {
  kind?: "line"; // absent = "line", for backward compatibility with trims saved before box trim existed
  x1: number; y1: number;
  x2: number; y2: number;
  keepX: number; keepY: number;
}

/** A closed polygon: members are clipped to whichever side (inside/outside) contains (keepX, keepY). */
export interface BoxTrim {
  kind: "box";
  points: PagePoint[];
  keepX: number; keepY: number;
}

export type ArrayTrim = LineTrim | BoxTrim;

export function parseArrayMeta(json: string | null): ArrayMeta {
  const defaults: ArrayMeta = { extraMembers: 0, spacingPts: 0, direction: 1, trims: [] };
  if (!json) return defaults;
  try {
    const parsed = JSON.parse(json);
    if (parsed?.type !== "array") return defaults;
    return {
      extraMembers: typeof parsed.extraMembers === "number" ? parsed.extraMembers : 0,
      spacingPts: typeof parsed.spacingPts === "number" ? parsed.spacingPts : 0,
      direction: parsed.direction === -1 ? -1 : 1,
      trims: Array.isArray(parsed.trims) ? parsed.trims : [],
    };
  } catch {
    return defaults;
  }
}

export function serializeArrayMeta(meta: ArrayMeta): string {
  return JSON.stringify({ type: "array", ...meta });
}

// --- Array trim geometry helpers (mirrors ViewerCanvas but needed for quantity derivation) ---

function _sideOfLine(px: number, py: number, lx1: number, ly1: number, lx2: number, ly2: number): number {
  return (lx2 - lx1) * (py - ly1) - (ly2 - ly1) * (px - lx1);
}

/** Even-odd point-in-polygon test. */
function _pointInPolygon(pt: PagePoint, poly: PagePoint[]): boolean {
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
function _segmentPolygonCrossings(seg: [PagePoint, PagePoint], poly: PagePoint[]): number[] {
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
function _clipSegmentToBox(seg: [PagePoint, PagePoint], trim: BoxTrim): [PagePoint, PagePoint][] {
  const poly = trim.points;
  if (poly.length < 3) return [seg];
  const keepInside = _pointInPolygon({ x: trim.keepX, y: trim.keepY }, poly);
  const [a, b] = seg;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx * dx + dy * dy < 1e-12) {
    return _pointInPolygon(a, poly) === keepInside ? [seg] : [];
  }
  const ts = _segmentPolygonCrossings(seg, poly).sort((x, y) => x - y);
  const breakpoints = [0, ...ts, 1];
  const result: [PagePoint, PagePoint][] = [];
  for (let i = 0; i < breakpoints.length - 1; i += 1) {
    const t0 = breakpoints[i];
    const t1 = breakpoints[i + 1];
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    const inside = _pointInPolygon({ x: a.x + dx * tm, y: a.y + dy * tm }, poly);
    if (inside === keepInside) {
      result.push([
        { x: a.x + dx * t0, y: a.y + dy * t0 },
        { x: a.x + dx * t1, y: a.y + dy * t1 },
      ]);
    }
  }
  return result;
}

/** Clip a segment to the half-plane (line trim) or inside/outside (box trim). May yield 0..n pieces. */
function _clipSegmentToTrim(seg: [PagePoint, PagePoint], trim: ArrayTrim): [PagePoint, PagePoint][] {
  if (trim.kind === "box") return _clipSegmentToBox(seg, trim);
  const { x1, y1, x2, y2, keepX, keepY } = trim;
  // Negate to match the sign convention in clipSegmentToSide (ViewerCanvas).
  const keepSign = -Math.sign(_sideOfLine(keepX, keepY, x1, y1, x2, y2));
  if (keepSign === 0) return [seg];
  const dA = _sideOfLine(seg[0].x, seg[0].y, x1, y1, x2, y2);
  const dB = _sideOfLine(seg[1].x, seg[1].y, x1, y1, x2, y2);
  const aKept = Math.sign(dA) === 0 || Math.sign(dA) === keepSign;
  const bKept = Math.sign(dB) === 0 || Math.sign(dB) === keepSign;
  if (aKept && bKept) return [seg];
  if (!aKept && !bKept) return [];
  const denom = dA - dB;
  if (Math.abs(denom) < 1e-12) return aKept ? [seg] : [];
  const t = Math.max(0, Math.min(1, dA / denom));
  const ix = seg[0].x + t * (seg[1].x - seg[0].x);
  const iy = seg[0].y + t * (seg[1].y - seg[0].y);

  // Only clip if the crossing point falls within the drawn trim segment's extent.
  const trimDx = x2 - x1;
  const trimDy = y2 - y1;
  const trimLenSq = trimDx * trimDx + trimDy * trimDy;
  if (trimLenSq > 1e-12) {
    const tTrim = ((ix - x1) * trimDx + (iy - y1) * trimDy) / trimLenSq;
    if (tTrim < 0 || tTrim > 1) return [seg];
  }

  return aKept ? [[seg[0], { x: ix, y: iy }]] : [[{ x: ix, y: iy }, seg[1]]];
}

/** Apply all trims sequentially. Each trim may split a segment into multiple pieces. */
function _applyTrims(seg: [PagePoint, PagePoint], trims: ArrayTrim[]): [PagePoint, PagePoint][] {
  let segments: [PagePoint, PagePoint][] = [seg];
  for (const trim of trims) {
    const next: [PagePoint, PagePoint][] = [];
    for (const s of segments) next.push(..._clipSegmentToTrim(s, trim));
    segments = next;
    if (segments.length === 0) return [];
  }
  return segments;
}

/** Convert relative-stored trims to absolute page coords by adding the baseline origin. */
function _absTrims(trims: ArrayTrim[], origin: PagePoint): ArrayTrim[] {
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

/** Total post-trim length of all array members in PDF points. */
function arrayTrimmedLengthPts(p1: PagePoint, p2: PagePoint, meta: ArrayMeta): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const perpX = -dy / len;
  const perpY = dx / len;
  // Convert relative trims to absolute using p1 as origin.
  const absTrimsList = _absTrims(meta.trims, p1);
  let total = 0;
  for (let i = 0; i <= meta.extraMembers; i++) {
    const off = i * meta.spacingPts * meta.direction;
    const seg: [PagePoint, PagePoint] = [
      { x: p1.x + perpX * off, y: p1.y + perpY * off },
      { x: p2.x + perpX * off, y: p2.y + perpY * off },
    ];
    const clipped = _applyTrims(seg, absTrimsList);
    for (const c of clipped) total += Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);
  }
  return total;
}

/**
 * Derives the display quantity (magnitude, unsigned) for one dimension's geometry.
 * Returns null when it can't be computed (no scale, or the deferred weight display).
 * For array-type measurements, pass `framingJson` containing the array metadata.
 */
export function deriveQuantity(points: PagePoint[], mmPerPoint: number | null, props: GroupProps, framingJson?: string | null): Quantity | null {
  if (points.length < 1) return null;
  // Array + Count: total number of members in the array (including extras), times the multiplier.
  if (props.measurement_type === "array" && props.default_display === "count") {
    const meta = parseArrayMeta(framingJson ?? null);
    return { value: (1 + meta.extraMembers) * props.default_multiplier, uom: "no" };
  }
  // Count needs no scale or geometry beyond a single point — each marker counts as the multiplier.
  if (props.default_display === "count") return { value: props.default_multiplier, uom: "no" };
  if (points.length < 2 || mmPerPoint == null || !(mmPerPoint > 0)) return null;

  // Array: sum post-trim length of all members.
  if (props.measurement_type === "array") {
    const meta = parseArrayMeta(framingJson ?? null);
    const totalPts = arrayTrimmedLengthPts(points[0], points[1], meta);
    return { value: totalPts * (mmPerPoint / 1000) * props.default_multiplier, uom: "m" };
  }

  const mPerPt = mmPerPoint / 1000;
  const m = props.default_multiplier;
  const w = props.default_width;
  const h = props.default_height;
  const isAreaMeasure = props.measurement_type === "area";

  const lengthM = polylineLengthPts(points) * mPerPt;
  const perimeterM = polygonPerimeterPts(points) * mPerPt;
  const areaM2 = polygonAreaPts(points) * mPerPt * mPerPt;
  // Linear extent of the boundary: the run for a line, the perimeter for an area.
  const boundaryM = isAreaMeasure ? perimeterM : lengthM;

  switch (props.default_display) {
    case "count":
      return { value: m, uom: "" };
    case "length":
      return { value: boundaryM * m, uom: "m" };
    case "perimeter":
      return { value: perimeterM * m, uom: "m" };
    case "area":
      return { value: (isAreaMeasure ? areaM2 : lengthM * w) * m, uom: "m²" };
    case "wall_area":
      return { value: boundaryM * h * m, uom: "m²" };
    case "volume":
      return { value: (isAreaMeasure ? areaM2 * h : lengthM * w * h) * m, uom: "m³" };
    case "weight":
      return null; // deferred — no density/rate model yet
    default:
      return null;
  }
}

const UOM_PRECISION: Record<string, number> = { "": 0, no: 0, m: 3, "m²": 2, "m³": 2 };

/** The numeric part only (no unit), at the unit-appropriate precision. */
export function quantityValueText(quantity: Quantity): string {
  const precision = UOM_PRECISION[quantity.uom] ?? 2;
  return quantity.value.toFixed(precision);
}

export function formatQuantity(quantity: Quantity | null): string {
  if (!quantity) return "—";
  return quantity.uom ? `${quantityValueText(quantity)} ${quantity.uom}` : quantityValueText(quantity);
}

interface MeasurementLike {
  geometry_json: string;
  polarity: number;
  drawing_id: number;
  page_index: number;
  framing_json?: string | null;
}

/** Net quantity for a group: Σ(positive) − Σ(negative), via polarity-signed sum. */
export function groupNetQuantity(
  measurements: MeasurementLike[],
  props: GroupProps,
  scaleFor: (drawingId: number, pageIndex: number) => number | null,
): Quantity | null {
  let total = 0;
  let uom = "";
  let computed = false;
  for (const measurement of measurements) {
    let points: PagePoint[];
    try {
      points = JSON.parse(measurement.geometry_json);
    } catch {
      continue;
    }
    if (!Array.isArray(points)) continue;
    const quantity = deriveQuantity(points, scaleFor(measurement.drawing_id, measurement.page_index), props, measurement.framing_json);
    if (!quantity) continue;
    total += (measurement.polarity ?? 1) * quantity.value;
    uom = quantity.uom;
    computed = true;
  }
  return computed ? { value: total, uom } : null;
}
