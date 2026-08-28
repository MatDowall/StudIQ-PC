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
  // Slope angle in degrees (0 = flat/no correction) applied to Area/Length quantities. Area
  // totals are direction-independent (plan_area / cos θ); perimeter/boundary edges are not, so
  // they also need pitch_direction_deg. See quantity.ts's pitched-length helpers.
  pitch_angle_deg: number;
  // Pitch (slope) direction in page space: 0 = along +X, 90 = along +Y. Only ever set via the
  // on-canvas axis-locked pick gesture — always exactly 0 or 90.
  pitch_direction_deg: number;
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

// Single source of truth for measurement-type -> icon/label, shared by the dimension-group
// tree (DimensionGroupPane) and the canvas hover card (MeasurementHoverCard). See the
// "Established icon assignments" table in CLAUDE.md before changing these.
export const MEASUREMENT_TYPE_ICONS: Record<string, string> = {
  timber_framing: "calendar_view_week",
  area: "activity_zone",
  count: "tag",
  length: "diagonal_line",
  array: "texture",
  wall_surface: "add_column_left",
  wall_insulation: "heat",
};

export const MEASUREMENT_TYPE_LABELS: Record<string, string> = {
  timber_framing: "Timber Framing",
  area: "Area",
  count: "Count",
  length: "Length",
  array: "Joist / Rafter",
  wall_surface: "Wall Surface from Framing",
  wall_insulation: "Wall Insulation from Framing",
};

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

/**
 * True (sloped) length of a single edge under a mono-pitch: the edge's own component along the
 * pitch direction is stretched by 1/cos(pitchRad), while its component perpendicular to the
 * pitch direction (running level, across the slope) is unchanged. Reduces to `hypot(dx,dy)` when
 * pitchRad is 0, to `L/cos(pitchRad)` when the edge runs parallel to the pitch direction, and to
 * `L` unchanged when the edge runs perpendicular to it.
 */
export function pitchedSegmentLengthPts(dx: number, dy: number, pitchRad: number, dirRad: number): number {
  if (pitchRad === 0) return Math.hypot(dx, dy);
  const along = dx * Math.cos(dirRad) + dy * Math.sin(dirRad);
  const straightLen = Math.hypot(dx, dy);
  return Math.sqrt(straightLen * straightLen + along * along * Math.tan(pitchRad) ** 2);
}

/** Pitched open-path length: sums `pitchedSegmentLengthPts` over consecutive points. */
export function pitchedPolylineLengthPts(points: PagePoint[], pitchRad: number, dirRad: number): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += pitchedSegmentLengthPts(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, pitchRad, dirRad);
  }
  return total;
}

/** Pitched closed-polygon perimeter: `pitchedPolylineLengthPts` plus the closing edge. */
export function pitchedPolygonPerimeterPts(points: PagePoint[], pitchRad: number, dirRad: number): number {
  if (points.length < 2) return 0;
  const closing = pitchedSegmentLengthPts(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y, pitchRad, dirRad);
  return pitchedPolylineLengthPts(points, pitchRad, dirRad) + closing;
}

// ---------------------------------------------------------------------------------------------
// Per-measurement pitch axis
//
// A group's `pitch_angle_deg`/`pitch_direction_deg` describe one mono-pitch for every measurement
// in it, hinged nowhere in particular. That is not enough for a roof: two planes of the same
// group fall different ways, and which way a plane tips only reads correctly in 3D once you say
// what it pivots ABOUT. So a measurement may carry its own `PitchAxis`, which supersedes the
// group's angle and direction and adds the pivot the group props have no room for.
//
// It rides in the measurement's `framing_json` under the `pitch` key rather than in a column of
// its own: that blob is already the frontend-owned per-measurement extras bag (wall framing,
// array meta, wall-surface snapshots), every command and copy/paste/export path carries it
// unchanged, and `deriveQuantity` is already handed it at every call site — so the override
// reaches the quantities with no plumbing and no migration. `withPitchAxis` merges rather than
// replaces, so an array's meta and its axis can coexist in the one blob.
// ---------------------------------------------------------------------------------------------

