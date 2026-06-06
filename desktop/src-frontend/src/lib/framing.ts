// Timber Framing (NZS 3604) — settings, geometry, and quantity calc.
//
// This module is the single home for all framing math/geometry. M1 introduced the group-level
// *settings*; M2 adds straight-wall geometry (plate lines + stud set-out). The NZS 3604 quantity
// calc lands in M3. Canonical units are millimetres; geometry is produced in PDF points (Y-up,
// the project convention) so it renders through `pageToScreen` like every other overlay.
// See docs/framing/00-plan.md.

import type { PagePoint } from "./quantity";

/** Selectable framing sizes "D x T" (mm): D = stud depth (= plate/wall thickness in plan),
 *  T = stud thickness (face width along the wall). */
export const FRAMING_SIZES = ["45x45", "90x45", "140x45", "190x45", "240x45", "290x45"] as const;
export type FramingSize = (typeof FRAMING_SIZES)[number];

/** Stud/plate thickness in mm — the "45" of "90x45". Provisional per docs/framing/decisions.md. */
export const STUD_THICKNESS_MM = 45;

export interface PlateConfig {
  on: boolean;
  double: boolean;
}

/** Group-level timber-framing settings (persisted as framing_props_json). */
export interface FramingSettings {
  framingSize: FramingSize;
  studSpacingMm: number;
  topPlate: PlateConfig;
  bottomPlate: PlateConfig;
  wallHeightMm: number;
  dwangCentresMm: number;
  dwangsOn: boolean;
}

export const DEFAULT_FRAMING_SETTINGS: FramingSettings = {
  framingSize: "90x45",
  studSpacingMm: 600,
  topPlate: { on: true, double: false },
  bottomPlate: { on: true, double: false },
  wallHeightMm: 2400,
  dwangCentresMm: 800,
  dwangsOn: true,
};

/** Parse the persisted blob, falling back to defaults for any missing field. */
export function parseFramingSettings(json: string | null | undefined): FramingSettings {
  if (!json) return { ...DEFAULT_FRAMING_SETTINGS };
  try {
    const parsed = JSON.parse(json) as Partial<FramingSettings>;
    return {
      ...DEFAULT_FRAMING_SETTINGS,
      ...parsed,
      topPlate: { ...DEFAULT_FRAMING_SETTINGS.topPlate, ...(parsed.topPlate ?? {}) },
      bottomPlate: { ...DEFAULT_FRAMING_SETTINGS.bottomPlate, ...(parsed.bottomPlate ?? {}) },
    };
  } catch {
    return { ...DEFAULT_FRAMING_SETTINGS };
  }
}

export function serializeFramingSettings(settings: FramingSettings): string {
  return JSON.stringify(settings);
}

/** Stud depth D in mm (the "90" of "90x45") — the plate/wall thickness in plan view. */
export function framingDepthMm(size: FramingSize): number {
  return Number.parseInt(size.split("x")[0], 10) || 90;
}

// ---------------------------------------------------------------------------------------------
// Per-wall openings (doors — M5; windows — M6). Stored in measurements.framing_json.
// ---------------------------------------------------------------------------------------------

/** A door/window opening inserted into a wall. Positioned by the segment it sits on and the
 *  arc-length (mm) of its centre along that segment. */
export interface Opening {
  kind: "door" | "window";
  segmentIndex: number;
  centreMm: number;
  daylightHeightMm: number; // FFL (bottom of bottom plate) to underside of lintel
  daylightWidthMm: number; // trimmer to trimmer
  lintelSize: FramingSize;
  lintelPly: number;
  // Window-only (M6); ignored for doors.
  sillHeightMm?: number;
}

/** A raking frame on one wall segment: the top plate slopes between `startMm` (wall height at the
 *  segment start) and `endMm` (at the segment end). */
export interface Rake {
  segmentIndex: number;
  startMm: number;
  endMm: number;
}

/** A manually-placed extra stud on a wall segment (select-mode Ctrl-hover), at arc-length `centreMm`. */
export interface ExtraStud {
  segmentIndex: number;
  centreMm: number;
}

/** Per-wall framing extras (measurements.framing_json). */
export interface WallFraming {
  openings: Opening[];
  rakes: Rake[];
  extraStuds: ExtraStud[];
}

/** The configurable part of an opening (everything except where it sits) — what the Add Door /
 *  Add Window dialog edits and what's carried while placing the ghost. */
export type OpeningTemplate = Omit<Opening, "segmentIndex" | "centreMm">;

export const DEFAULT_DOOR: OpeningTemplate = {
  kind: "door",
  daylightHeightMm: 2100,
  daylightWidthMm: 910,
  lintelSize: "90x45",
  lintelPly: 2,
};

export const DEFAULT_WINDOW: OpeningTemplate = {
  kind: "window",
  daylightHeightMm: 1200, // glass height (head − sill); head = 900 + 1200 = 2100
  daylightWidthMm: 1200,
  lintelSize: "90x45",
  lintelPly: 2,
  sillHeightMm: 900,
};

/** Head height (FFL → underside of lintel) = sill height + daylight (glass) height. A door has
 *  no sill, so its head height is just its daylight height. */
export function headHeightMm(opening: Pick<Opening, "kind" | "daylightHeightMm" | "sillHeightMm">): number {
  return (opening.kind === "window" ? opening.sillHeightMm ?? 0 : 0) + opening.daylightHeightMm;
}

export function parseWallFraming(json: string | null | undefined): WallFraming {
  if (!json) return { openings: [], rakes: [], extraStuds: [] };
  try {
    const parsed = JSON.parse(json) as Partial<WallFraming>;
    return {
      openings: Array.isArray(parsed.openings) ? parsed.openings : [],
      rakes: Array.isArray(parsed.rakes) ? parsed.rakes : [],
      extraStuds: Array.isArray(parsed.extraStuds) ? parsed.extraStuds : [],
    };
  } catch {
    return { openings: [], rakes: [], extraStuds: [] };
  }
}

export function serializeWallFraming(framing: WallFraming): string {
  return JSON.stringify(framing);
}

// ---------------------------------------------------------------------------------------------
// Straight-wall geometry (M2). All inputs/outputs in PDF points (Y-up) unless noted.
// ---------------------------------------------------------------------------------------------

/** Rendered framing geometry for one wall: the two plate outlines and the stud rectangles. */
export interface FramingGeometry {
  /** The two parallel plate edges (centre path offset ±depth/2). */
  plateLeft: PagePoint[];
  plateRight: PagePoint[];
  /** Each stud as its 4 corners (PDF points), ordered for a closed rectangle. */
  studs: PagePoint[][];
  studCount: number;
  /** Door/window daylight openings (the rectangular gap in the wall), for rendering. */
  openings: { daylight: PagePoint[]; kind: "door" | "window" }[];
}

const GEOM_EPS = 1e-6;

/** Unit "left" normal of edge a→b (rotate the direction +90°). */
function edgeUnitNormal(a: PagePoint, b: PagePoint): PagePoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

/** Offset a polyline by `dist` along the per-vertex normal, with a proper miter join at interior
 *  corners: the offset scales by 1/cos(halfAngle) so each edge's plate line sits exactly `dist`
 *  from the centre line and the two meet cleanly at the miter point. */
function offsetPolyline(path: PagePoint[], dist: number): PagePoint[] {
  const n = path.length;
  if (n < 2) return path.map((p) => ({ ...p }));
  const out: PagePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? edgeUnitNormal(path[i - 1], path[i]) : null;
    const next = i < n - 1 ? edgeUnitNormal(path[i], path[i + 1]) : null;
    if (prev && next) {
      const mx = prev.x + next.x;
      const my = prev.y + next.y;
      const mlen = Math.hypot(mx, my);
      if (mlen < GEOM_EPS) {
        // ~180° reversal — fall back to the incoming edge normal.
        out.push({ x: path[i].x + prev.x * dist, y: path[i].y + prev.y * dist });
      } else {
        const ux = mx / mlen;
        const uy = my / mlen;
        const cosHalf = ux * prev.x + uy * prev.y; // cos(half of the turn angle)
        const scale = Math.abs(cosHalf) > 0.2 ? dist / cosHalf : dist; // clamp very sharp corners
        out.push({ x: path[i].x + ux * scale, y: path[i].y + uy * scale });
      }
    } else {
      const nrm = prev ?? next ?? { x: 0, y: 0 };
      out.push({ x: path[i].x + nrm.x * dist, y: path[i].y + nrm.y * dist });
    }
  }
  return out;
}