/** One measurement's own pitch plane. */
export interface PitchAxis {
  /** Slope from horizontal, degrees. Signed: the surface rises along `directionDeg` when
   *  positive and falls along it when negative, so a plane can be tipped either way about the
   *  same pivot without spinning the direction 180°. */
  angleDeg: number;
  /** The uphill direction — the compass bearing the surface RISES towards — in degrees CCW from
   *  page +X, in the same Y-up page space as `geometry_json`. Accepts anything in [-360, 360];
   *  the group's `pitch_direction_deg` (0 = along X, 90 = along Y) is the same convention, so a
   *  group default reads straight across into it. */
  directionDeg: number;
  /** The pivot, in PDF points: the plane passes through this point at the group's Z datum, and
   *  the surface rises on its uphill side and drops below the datum on the other. Picked on the
   *  measure itself — a vertex, or an edge midpoint when hinging on an edge. */
  originX: number;
  originY: number;
}

/** Clamp to a sane, storable axis. Angle is capped just short of vertical (tan blows up at 90°);
 *  direction is left anywhere in [-360, 360] since that is the range the estimator types into. */
export function normalizePitchAxis(axis: PitchAxis): PitchAxis {
  const angle = Number.isFinite(axis.angleDeg) ? Math.max(-89.9, Math.min(89.9, axis.angleDeg)) : 0;
  const dir = Number.isFinite(axis.directionDeg) ? Math.max(-360, Math.min(360, axis.directionDeg)) : 0;
  return {
    angleDeg: angle,
    directionDeg: dir,
    originX: Number.isFinite(axis.originX) ? axis.originX : 0,
    originY: Number.isFinite(axis.originY) ? axis.originY : 0,
  };
}

/** Reads a measurement's own pitch axis out of its `framing_json`; null when it has none (which
 *  is the normal case — the measure then follows its group's pitch). */
export function parsePitchAxis(framingJson: string | null | undefined): PitchAxis | null {
  if (!framingJson) return null;
  try {
    const raw = JSON.parse(framingJson);
    const pitch = raw && typeof raw === "object" ? (raw as Record<string, unknown>).pitch : null;
    if (!pitch || typeof pitch !== "object") return null;
    const p = pitch as Record<string, unknown>;
    if (typeof p.originX !== "number" || typeof p.originY !== "number") return null;
    return normalizePitchAxis({
      angleDeg: typeof p.angleDeg === "number" ? p.angleDeg : 0,
      directionDeg: typeof p.directionDeg === "number" ? p.directionDeg : 0,
      originX: p.originX,
      originY: p.originY,
    });
  } catch {
    return null;
  }
}

/** Writes (or with `null`, removes) the pitch axis in a measurement's `framing_json`, preserving
 *  whatever else that blob holds. Returns null when the result would be an empty object, so a
 *  measure that never had framing extras goes back to a null column. */
export function withPitchAxis(framingJson: string | null | undefined, axis: PitchAxis | null): string | null {
  let base: Record<string, unknown> = {};
  if (framingJson) {
    try {
      const raw = JSON.parse(framingJson);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) base = raw as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  if (axis) base.pitch = normalizePitchAxis(axis);
  else delete base.pitch;
  return Object.keys(base).length > 0 ? JSON.stringify(base) : null;
}

/**
 * Carries a measurement's pitch axis through a transform of its geometry. The pivot is an
 * ABSOLUTE page point, so — unlike an array's trims, which are stored relative to `points[0]` and
 * follow the geometry for free — it does NOT move with the shape on its own. Left behind, it turns
 * a translation into height: a plane pitched 45° that is moved 3 m from its pivot now floats 3 m
 * up, which swamps whatever Z offset its group is set to.
 *
 * **Anything that moves, copies, flips or rotates a measurement must put its geometry through
 * this.** `mapPoint` moves the pivot the same way the vertices moved; `mapDirectionDeg` turns the
 * uphill bearing (identity for a translation, `180 - d` for an x-mirror, `-d` for a y-mirror,
 * `d ± 90` for a quarter turn). The result is wrapped into (-180, 180] so repeated transforms
 * can't walk the stored direction out of range — half turns settle on +180 rather than -180,
 * which is the same bearing but the one an estimator expects to read. A measurement with no axis
 * passes through untouched.
 */
export function transformPitchAxisJson(
  framingJson: string | null | undefined,
  mapPoint: (p: PagePoint) => PagePoint,
  mapDirectionDeg: (deg: number) => number = (deg) => deg,
): string | null {
  const axis = parsePitchAxis(framingJson);
  if (!axis) return framingJson ?? null;
  const origin = mapPoint({ x: axis.originX, y: axis.originY });
  const raw = mapDirectionDeg(axis.directionDeg);
  const halfOpen = ((((raw + 180) % 360) + 360) % 360) - 180;
  const wrapped = halfOpen === -180 ? 180 : halfOpen;
  return withPitchAxis(framingJson, { ...axis, originX: origin.x, originY: origin.y, directionDeg: wrapped });
}

/** The pitch a measurement actually renders and derives at: its own axis when it has one, else
 *  the group's angle/direction with no pivot (which hinges on the shape's own low edge). The one
 *  place the override rule lives, so quantities, the 2D indicator and the 3D mesh can't drift. */
export function resolvePitch(
  framingJson: string | null | undefined,
  groupAngleDeg: number | null | undefined,
  groupDirectionDeg: number | null | undefined,
): { angleDeg: number; directionDeg: number; origin: PagePoint | null } {
  const axis = parsePitchAxis(framingJson);
  if (axis) return { angleDeg: axis.angleDeg, directionDeg: axis.directionDeg, origin: { x: axis.originX, y: axis.originY } };
  return { angleDeg: groupAngleDeg ?? 0, directionDeg: groupDirectionDeg ?? 0, origin: null };
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

/** Apply all trims sequentially. Each trim may split a segment into multiple pieces. Exported for
 *  reuse by the 3D array-member builder (lib/framing3d.ts), which needs the same trimmed member
 *  set as the 2D render/quantity paths so 2D, 3D, and quantities never disagree. */
export function applyArrayTrims(seg: [PagePoint, PagePoint], trims: ArrayTrim[]): [PagePoint, PagePoint][] {
  let segments: [PagePoint, PagePoint][] = [seg];
  for (const trim of trims) {
    const next: [PagePoint, PagePoint][] = [];
    for (const s of segments) next.push(..._clipSegmentToTrim(s, trim));
    segments = next;
    if (segments.length === 0) return [];
  }
  return segments;
}

/** Convert relative-stored trims to absolute page coords by adding the baseline origin. Exported
 *  alongside `applyArrayTrims` for the 3D array-member builder. */
export function absArrayTrims(trims: ArrayTrim[], origin: PagePoint): ArrayTrim[] {
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

/** Total post-trim length of all array members in PDF points. Exported so the Joist/Rafter group
 *  aggregation (lib/framing.ts) derives the member run through exactly this code path rather than
 *  re-deriving it — blocking is added on top of it, so the two must never drift. */
export function arrayTrimmedLengthPts(p1: PagePoint, p2: PagePoint, meta: ArrayMeta): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 0;
  const perpX = -dy / len;
  const perpY = dx / len;
  // Convert relative trims to absolute using p1 as origin.
  const absTrimsList = absArrayTrims(meta.trims, p1);
  let total = 0;
  for (let i = 0; i <= meta.extraMembers; i++) {
    const off = i * meta.spacingPts * meta.direction;
    const seg: [PagePoint, PagePoint] = [
      { x: p1.x + perpX * off, y: p1.y + perpY * off },
      { x: p2.x + perpX * off, y: p2.y + perpY * off },
    ];
    const clipped = applyArrayTrims(seg, absTrimsList);
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
  // Wall Surface: the face is fully described by its own snapshot blob (face lengths, rake
  // heights, opening holes — all in mm), so it needs neither the page scale nor the centre-line
  // geometry, and it always displays as an area.
  if (isWallSurfaceType(props.measurement_type)) {
    const meta = parseWallSurfaceMeta(framingJson ?? null);
    if (meta.segments.length === 0) return null;
    const value = wallSurfaceMeasureM2(meta, props) * props.default_multiplier;
    return { value, uom: "m²" };
  }
  // Array + Count: total number of members in the array (including extras), times the multiplier.
  if (props.measurement_type === "array" && props.default_display === "count") {
    const meta = parseArrayMeta(framingJson ?? null);
    return { value: (1 + meta.extraMembers) * props.default_multiplier, uom: "no" };
  }
  // Count needs no scale or geometry beyond a single point — each marker counts as the multiplier.
  if (props.default_display === "count") return { value: props.default_multiplier, uom: "no" };
  if (points.length < 2 || mmPerPoint == null || !(mmPerPoint > 0)) return null;

  // Array: sum post-trim length of all members. Pitch (if set) is a flat 1/cos(angle) scale with
  // no direction dependency — an array run is drawn directly along the slope, same as a single
  // 2-point Length segment, so there's no ambiguity to resolve with a direction.
  if (props.measurement_type === "array") {
    const meta = parseArrayMeta(framingJson ?? null);
    const totalPts = arrayTrimmedLengthPts(points[0], points[1], meta);
    const pitchRad = ((props.pitch_angle_deg ?? 0) * Math.PI) / 180;
    const pitchScale = pitchRad !== 0 ? 1 / Math.cos(pitchRad) : 1;
    return { value: totalPts * (mmPerPoint / 1000) * props.default_multiplier * pitchScale, uom: "m" };
  }

  const mPerPt = mmPerPoint / 1000;
  const m = props.default_multiplier;
  const w = props.default_width;
  const h = props.default_height;
  const isAreaMeasure = props.measurement_type === "area";

  // A measurement carrying its own pitch axis supersedes the group's angle and direction (the
  // pivot doesn't enter here — a mono-pitch's area and edge lengths don't depend on where the
  // plane is hinged, only on how steeply and which way it tips).
  const pitch = resolvePitch(framingJson ?? null, props.pitch_angle_deg, props.pitch_direction_deg);
  const pitchRad = (pitch.angleDeg * Math.PI) / 180;
  const dirRad = (pitch.directionDeg * Math.PI) / 180;
  const hasPitch = pitchRad !== 0;

  // Length-type groups: a single 2-point segment is drawn directly along the rake, so it's a flat
  // 1/cos(pitchRad) scale with no direction dependency; a multi-segment polyline (e.g. a fascia
  // line bending around a hip) needs the same per-edge directional correction as an area's
  // perimeter, since its segments run at different angles to the pitch direction.
  const lengthM =
    (hasPitch
      ? points.length === 2
        ? polylineLengthPts(points) / Math.cos(pitchRad)
        : pitchedPolylineLengthPts(points, pitchRad, dirRad)
      : polylineLengthPts(points)) * mPerPt;
  const perimeterM = (hasPitch ? pitchedPolygonPerimeterPts(points, pitchRad, dirRad) : polygonPerimeterPts(points)) * mPerPt;
  // Area total is direction-independent for a mono-pitch: true_area = plan_area / cos(pitchRad).
  const areaM2 = (hasPitch ? polygonAreaPts(points) / Math.cos(pitchRad) : polygonAreaPts(points)) * mPerPt * mPerPt;
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

// ---------------------------------------------------------------------------------------------
// Wall Surface from Framing — a lining/insulation measure taken off an existing timber-framing
// wall's face rather than re-measured. See CLAUDE.md.
//
// The measurement stores the source wall's centre-line in `geometry_json` (so it lives on the same
// page, hit-tests and renders through the usual path) and a fully self-contained snapshot of the
// *face* in `framing_json`. The snapshot is deliberately pure numbers — face lengths, heights,
// opening sizes — so the area derives here without importing lib/framing.ts (which would be a
// cycle: framing.ts already imports this module) and without a page scale, and so every consumer
// (sidebar totals, workbook, Excel bridge) gets the same number with nothing extra loaded.
// It is refreshed from the live framing whenever the group is opened on the source page.
// ---------------------------------------------------------------------------------------------

/** One opening's hole in the lining, positioned along its face segment. Heights are above FFL. */
/** The two measurement types that take a measure off existing timber framing. They share the
 *  whole snapshot model and the read-only framing interaction; they differ in what they count —
 *  a lining covers the wall face, insulation fills the voids between the framing — and in how the
 *  wall is picked (a lining per face, insulation per wall). */
export const WALL_SURFACE_TYPE = "wall_surface";
export const WALL_INSULATION_TYPE = "wall_insulation";

/** True for either of the framing-derived surface types. */
export function isWallSurfaceType(measurementType: string): boolean {
  return measurementType === WALL_SURFACE_TYPE || measurementType === WALL_INSULATION_TYPE;
}

/** True only for the insulation type — the pockets measure. */
export function isWallInsulationType(measurementType: string): boolean {
  return measurementType === WALL_INSULATION_TYPE;
}

export interface WallSurfaceOpening {
  segmentIndex: number;
  /** Centre along the FACE line — what a lining panel is set out on. */
  centreMm: number;
  /** Centre along the wall's CENTRE line — what the frame, and so the pockets, are set out on.
   *  Differs from `centreMm` only on a segment whose face is mitred at a corner. */
  frameCentreMm: number;
  widthMm: number;
  headMm: number;
  sillMm: number;
}

/** One wall segment's measured span: its length and the top-plate height profile over it.
 *  `apexHeightMm` + `apexFrac` are only set for a gable rake (height rises to the apex, then
 *  falls), and `apexFrac` is relative to the span, not the whole segment.
 *
 *  A surface covering the whole wall has `faceStartMm`/`frameStartMm` of 0 and spans the full
 *  segment; a partial surface (drag-drawn along the wall) starts partway in. The face and frame
 *  figures are both carried because a lining is set out on the mitred face line while insulation
 *  pockets are set out on the centre line — see the measure-type notes in CLAUDE.md. */
export interface WallSurfaceSegment {
  faceLengthMm: number;
  startHeightMm: number;
  endHeightMm: number;
  apexHeightMm?: number;
  apexFrac?: number;
  /** Where the span starts along this segment's FACE line (mm from the segment start). */
  faceStartMm: number;
  /** Where the span starts, and how long it runs, along this segment's CENTRE line (mm). */
  frameStartMm: number;
  frameLengthMm: number;
}

/** One insulation pocket, snapshotted from the frame. `x` runs along the wall segment from its
 *  start, `y` is height above FFL, both mm; the top and bottom edges are linear between `x0` and
 *  `x1`, so a pocket cut by a rake is a trapezoid. Built by `wallInsulationPockets`. */
export interface WallSurfacePocket {
  segmentIndex: number;
  x0: number;
  x1: number;
  yb0: number;
  yb1: number;
  yt0: number;
  yt1: number;
}

export interface WallSurfaceMeta {
  type: "wall_surface";
  /** The framing measurement this face was taken off, and its dimension group. */
  sourceMeasurementId: number;
  sourceGroupId: number;
  /** Which face: "left" is the +normal side of each segment (direction rotated +90°). */
  side: "left" | "right";
  /** Per-measurement override of the group's Deduct Openings default; null = follow the group. */
  deductOpenings: boolean | null;
  /** Wall thickness in plan (the framing size's depth) — how far the face sits off the centre line. */
  framingDepthMm: number;
  /** Z datum (metres) inherited from the framing group that owns the source wall, so a surface
   *  stands at the same level as the wall it was taken off rather than at its own group's datum.
   *  Snapshotted like everything else, and re-cut by the drift check if the framing group moves. */
  sourceOffsetM: number;
  segments: WallSurfaceSegment[];
  openings: WallSurfaceOpening[];
  /** The voids between the framing — what an insulation measure counts instead of the whole face.
   *  Always snapshotted, whichever mode the group is in, so switching between Lining and
   *  Insulation is instant and needs no re-snapshot. */
  pockets: WallSurfacePocket[];
  /** The measured run along the wall, as cumulative CENTRE-line arc-length (mm) from the wall's
   *  first vertex. `null` on both means the whole wall — the default when a face is taken off
   *  with a plain click. A drag along the wall sets a partial span. Kept at meta level (as well
   *  as broken down per segment) so overlap between two surfaces on the same wall is a single
   *  interval test. */
  spanStartMm: number | null;
  spanEndMm: number | null;
}

export const EMPTY_WALL_SURFACE_META: WallSurfaceMeta = {
  type: "wall_surface",
  sourceMeasurementId: 0,
  sourceGroupId: 0,
  side: "left",
  deductOpenings: null,
  framingDepthMm: 90,
  sourceOffsetM: 0,
  segments: [],
  openings: [],
  pockets: [],
  spanStartMm: null,
  spanEndMm: null,
};

export function parseWallSurfaceMeta(json: string | null | undefined): WallSurfaceMeta {
  if (!json) return { ...EMPTY_WALL_SURFACE_META };
  try {
    const parsed = JSON.parse(json) as Partial<WallSurfaceMeta>;
    if (parsed?.type !== "wall_surface") return { ...EMPTY_WALL_SURFACE_META };
    return {
      type: "wall_surface",
      sourceMeasurementId: typeof parsed.sourceMeasurementId === "number" ? parsed.sourceMeasurementId : 0,
      sourceGroupId: typeof parsed.sourceGroupId === "number" ? parsed.sourceGroupId : 0,
      side: parsed.side === "right" ? "right" : "left",
      deductOpenings: typeof parsed.deductOpenings === "boolean" ? parsed.deductOpenings : null,
      framingDepthMm: typeof parsed.framingDepthMm === "number" && parsed.framingDepthMm > 0 ? parsed.framingDepthMm : 90,
      sourceOffsetM: typeof parsed.sourceOffsetM === "number" && Number.isFinite(parsed.sourceOffsetM) ? parsed.sourceOffsetM : 0,
      // Snapshots written before partial spans existed carry neither the span nor the per-segment
      // offsets; both default to "the whole segment", which is exactly what those surfaces are.
      segments: Array.isArray(parsed.segments)
        ? parsed.segments.map((seg) => ({
            ...seg,
            faceStartMm: seg.faceStartMm ?? 0,
            frameStartMm: seg.frameStartMm ?? 0,
            frameLengthMm: seg.frameLengthMm ?? seg.faceLengthMm,
          }))
        : [],
      openings: Array.isArray(parsed.openings) ? parsed.openings : [],
      pockets: Array.isArray(parsed.pockets) ? parsed.pockets : [],
      spanStartMm: typeof parsed.spanStartMm === "number" ? parsed.spanStartMm : null,
      spanEndMm: typeof parsed.spanEndMm === "number" ? parsed.spanEndMm : null,
    };
  } catch {
    return { ...EMPTY_WALL_SURFACE_META };
  }
}

export function serializeWallSurfaceMeta(meta: WallSurfaceMeta): string {
  return JSON.stringify(meta);
}

/** Group-level settings for a Wall Surface group (persisted in `framing_props_json`, the same
 *  column Timber Framing / Joist-Rafter use — the three measurement types never coexist). */
export interface WallSurfaceSettings {
  /** Deduct door/window openings from every surface in the group unless a surface overrides it.
   *  Applies to both surface types. */
  deductOpenings: boolean;
}

export const DEFAULT_WALL_SURFACE_SETTINGS: WallSurfaceSettings = { deductOpenings: true };

export function parseWallSurfaceSettings(json: string | null | undefined): WallSurfaceSettings {
  if (!json) return { ...DEFAULT_WALL_SURFACE_SETTINGS };
  try {
    // Blobs written while lining/insulation was a radio inside one type may still carry a
    // "measureType" key; the group's own measurement_type is the authority now, so it is ignored.
    const parsed = JSON.parse(json) as Partial<WallSurfaceSettings>;
    return { deductOpenings: parsed.deductOpenings !== false };
  } catch {
    return { ...DEFAULT_WALL_SURFACE_SETTINGS };
  }
}

export function serializeWallSurfaceSettings(settings: WallSurfaceSettings): string {
  return JSON.stringify(settings);
}

/** Whether this surface deducts openings — its own override if set, else the group's default.
 *  Applies to both measure types: an insulation take-off that deliberately ignores openings is a
 *  legitimate gross figure, so the choice stays with the estimator rather than being forced. */
export function wallSurfaceDeducts(meta: WallSurfaceMeta, props: Pick<GroupProps, "framing_props_json">): boolean {
  return meta.deductOpenings ?? parseWallSurfaceSettings(props.framing_props_json).deductOpenings;
}

/** Gross face area (mm²) of one segment: length × the mean top-plate height over it. A gable rake
 *  is two linear runs meeting at the apex, so it's the length-weighted mean of both halves. */
export function wallSurfaceSegmentAreaMm2(seg: WallSurfaceSegment): number {
  const L = seg.faceLengthMm;
  if (!(L > 0)) return 0;
  if (seg.apexHeightMm !== undefined) {
    const f = Math.max(0, Math.min(1, seg.apexFrac ?? 0.5));
    return L * (f * ((seg.startHeightMm + seg.apexHeightMm) / 2) + (1 - f) * ((seg.apexHeightMm + seg.endHeightMm) / 2));
  }
  return L * ((seg.startHeightMm + seg.endHeightMm) / 2);
}

/** A snapshot's measured run in the form `buildWallSurfaceMeta` takes back, or `null` for a
 *  whole-wall surface. Anything that RE-derives a snapshot must round-trip the run through this —
 *  rebuilding without it silently widens a partial surface back out to its whole wall. */
export function wallSurfaceSpanOf(meta: WallSurfaceMeta, wallLengthMm: number): { startMm: number; endMm: number } | null {
  if (meta.spanStartMm === null && meta.spanEndMm === null) return null;
  return { startMm: meta.spanStartMm ?? 0, endMm: meta.spanEndMm ?? wallLengthMm };
}

/** Two surfaces on the same wall clash when their measured runs overlap — the same lining or batt
 *  counted twice. A `null` span means the whole wall, so it clashes with everything on it. */
export function wallSpansOverlap(a: WallSurfaceMeta, b: WallSurfaceMeta, wallLengthMm: number): boolean {
  const a0 = a.spanStartMm ?? 0;
  const a1 = a.spanEndMm ?? wallLengthMm;
  const b0 = b.spanStartMm ?? 0;
  const b1 = b.spanEndMm ?? wallLengthMm;
  return Math.min(a1, b1) - Math.max(a0, b0) > 1e-6;
}

/** One pocket's area (mm²). A rake can leave the roofline below the pocket's top at one end, so a
 *  trapezoid with one negative height degenerates to a triangle rather than clipping to zero. */
export function wallSurfacePocketAreaMm2(pocket: WallSurfacePocket): number {
  const width = pocket.x1 - pocket.x0;
  if (!(width > 0)) return 0;
  const h0 = pocket.yt0 - pocket.yb0;
  const h1 = pocket.yt1 - pocket.yb1;
  if (h0 <= 0 && h1 <= 0) return 0;
  if (h0 >= 0 && h1 >= 0) return (width * (h0 + h1)) / 2;
  const positive = Math.max(h0, h1);
  const negative = -Math.min(h0, h1);
  return 0.5 * positive * width * (positive / (positive + negative));
}

/** A daylight opening expressed as the pocket it would be if openings were not deducted. The
 *  pocket sweep treats openings as blockers, so this is exactly the piece it held back — the
 *  daylight is clear of framing by construction (trimmers each side, lintel over, sill under),
 *  which is what makes adding it back exact rather than an approximation. */
export function wallOpeningAsPocket(opening: WallSurfaceOpening): WallSurfacePocket {
  const half = opening.widthMm / 2;
  return {
    segmentIndex: opening.segmentIndex,
    x0: opening.frameCentreMm - half,
    x1: opening.frameCentreMm + half,
    yb0: opening.sillMm,
    yb1: opening.sillMm,
    yt0: opening.headMm,
    yt1: opening.headMm,
  };
}

/** Every void an insulation measure counts: the frame's pockets, plus each opening's daylight
 *  when openings are not being deducted. The single list both the quantity and the 3D batts use. */
export function wallInsulationPocketsFor(meta: WallSurfaceMeta, deductOpenings: boolean): WallSurfacePocket[] {
  return deductOpenings ? meta.pockets : [...meta.pockets, ...meta.openings.map(wallOpeningAsPocket)];
}

/** Total insulation area in m²: the sum of the frame's voids, plus the openings when they are not
 *  being deducted. */
export function wallInsulationAreaM2(meta: WallSurfaceMeta, deductOpenings = true): number {
  let mm2 = 0;
  for (const pocket of wallInsulationPocketsFor(meta, deductOpenings)) mm2 += wallSurfacePocketAreaMm2(pocket);
  return mm2 / 1e6;
}

/** The measure this surface reports, in m² — the whole face for a lining, only the frame's voids
 *  for insulation. The single place the two types diverge. */
export function wallSurfaceMeasureM2(
  meta: WallSurfaceMeta,
  props: Pick<GroupProps, "measurement_type" | "framing_props_json">,
): number {
  const deducts = wallSurfaceDeducts(meta, props);
  return isWallInsulationType(props.measurement_type)
    ? wallInsulationAreaM2(meta, deducts)
    : wallSurfaceAreaM2(meta, deducts);
}

/** Net face area in m²: Σ segment areas, less each opening's daylight hole when deducting. */
export function wallSurfaceAreaM2(meta: WallSurfaceMeta, deductOpenings: boolean): number {
  let mm2 = 0;
  for (const seg of meta.segments) mm2 += wallSurfaceSegmentAreaMm2(seg);
  if (deductOpenings) {
    for (const op of meta.openings) mm2 -= Math.max(0, op.widthMm) * Math.max(0, op.headMm - op.sillMm);
  }
  return Math.max(0, mm2) / 1e6;
}