/** Total polyline length (PDF points). */
function pathLengthPts(path: PagePoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

/** A stud rectangle (4 corners) centred at `centre`, `studThk` along `dir`, `depth` across it. */
function makeStudRect(centre: PagePoint, dir: PagePoint, halfThk: number, halfDepth: number): PagePoint[] {
  const nrm = { x: -dir.y, y: dir.x };
  const corner = (along: number, across: number): PagePoint => ({
    x: centre.x + along * dir.x + across * nrm.x,
    y: centre.y + along * dir.y + across * nrm.y,
  });
  return [
    corner(-halfThk, halfDepth),
    corner(halfThk, halfDepth),
    corner(halfThk, -halfDepth),
    corner(-halfThk, -halfDepth),
  ];
}

/**
 * Corner sheet-fixing gap (mm) between corner studs 2 and 3 = wall depth − stud thickness, so
 * stud 3's outer face lands on the wall's internal corner (the inner face of the lead-in wall),
 * forming the internal nailing corner. Equals 45 mm for a 90×45 wall (the docs example), and
 * grows with deeper framing (95 mm for 140×45, etc.). See docs/corner makeup.png.
 */
export function cornerGapMm(size: FramingSize): number {
  return framingDepthMm(size) - STUD_THICKNESS_MM;
}

/** Per-segment stud set-out: `a`/`dir`/`segLen` plus the arc-length centres of the `anchor` studs
 *  (flush ends + the NZ 3-stud corner makeup, always present) and the `regular` infill studs
 *  (subject to being cut by openings). Shared by geometry and the quantity calc so they agree. */
export interface SegLayout {
  a: PagePoint;
  dir: PagePoint;
  segLen: number;
  anchors: number[];
  regular: number[];
}

/**
 * Stud set-out per segment with the NZ 3-stud corner makeup at every interior corner
 * (docs/corner makeup.png): the lead-in segment ends with a stud at the corner (stud 1); the
 * lead-out segment starts with a stud at the corner (stud 2), a (depth − thickness) gap, then a
 * third stud (stud 3). Free wall ends carry a flush stud. Regular studs fill at `studSpacing`.
 */
export function studLayout(
  path: PagePoint[],
  depthPts: number,
  studThkPts: number,
  spacingPts: number,
  gapPts: number,
): SegLayout[] {
  const halfThk = studThkPts / 2;
  const halfDepth = depthPts / 2;
  const out: SegLayout[] = [];
  const n = path.length;

  for (let seg = 0; seg < n - 1; seg += 1) {
    const a = path[seg];
    const b = path[seg + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < GEOM_EPS) continue;
    const dir = { x: dx / segLen, y: dy / segLen };

    const isFirst = seg === 0;
    const isLast = seg === n - 2;
    const startStuds = isFirst
      ? [halfThk]
      : [-halfDepth + halfThk, -halfDepth + studThkPts + gapPts + halfThk];
    const endStuds = isLast ? [segLen - halfThk] : [segLen - halfDepth - halfThk];

    const regular: number[] = [];
    const regularFrom = startStuds[startStuds.length - 1];
    const regularTo = endStuds[0];
    for (let s = regularFrom + spacingPts; s < regularTo - GEOM_EPS; s += spacingPts) regular.push(s);

    out.push({ a, dir, segLen, anchors: [...startStuds, ...endStuds], regular });
  }

  return out;
}

const pointAt = (seg: SegLayout, s: number): PagePoint => ({ x: seg.a.x + seg.dir.x * s, y: seg.a.y + seg.dir.y * s });

/** A rectangular member from arc-length `s0` to `s1` along a segment, spanning ±`halfDepth`. */
function memberRect(seg: SegLayout, s0: number, s1: number, halfDepth: number): PagePoint[] {
  const nrm = { x: -seg.dir.y, y: seg.dir.x };
  const corner = (s: number, c: number): PagePoint => ({ x: seg.a.x + seg.dir.x * s + c * nrm.x, y: seg.a.y + seg.dir.y * s + c * nrm.y });
  return [corner(s0, halfDepth), corner(s1, halfDepth), corner(s1, -halfDepth), corner(s0, -halfDepth)];
}

/** Jamb stud centre arc-lengths for an opening: a trimmer just outside each daylight edge, then a
 *  king just outside each trimmer. All in PDF points along the opening's segment. */
export function openingJambs(centrePts: number, dwHalfPts: number, studThkPts: number) {
  return {
    trimmers: [centrePts - (dwHalfPts + studThkPts / 2), centrePts + (dwHalfPts + studThkPts / 2)],
    kings: [centrePts - (dwHalfPts + studThkPts * 1.5), centrePts + (dwHalfPts + studThkPts * 1.5)],
  };
}

/** A manually-placed extra stud's rectangle (4 corners) at arc-length `centreMm` on a segment. */
export function extraStudRect(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  segmentIndex: number,
  centreMm: number,
): PagePoint[] | null {
  if (!mmPerPoint || !(mmPerPoint > 0)) return null;
  const a = path[segmentIndex];
  const b = path[segmentIndex + 1];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen = Math.hypot(dx, dy);
  if (segLen < GEOM_EPS) return null;
  const dir = { x: dx / segLen, y: dy / segLen };
  const centrePts = centreMm / mmPerPoint;
  const centre = { x: a.x + dir.x * centrePts, y: a.y + dir.y * centrePts };
  return makeStudRect(centre, dir, STUD_THICKNESS_MM / mmPerPoint / 2, framingDepthMm(settings.framingSize) / mmPerPoint / 2);
}

/**
 * Plate outlines + stud rectangles for a wall path, sized in real mm via `mmPerPoint`. With
 * openings, regular studs inside an opening are removed and the jamb (king + trimmer) studs are
 * added; the daylight rect is returned for rendering. Manually-placed extra studs are added too.
 * Returns empty geometry when there's no scale or the path is degenerate.
 */
export function computeFramingGeometry(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  framing?: WallFraming,
): FramingGeometry {
  const empty: FramingGeometry = { plateLeft: [], plateRight: [], studs: [], studCount: 0, openings: [] };
  if (path.length < 2 || !mmPerPoint || !(mmPerPoint > 0)) return empty;

  const depthPts = framingDepthMm(settings.framingSize) / mmPerPoint;
  const studThkPts = STUD_THICKNESS_MM / mmPerPoint;
  const spacingPts = Math.max(settings.studSpacingMm, 1) / mmPerPoint;
  const gapPts = cornerGapMm(settings.framingSize) / mmPerPoint;
  const halfDepth = depthPts / 2;
  const halfThk = studThkPts / 2;

  const plateLeft = offsetPolyline(path, halfDepth);
  const plateRight = offsetPolyline(path, -halfDepth);
  const layout = studLayout(path, depthPts, studThkPts, spacingPts, gapPts);
  const openings = framing?.openings ?? [];

  const studs: PagePoint[][] = [];
  const openingRects: { daylight: PagePoint[]; kind: "door" | "window" }[] = [];

  layout.forEach((seg, segIndex) => {
    const segOpenings = openings.filter((o) => o.segmentIndex === segIndex);
    for (const s of seg.anchors) studs.push(makeStudRect(pointAt(seg, s), seg.dir, halfThk, halfDepth));

    for (const s of seg.regular) {
      const cut = segOpenings.some((o) => Math.abs(s - o.centreMm / mmPerPoint) <= o.daylightWidthMm / mmPerPoint / 2 + 2 * studThkPts);
      if (!cut) studs.push(makeStudRect(pointAt(seg, s), seg.dir, halfThk, halfDepth));
    }

    for (const o of segOpenings) {
      const centrePts = o.centreMm / mmPerPoint;
      const dwHalf = o.daylightWidthMm / mmPerPoint / 2;
      const jambs = openingJambs(centrePts, dwHalf, studThkPts);
      for (const p of [...jambs.trimmers, ...jambs.kings]) studs.push(makeStudRect(pointAt(seg, p), seg.dir, halfThk, halfDepth));
      openingRects.push({ daylight: memberRect(seg, centrePts - dwHalf, centrePts + dwHalf, halfDepth), kind: o.kind });
    }
  });

  for (const es of framing?.extraStuds ?? []) {
    const rect = extraStudRect(path, settings, mmPerPoint, es.segmentIndex, es.centreMm);
    if (rect) studs.push(rect);
  }

  return { plateLeft, plateRight, studs, studCount: studs.length, openings: openingRects };
}

/**
 * Constrains a candidate vertex so each corner after the first segment is a 90° turn: the new
 * segment is forced parallel or perpendicular to the previous one (walls "can only be 90°", per
 * the brief). The first point and first segment are unconstrained (a wall can run at any angle).
 */
export function orthogonalConstrain(draft: PagePoint[], candidate: PagePoint): PagePoint {
  if (draft.length < 2) return candidate;
  const prev = draft[draft.length - 1];
  const prevPrev = draft[draft.length - 2];
  const dx = prev.x - prevPrev.x;
  const dy = prev.y - prevPrev.y;
  const len = Math.hypot(dx, dy);
  if (len < GEOM_EPS) return candidate;
  const ux = dx / len;
  const uy = dy / len; // along the previous segment
  const px = -uy;
  const py = ux; // perpendicular
  const vx = candidate.x - prev.x;
  const vy = candidate.y - prev.y;
  const along = vx * ux + vy * uy;
  const perp = vx * px + vy * py;
  return Math.abs(along) >= Math.abs(perp)
    ? { x: prev.x + ux * along, y: prev.y + uy * along } // continue straight
    : { x: prev.x + px * perp, y: prev.y + py * perp }; // 90° turn
}

// ---------------------------------------------------------------------------------------------
// Quantity makeup (M3) — NZS 3604 lineal-metre breakdown. See docs/framing/00-plan.md and the
// worked examples in docs/Framing_tool.md. Lengths reported in metres.
// ---------------------------------------------------------------------------------------------

/** Plate thickness in mm (plates are 45 thick); equals the stud thickness. */
export const PLATE_THICKNESS_MM = STUD_THICKNESS_MM;

/** Number of plate layers = top (×2 if double) + bottom (×2 if double). */
export function plateLayerCount(settings: FramingSettings): number {
  let layers = 0;
  if (settings.topPlate.on) layers += settings.topPlate.double ? 2 : 1;
  if (settings.bottomPlate.on) layers += settings.bottomPlate.double ? 2 : 1;
  return layers;
}

/** Stud height (mm) = wall height − 45 × plate layers. Worked: 2400 − 45 − 45 = 2310. */
export function studHeightMm(settings: FramingSettings): number {
  return Math.max(0, settings.wallHeightMm - PLATE_THICKNESS_MM * plateLayerCount(settings));
}

/**
 * Dwang rows for a bay, given its stud-zone height (= wall height − plate makeup). Dwangs sit at
 * fixed `centres` up from the bottom plate; a row is placed only where it clears the (sloping) top
 * plate, so rows = floor(studZone / centres). A 2.4 m wall (single T&B → 2310 stud zone) at 800 →
 * **2 rows** (the 3rd pocket can't fit another dwang — see docs/dwang theory.png). On a raked bay
 * the limiting height is the bay's lower end, so an extra dwang is omitted where the rake is tight.
 */
export function dwangRowsForStudHeight(studHeightMm: number, centresMm: number): number {
  if (studHeightMm <= 0 || centresMm <= 0) return 0;
  return Math.max(0, Math.floor(studHeightMm / centresMm));
}

/** Nominal dwang rows for the group's flat wall height; 0 when dwangs are off. */
export function dwangRowCount(settings: FramingSettings): number {
  if (!settings.dwangsOn) return 0;
  return dwangRowsForStudHeight(studHeightMm(settings), settings.dwangCentresMm);
}

export type FramingComponentKind =
  | "plate"
  | "stud"
  | "dwang"
  | "king"
  | "trimmer"
  | "lintel"
  | "jack"
  | "sill"
  | "sill_jack";

const KIND_ORDER: FramingComponentKind[] = ["plate", "stud", "dwang", "king", "trimmer", "lintel", "jack", "sill", "sill_jack"];
const KIND_LABEL: Record<FramingComponentKind, string> = {
  plate: "Plates",
  stud: "Studs",
  dwang: "Dwangs",
  king: "King studs",
  trimmer: "Trimmers",
  lintel: "Lintels",
  jack: "Jack studs",
  sill: "Sills",
  sill_jack: "Sill jacks",
};

/** One line of a wall's framing makeup. `count`/`eachM` are the human-readable factors; the
 *  quantity that rolls up is `totalM` (lineal metres). `detail` is the intermediate math.
 *  `sizeOverride` is present when this is a lintel whose size differs from the group's framingSize. */
export interface FramingComponent {
  kind: FramingComponentKind;
  /** Present when this lintel row uses a size other than the group's framingSize. */
  sizeOverride?: FramingSize;
  label: string;
  count: number;
  totalM: number;
  detail: string;
}

/** Full lineal-metre makeup of one wall. */
export interface FramingQuantities {
  components: FramingComponent[];
  totalM: number;
  // Intermediate values, exposed for the breakdown inspector / tests.
  wallLengthM: number;
  studHeightMm: number;
  studCount: number;
  plateLayers: number;
  dwangRows: number;
}

const MM_PER_M = 1000;

export function bottomLayerCount(s: FramingSettings): number {
  return s.bottomPlate.on ? (s.bottomPlate.double ? 2 : 1) : 0;
}
export function topLayerCount(s: FramingSettings): number {
  return s.topPlate.on ? (s.topPlate.double ? 2 : 1) : 0;
}

/** A single framing member with its 3D box placement (world metres, Y up) and its lineal length
 *  (metres) for the takeoff. The 2D quantities and the 3D view both derive from this list, so they
 *  always agree. `sizeOverride` is set on lintel members whose size differs from the group's
 *  `framingSize` (e.g. a 140×45 lintel in a 90×45 group). */
export interface WallMember {
  kind: FramingComponentKind;
  /** Lintel-only: the lintel's FramingSize when it differs from the group's framingSize. */
  sizeOverride?: FramingSize;
  lengthM: number;
  position: [number, number, number];
  size: [number, number, number]; // [along, vertical thickness/height, depth across the wall]
  yaw: number;
  pitch: number;
}

/**
 * The full member list for a wall — plates, studs, dwangs and (per opening) kings, trimmers, lintel,
 * jacks, sill + sill jacks, plus manual extra studs. Reuses the 2D set-out (`studLayout`,
 * `openingJambs`, the dwang rule) so geometry, quantities and 3D stay in lockstep. Lengths in mm
 * internally; boxes in world metres with the PDF page as the floor (Y up).
 */
export function wallMembers(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  framing?: WallFraming,
): WallMember[] {
  const members: WallMember[] = [];
  if (path.length < 2 || !mmPerPoint || !(mmPerPoint > 0)) return members;

  const S = mmPerPoint / 1000; // metres per PDF point
  const M = (mm: number) => mm / 1000;
  const depthMm = framingDepthMm(settings.framingSize);
  const depthM = M(depthMm);
  const thkM = M(STUD_THICKNESS_MM);
  const layers = plateLayerCount(settings);
  const bottomLayers = bottomLayerCount(settings);
  const topLayers = topLayerCount(settings);
  const bottomMakeup = STUD_THICKNESS_MM * bottomLayers;
  const topMakeup = STUD_THICKNESS_MM * topLayers;
  const centresMm = settings.dwangCentresMm;
  const rakes = framing?.rakes ?? [];
  const openings = framing?.openings ?? [];
  const extraStuds = framing?.extraStuds ?? [];

  const depthPts = depthMm / mmPerPoint;
  const studThkPts = STUD_THICKNESS_MM / mmPerPoint;
  const spacingPts = Math.max(settings.studSpacingMm, 1) / mmPerPoint;
  const gapPts = cornerGapMm(settings.framingSize) / mmPerPoint;
  const layout = studLayout(path, depthPts, studThkPts, spacingPts, gapPts);
  const heightAt = (segIndex: number, frac: number) => {
    const rake = rakes.find((r) => r.segmentIndex === segIndex);
    return rake ? rake.startMm + (rake.endMm - rake.startMm) * Math.max(0, Math.min(1, frac)) : settings.wallHeightMm;
  };

  layout.forEach((seg, segIndex) => {
    const dir = seg.dir;
    const yaw = Math.atan2(dir.y, dir.x);
    const fx = (s: number) => (seg.a.x + dir.x * s) * S;
    const fz = (s: number) => -(seg.a.y + dir.y * s) * S;
    const segRunMm = seg.segLen * mmPerPoint;
    const segLenM = M(segRunMm);
    const midS = seg.segLen / 2;
    const rake = rakes.find((r) => r.segmentIndex === segIndex);
    const startH = rake ? rake.startMm : settings.wallHeightMm;
    const endH = rake ? rake.endMm : settings.wallHeightMm;

    // Vertical member (stud-like): records it for the dwang pass and emits its box.
    const verticals: { x: number; yB: number; yT: number }[] = [];
    const addV = (kind: FramingComponentKind, s: number, yB: number, yT: number) => {
      if (yT - yB <= 0) return;
      verticals.push({ x: s, yB, yT });
      members.push({ kind, lengthM: M(yT - yB), position: [fx(s), M((yB + yT) / 2), fz(s)], size: [thkM, M(yT - yB), depthM], yaw, pitch: 0 });
    };

    // Plates (bottom flat; top sloped + pitched on a rake).
    for (let l = 0; l < bottomLayers; l += 1) {
      members.push({ kind: "plate", lengthM: segLenM, position: [fx(midS), M(l * STUD_THICKNESS_MM + STUD_THICKNESS_MM / 2), fz(midS)], size: [segLenM, thkM, depthM], yaw, pitch: 0 });
    }
    const pitch = rake ? Math.atan2(endH - startH, segRunMm) : 0;
    const topLenM = rake ? M(Math.hypot(segRunMm, endH - startH)) : segLenM;
    const avgTop = (startH + endH) / 2;
    for (let l = 0; l < topLayers; l += 1) {
      members.push({ kind: "plate", lengthM: topLenM, position: [fx(midS), M(avgTop - topMakeup + l * STUD_THICKNESS_MM + STUD_THICKNESS_MM / 2), fz(midS)], size: [topLenM, thkM, depthM], yaw, pitch });
    }

    // Studs (anchors + regulars not cut by an opening).
    const segOpenings = openings.filter((o) => o.segmentIndex === segIndex);
    const cut = (s: number) => segOpenings.some((o) => Math.abs(s - o.centreMm / mmPerPoint) <= o.daylightWidthMm / mmPerPoint / 2 + 2 * studThkPts);
    for (const s of [...seg.anchors, ...seg.regular.filter((x) => !cut(x))]) {
      addV("stud", s, bottomMakeup, heightAt(segIndex, seg.segLen > 0 ? s / seg.segLen : 0) - topMakeup);
    }

    // Opening members.
    const openMeta: { centrePts: number; dwHalf: number; sill: number; head: number }[] = [];
    for (const o of segOpenings) {
      const centrePts = o.centreMm / mmPerPoint;
      const dwHalf = o.daylightWidthMm / mmPerPoint / 2;
      const jambs = openingJambs(centrePts, dwHalf, studThkPts);
      const isWindow = o.kind === "window";
      const sill = isWindow ? o.sillHeightMm ?? 0 : 0;
      const head = sill + o.daylightHeightMm;
      const lintelDepth = framingDepthMm(o.lintelSize);
      openMeta.push({ centrePts, dwHalf, sill, head });

      for (const k of jambs.kings) addV("king", k, bottomMakeup, heightAt(segIndex, k / seg.segLen) - topMakeup); // full, follows rake
      for (const t of jambs.trimmers) addV("trimmer", t, bottomMakeup, head); // full: bottom plate → underside of lintel
      const lintelLenM = M(o.daylightWidthMm + 2 * STUD_THICKNESS_MM);
      const lintelSizeOverride = o.lintelSize !== settings.framingSize ? o.lintelSize : undefined;
      // Lintel ply rendered as `ply` stacked beams across the depth (for legibility); length counts ×ply.
      for (let p = 0; p < o.lintelPly; p += 1) {
        members.push({ kind: "lintel", sizeOverride: lintelSizeOverride, lengthM: lintelLenM, position: [fx(centrePts), M(head + lintelDepth / 2), fz(centrePts)], size: [lintelLenM, M(lintelDepth), depthM / Math.max(1, o.lintelPly)], yaw, pitch: 0 });
      }
      const jackPositions = seg.regular.filter((s) => Math.abs(s - centrePts) < dwHalf);
      for (const s of jackPositions) addV("jack", s, head + lintelDepth, heightAt(segIndex, s / seg.segLen) - topMakeup);

      if (isWindow) {
        members.push({ kind: "sill", lengthM: M(o.daylightWidthMm), position: [fx(centrePts), M(sill - STUD_THICKNESS_MM / 2), fz(centrePts)], size: [M(o.daylightWidthMm), thkM, depthM], yaw, pitch: 0 });
        const sillTop = sill - STUD_THICKNESS_MM; // underside of the sill
        const supports = [centrePts - (dwHalf - studThkPts / 2), centrePts + (dwHalf - studThkPts / 2)]; // tight inside the trimmers
        for (const s of [...jackPositions, ...supports]) addV("sill_jack", s, bottomMakeup, sillTop);
      }
    }

    // Dwangs — per row (fixed centres up from the bottom plate), between adjacent members present at
    // that height, skipping a bay that spans an open daylight (door: full height; window: sill→head).
    if (settings.dwangsOn && centresMm > 0) {
      const maxTop = verticals.reduce((mx, v) => Math.max(mx, v.yT), 0);
      for (let h = bottomMakeup + centresMm; h <= maxTop + 1e-6; h += centresMm) {
        const present = verticals.filter((v) => v.yB <= h + 1e-6 && v.yT >= h - 1e-6).sort((a, b) => a.x - b.x);
        for (let i = 0; i + 1 < present.length; i += 1) {
          const mid = (present[i].x + present[i + 1].x) / 2;
          if (openMeta.some((o) => Math.abs(mid - o.centrePts) < o.dwHalf && h > o.sill + 1e-6 && h < o.head - 1e-6)) continue;
          const bayGapMm = (present[i + 1].x - present[i].x) * mmPerPoint - STUD_THICKNESS_MM;
          if (bayGapMm <= 0) continue;
          members.push({ kind: "dwang", lengthM: M(bayGapMm), position: [fx(mid), M(h), fz(mid)], size: [M(bayGapMm), thkM, depthM], yaw, pitch: 0 });
        }
      }
    }
  });

  // Manually-placed extra studs.
  for (const es of extraStuds) {
    const seg = layout[es.segmentIndex];
    if (!seg) continue;
    const sPts = es.centreMm / mmPerPoint;
    const yaw = Math.atan2(seg.dir.y, seg.dir.x);
    const yT = heightAt(es.segmentIndex, seg.segLen > 0 ? sPts / seg.segLen : 0) - topMakeup;
    if (yT - bottomMakeup <= 0) continue;
    members.push({
      kind: "stud",
      lengthM: M(yT - bottomMakeup),
      position: [(seg.a.x + seg.dir.x * sPts) * S, M((bottomMakeup + yT) / 2), -(seg.a.y + seg.dir.y * sPts) * S],
      size: [thkM, M(yT - bottomMakeup), depthM],
      yaw,
      pitch: 0,
    });
  }

  return members;
}

/** Composite map key for a framing component — includes size when it's a non-default lintel. */
function framingComponentKey(kind: FramingComponentKind, sizeOverride?: FramingSize): string {
  return sizeOverride ? `${kind}:${sizeOverride}` : kind;
}

/** Human label for a framing component row, including size suffix for non-default lintels. */
function framingComponentLabel(kind: FramingComponentKind, sizeOverride?: FramingSize): string {
  return sizeOverride ? `${KIND_LABEL[kind]} - ${sizeOverride.replace("x", " × ")}` : KIND_LABEL[kind];
}

/** Sort comparator for component entries: follows KIND_ORDER; within lintels, default size first. */
function compareComponents(
  a: { kind: FramingComponentKind; sizeOverride?: FramingSize },
  b: { kind: FramingComponentKind; sizeOverride?: FramingSize },
): number {
  const kindDiff = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  if (kindDiff !== 0) return kindDiff;
  if (!a.sizeOverride && b.sizeOverride) return -1;
  if (a.sizeOverride && !b.sizeOverride) return 1;
  return (a.sizeOverride ?? "").localeCompare(b.sizeOverride ?? "");
}

/**
 * NZS 3604 lineal-metre makeup for one wall, aggregated from `wallMembers` (so it always matches the
 * 3D view). Returns null without a scale or a drawable wall.
 */
export function computeFramingQuantities(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  framing?: WallFraming,
): FramingQuantities | null {
  if (path.length < 2 || !mmPerPoint || !(mmPerPoint > 0)) return null;

  const members = wallMembers(path, settings, mmPerPoint, framing);
  type ComponentAcc = { count: number; totalM: number; kind: FramingComponentKind; sizeOverride?: FramingSize };
  const byComponent = new Map<string, ComponentAcc>();
  for (const member of members) {
    const key = framingComponentKey(member.kind, member.sizeOverride);
    const acc = byComponent.get(key) ?? { count: 0, totalM: 0, kind: member.kind, sizeOverride: member.sizeOverride };
    acc.count += 1;
    acc.totalM += member.lengthM;
    byComponent.set(key, acc);
  }

  const components: FramingComponent[] = [];
  let totalM = 0;
  for (const acc of [...byComponent.values()].sort(compareComponents)) {
    if (acc.totalM <= 1e-9) continue;
    const label = framingComponentLabel(acc.kind, acc.sizeOverride);
    components.push({ kind: acc.kind, sizeOverride: acc.sizeOverride, label, count: acc.count, totalM: acc.totalM, detail: `${acc.count} × ${label.toLowerCase()}` });
    totalM += acc.totalM;
  }

  return {
    components,
    totalM,
    wallLengthM: (pathLengthPts(path) * mmPerPoint) / MM_PER_M,
    studHeightMm: studHeightMm(settings),
    studCount: byComponent.get("stud")?.count ?? 0,
    plateLayers: plateLayerCount(settings),
    dwangRows: dwangRowCount(settings),
  };
}

/** One wall's input for group aggregation (geometry + framing extras + the page's scale). */
export interface FramingWallInput {
  id: number;
  points: PagePoint[];
  mmPerPoint: number | null;
  framing?: WallFraming;
}

/** An aggregated component line across a group's walls.
 *  `sizeOverride` is present when this lintel row uses a size other than the group's framingSize. */
export interface FramingComponentTotal {
  kind: FramingComponentKind;
  sizeOverride?: FramingSize;
  label: string;
  count: number;
  totalM: number;
}

/** Group-level makeup: per-wall quantities plus component totals aggregated across all walls.
 *  `matchingTotalM` counts only timber matching the group's own framingSize (no sizeOverride) —
 *  this is the canonical group quantity shown in the sidebar and used for worksheet line items.
 *  `totalM` is the all-in sum across all sizes, kept for CSV export / reference. */
export interface FramingGroupBreakdown {
  perWall: { id: number; quantities: FramingQuantities }[];
  components: FramingComponentTotal[];
  /** Canonical group quantity: timber matching the group's framingSize only. */
  matchingTotalM: number;
  /** All-in total across all framing sizes (matching + override lintels). */
  totalM: number;
}

/** Aggregate a framing group's walls into per-component totals + a grand total (lineal m). */
export function aggregateFramingGroup(
  walls: FramingWallInput[],
  settings: FramingSettings,
): FramingGroupBreakdown {
  const perWall: { id: number; quantities: FramingQuantities }[] = [];
  type TotalAcc = { count: number; totalM: number; kind: FramingComponentKind; sizeOverride?: FramingSize };
  const byComponent = new Map<string, TotalAcc>();
  for (const wall of walls) {
    const q = computeFramingQuantities(wall.points, settings, wall.mmPerPoint, wall.framing);
    if (!q) continue;
    perWall.push({ id: wall.id, quantities: q });
    for (const c of q.components) {
      const key = framingComponentKey(c.kind, c.sizeOverride);
      const acc = byComponent.get(key) ?? { count: 0, totalM: 0, kind: c.kind, sizeOverride: c.sizeOverride };
      acc.count += c.count;
      acc.totalM += c.totalM;
      byComponent.set(key, acc);
    }
  }
  const components: FramingComponentTotal[] = [];
  let totalM = 0;
  let matchingTotalM = 0;
  for (const acc of [...byComponent.values()].sort(compareComponents)) {
    if (acc.totalM <= 1e-9) continue;
    components.push({ kind: acc.kind, sizeOverride: acc.sizeOverride, label: framingComponentLabel(acc.kind, acc.sizeOverride), count: acc.count, totalM: acc.totalM });
    totalM += acc.totalM;
    if (!acc.sizeOverride) matchingTotalM += acc.totalM;
  }
  return { perWall, components, matchingTotalM, totalM };
}

/** Render geometry for a single opening (its daylight gap + jamb studs), for ghost previews. */
export function openingPreview(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  opening: Opening,
): { daylight: PagePoint[]; jambs: PagePoint[][] } | null {
  if (path.length < 2 || !mmPerPoint || !(mmPerPoint > 0)) return null;
  const depthPts = framingDepthMm(settings.framingSize) / mmPerPoint;
  const studThkPts = STUD_THICKNESS_MM / mmPerPoint;
  const spacingPts = Math.max(settings.studSpacingMm, 1) / mmPerPoint;
  const gapPts = cornerGapMm(settings.framingSize) / mmPerPoint;
  const seg = studLayout(path, depthPts, studThkPts, spacingPts, gapPts)[opening.segmentIndex];
  if (!seg) return null;
  const halfDepth = depthPts / 2;
  const halfThk = studThkPts / 2;
  const centrePts = opening.centreMm / mmPerPoint;
  const dwHalf = opening.daylightWidthMm / mmPerPoint / 2;
  const jambs = openingJambs(centrePts, dwHalf, studThkPts);
  return {
    daylight: memberRect(seg, centrePts - dwHalf, centrePts + dwHalf, halfDepth),
    jambs: [...jambs.trimmers, ...jambs.kings].map((p) => makeStudRect(pointAt(seg, p), seg.dir, halfThk, halfDepth)),
  };
}

/**
 * Projects a screen-space wall hit (a point in PDF points) onto the nearest segment of a wall
 * path, returning the segment index and the arc-length (mm) of the projection along it — the
 * placement parameters for inserting an opening. Returns null when the path is degenerate.
 */
export function projectOntoPath(
  path: PagePoint[],
  point: PagePoint,
  mmPerPoint: number,
): { segmentIndex: number; centreMm: number; distancePts: number } | null {
  let best: { segmentIndex: number; centreMm: number; distancePts: number } | null = null;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < GEOM_EPS) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    const distPts = Math.hypot(point.x - projX, point.y - projY);
    if (!best || distPts < best.distancePts) {
      best = { segmentIndex: i, centreMm: t * Math.sqrt(lenSq) * mmPerPoint, distancePts: distPts };
    }
  }
  return best;
}
