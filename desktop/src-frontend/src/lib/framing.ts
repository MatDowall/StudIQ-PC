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

/** Group-level settings for a Joist/Rafter group (persisted as framing_props_json, same column
 *  as Timber Framing's FramingSettings — the two measurement types never coexist on one group).
 *  Stored under the same "framingSize" JSON key as FramingSettings so the sidebar name-suffix
 *  query (`json_extract(framing_props_json, '$.framingSize')`) works for both types uniformly. */
export interface JoistRafterSettings {
  framingSize: FramingSize;
}

export const DEFAULT_JOIST_RAFTER_SETTINGS: JoistRafterSettings = { framingSize: "90x45" };

export function parseJoistRafterSettings(json: string | null | undefined): JoistRafterSettings {
  if (!json) return { ...DEFAULT_JOIST_RAFTER_SETTINGS };
  try {
    const parsed = JSON.parse(json) as Partial<JoistRafterSettings>;
    const size = parsed.framingSize;
    return { framingSize: (FRAMING_SIZES as readonly string[]).includes(size ?? "") ? (size as FramingSize) : DEFAULT_JOIST_RAFTER_SETTINGS.framingSize };
  } catch {
    return { ...DEFAULT_JOIST_RAFTER_SETTINGS };
  }
}

export function serializeJoistRafterSettings(settings: JoistRafterSettings): string {
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
 *  segment start) and `endMm` (at the segment end). If `gable` is set, the top plate instead rises
 *  from `startMm` to the apex `middleMm` at arc-length `middlePositionMm` from the segment start
 *  (default the segment midpoint when absent — back-compat with rakes saved before this field
 *  existed), then falls to `endMm`. */
export interface Rake {
  segmentIndex: number;
  startMm: number;
  endMm: number;
  gable?: boolean;
  middleMm?: number;
  middlePositionMm?: number;
}

/** The gable apex's arc-length (mm) from the segment start — `rake.middlePositionMm` if set,
 *  otherwise the segment midpoint (the only behaviour before the apex-position field existed). */
export function rakeApexMm(rake: Pick<Rake, "middlePositionMm">, segLenMm: number): number {
  return rake.middlePositionMm ?? segLenMm / 2;
}

/** A manually-placed extra stud on a wall segment (select-mode Ctrl-hover), at arc-length `centreMm`. */
export interface ExtraStud {
  segmentIndex: number;
  centreMm: number;
}

/** A stud that has been doubled up (a sister stud nailed alongside it). Identified by the
 *  arc-length of the primary stud's centre along its segment. */
export interface DoubledStud {
  segmentIndex: number;
  centreMm: number;
}

/** Per-wall framing extras (measurements.framing_json). */
export interface WallFraming {
  openings: Opening[];
  rakes: Rake[];
  extraStuds: ExtraStud[];
  /** Individual studs selected for doubling. */
  doubledStuds?: DoubledStud[];
  /** When true every regular stud in the wall is doubled (supersedes doubledStuds). */
  doubleAllStuds?: boolean;
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
      doubledStuds: Array.isArray(parsed.doubledStuds) ? parsed.doubledStuds : undefined,
      doubleAllStuds: parsed.doubleAllStuds ?? undefined,
    };
  } catch {
    return { openings: [], rakes: [], extraStuds: [] };
  }
}

/** Returns true when the stud at (segmentIndex, centreMm) should be doubled. */
export function isStudDoubled(framing: WallFraming | undefined, segmentIndex: number, centreMm: number): boolean {
  if (!framing) return false;
  if (framing.doubleAllStuds) return true;
  if (!framing.doubledStuds?.length) return false;
  return framing.doubledStuds.some((d) => d.segmentIndex === segmentIndex && Math.abs(d.centreMm - centreMm) < 0.5);
}

/** Enumerates every anchor + regular stud centre (segmentIndex, centreMm) for a wall path.
 *  Used by the "select studs to double" interaction to hit-test which stud the cursor is on. */
export function wallStudPositions(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number,
): { segmentIndex: number; centreMm: number }[] {
  const depthPts = framingDepthMm(settings.framingSize) / mmPerPoint;
  const studThkPts = STUD_THICKNESS_MM / mmPerPoint;
  const spacingPts = Math.max(settings.studSpacingMm, 1) / mmPerPoint;
  const gapPts = cornerGapMm(settings.framingSize) / mmPerPoint;
  const layout = studLayout(path, depthPts, studThkPts, spacingPts, gapPts);
  const positions: { segmentIndex: number; centreMm: number }[] = [];
  layout.forEach((seg, segIndex) => {
    for (const s of [...seg.anchors, ...seg.regular]) {
      positions.push({ segmentIndex: segIndex, centreMm: s * mmPerPoint });
    }
  });
  return positions;
}

export function serializeWallFraming(framing: WallFraming): string {
  return JSON.stringify(framing);
}

// ---------------------------------------------------------------------------------------------
// Vertex insertion/deletion re-keying — a wall's Opening/Rake/ExtraStud/DoubledStud entries are
// keyed by segmentIndex + a local arc-length in mm along that specific segment. Inserting or
// removing a polyline point shifts/merges segments, so anything keyed by segmentIndex must be
// re-based alongside the geometry edit — otherwise it silently points at the wrong segment with a
// meaningless local offset (the cause of a real bug report: a door placed on a wall that was later
// split for raking-frame apex control ended up with corrupted king/jack studs).
// ---------------------------------------------------------------------------------------------

export interface ReindexResult {
  framing: WallFraming;
  /** User-facing notes about entries that couldn't be re-based unambiguously (e.g. an opening
   *  whose footprint straddled the split/merge point, or a rake dropped on merge). */
  warnings: string[];
}

function segLenMmBetween(a: PagePoint, b: PagePoint, mmPerPoint: number): number {
  return Math.hypot(b.x - a.x, b.y - a.y) * mmPerPoint;
}

/** Re-bases a (segmentIndex, centreMm) entry that sits on the segment being split at `splitMm`. */
function splitPointEntry<T extends { segmentIndex: number; centreMm: number }>(entry: T, splitSegmentIndex: number, splitMm: number): T {
  if (entry.segmentIndex < splitSegmentIndex) return entry;
  if (entry.segmentIndex > splitSegmentIndex) return { ...entry, segmentIndex: entry.segmentIndex + 1 };
  return entry.centreMm < splitMm ? entry : { ...entry, segmentIndex: entry.segmentIndex + 1, centreMm: entry.centreMm - splitMm };
}

/** Height (mm) at arc-length `s` along a rake's start->[apex]->end slope. */
function rakeHeightAt(rake: Rake, s: number, segLenMm: number): number {
  if (rake.gable && rake.middleMm !== undefined) {
    const apexMm = rakeApexMm(rake, segLenMm);
    if (apexMm <= 0) return rake.middleMm;
    if (apexMm >= segLenMm) return rake.startMm + (rake.middleMm - rake.startMm) * (s / segLenMm);
    return s <= apexMm
      ? rake.startMm + (rake.middleMm - rake.startMm) * (s / apexMm)
      : rake.middleMm + (rake.endMm - rake.middleMm) * ((s - apexMm) / (segLenMm - apexMm));
  }
  return segLenMm > 0 ? rake.startMm + (rake.endMm - rake.startMm) * (s / segLenMm) : rake.startMm;
}

/** Splits a `Rake` spanning the segment being divided at `splitMm` into two rakes for the new
 *  sub-segments. A gable's apex lands wholly in one sub-segment (re-based to its local origin);
 *  the other sub-segment becomes a plain slope from/to the split height. */
function splitRakeEntry(rake: Rake, splitSegmentIndex: number, splitMm: number, oldSegLenMm: number): Rake[] {
  if (rake.segmentIndex < splitSegmentIndex) return [rake];
  if (rake.segmentIndex > splitSegmentIndex) return [{ ...rake, segmentIndex: rake.segmentIndex + 1 }];

  const hSplit = rakeHeightAt(rake, splitMm, oldSegLenMm);
  const first: Rake = { segmentIndex: splitSegmentIndex, startMm: rake.startMm, endMm: hSplit };
  const second: Rake = { segmentIndex: splitSegmentIndex + 1, startMm: hSplit, endMm: rake.endMm };

  if (!rake.gable || rake.middleMm === undefined) return [first, second];

  const apexMm = rakeApexMm(rake, oldSegLenMm);
  if (splitMm <= apexMm) {
    // Apex stays on the second sub-segment, re-based to its local origin.
    second.gable = true;
    second.middleMm = rake.middleMm;
    second.middlePositionMm = apexMm - splitMm;
  } else {
    // Apex stays on the first sub-segment; its position is already local to it.
    first.gable = true;
    first.middleMm = rake.middleMm;
    first.middlePositionMm = apexMm;
  }
  return [first, second];
}

/** Re-keys a wall's framing extras after a vertex is inserted at `insertSegmentIndex + 1`
 *  (splitting the old segment `insertSegmentIndex` into two). `path` is the geometry BEFORE the
 *  insertion. Entries that already existed before the edit keep meaning; nothing is silently
 *  corrupted. */
export function reindexFramingForVertexInsertion(
  framing: WallFraming,
  path: PagePoint[],
  insertSegmentIndex: number,
  insertPoint: PagePoint,
  mmPerPoint: number,
): ReindexResult {
  const warnings: string[] = [];
  const a = path[insertSegmentIndex];
  const b = path[insertSegmentIndex + 1];
  if (!a || !b || !(mmPerPoint > 0)) return { framing, warnings };

  const splitMm = segLenMmBetween(a, insertPoint, mmPerPoint);
  const oldSegLenMm = segLenMmBetween(a, b, mmPerPoint);

  const openings = framing.openings.map((o) => {
    if (o.segmentIndex === insertSegmentIndex) {
      const half = o.daylightWidthMm / 2;
      if (o.centreMm - half < splitMm && o.centreMm + half > splitMm) {
        warnings.push(`The ${o.kind} near the new point may need repositioning.`);
      }
    }
    return splitPointEntry(o, insertSegmentIndex, splitMm);
  });
  const extraStuds = framing.extraStuds.map((e) => splitPointEntry(e, insertSegmentIndex, splitMm));
  const doubledStuds = framing.doubledStuds?.map((d) => splitPointEntry(d, insertSegmentIndex, splitMm));
  const rakes = framing.rakes.flatMap((r) => splitRakeEntry(r, insertSegmentIndex, splitMm, oldSegLenMm));

  return { framing: { ...framing, openings, rakes, extraStuds, doubledStuds }, warnings };
}

/** Re-keys a wall's framing extras after the vertex at `deleteVertexIndex` is removed. An interior
 *  vertex merges its two adjacent segments into one (segment `deleteVertexIndex - 1`); an endpoint
 *  vertex removes the extremal segment outright. `path` is the geometry BEFORE the deletion. */
export function reindexFramingForVertexDeletion(
  framing: WallFraming,
  path: PagePoint[],
  deleteVertexIndex: number,
  mmPerPoint: number,
): ReindexResult {
  const warnings: string[] = [];
  const isEndpoint = deleteVertexIndex <= 0 || deleteVertexIndex >= path.length - 1;

  if (isEndpoint) {
    // The extremal segment (the one that had this vertex as one of its ends) disappears entirely.
    const removedSegmentIndex = deleteVertexIndex === 0 ? 0 : path.length - 2;
    const hasEntry = (segmentIndex: number) => segmentIndex === removedSegmentIndex;
    if (
      framing.openings.some((o) => hasEntry(o.segmentIndex)) ||
      framing.rakes.some((r) => hasEntry(r.segmentIndex)) ||
      framing.extraStuds.some((e) => hasEntry(e.segmentIndex)) ||
      framing.doubledStuds?.some((d) => hasEntry(d.segmentIndex))
    ) {
      warnings.push("An opening, rake, or extra stud on the removed end of the wall was deleted with it.");
    }
    const shift = (segmentIndex: number) => (removedSegmentIndex === 0 ? segmentIndex - 1 : segmentIndex);
    const keep = <T extends { segmentIndex: number }>(entries: T[]): T[] =>
      entries.filter((e) => !hasEntry(e.segmentIndex)).map((e) => ({ ...e, segmentIndex: shift(e.segmentIndex) }));
    return {
      framing: {
        ...framing,
        openings: keep(framing.openings),
        rakes: keep(framing.rakes),
        extraStuds: keep(framing.extraStuds),
        doubledStuds: framing.doubledStuds ? keep(framing.doubledStuds) : undefined,
      },
      warnings,
    };
  }

  // Interior vertex: merge old segments (v-1) and v into new segment (v-1); shift everything after.
  const v = deleteVertexIndex;
  const mergedIndex = v - 1;
  const lenBeforeMm = segLenMmBetween(path[v - 1], path[v], mmPerPoint);

  const mergePointEntry = <T extends { segmentIndex: number; centreMm: number }>(entry: T): T => {
    if (entry.segmentIndex < mergedIndex) return entry;
    if (entry.segmentIndex === mergedIndex) return entry; // was on segment v-1, origin unchanged
    if (entry.segmentIndex === v) return { ...entry, segmentIndex: mergedIndex, centreMm: entry.centreMm + lenBeforeMm };
    return { ...entry, segmentIndex: entry.segmentIndex - 1 };
  };

  const openings = framing.openings.map(mergePointEntry);
  const extraStuds = framing.extraStuds.map(mergePointEntry);
  const doubledStuds = framing.doubledStuds?.map(mergePointEntry);

  const rakeBefore = framing.rakes.find((r) => r.segmentIndex === mergedIndex);
  const rakeAfter = framing.rakes.find((r) => r.segmentIndex === v);
  const otherRakes = framing.rakes
    .filter((r) => r.segmentIndex !== mergedIndex && r.segmentIndex !== v)
    .map((r) => (r.segmentIndex > v ? { ...r, segmentIndex: r.segmentIndex - 1 } : r));

  const rakes = [...otherRakes];
  if (rakeBefore && rakeAfter) {
    const continuous = Math.abs(rakeBefore.endMm - rakeAfter.startMm) < 1;
    if (continuous && !rakeBefore.gable && !rakeAfter.gable) {
      rakes.push({ segmentIndex: mergedIndex, startMm: rakeBefore.startMm, endMm: rakeAfter.endMm });
    } else {
      warnings.push("Rake cleared on the merged segment — please re-set the raking frame for this wall.");
    }
  } else if (rakeBefore || rakeAfter) {
    warnings.push("Rake cleared on the merged segment — please re-set the raking frame for this wall.");
  }

  return { framing: { ...framing, openings, rakes, extraStuds, doubledStuds }, warnings };
}

// ---------------------------------------------------------------------------------------------
// Straight-wall geometry (M2). All inputs/outputs in PDF points (Y-up) unless noted.
// ---------------------------------------------------------------------------------------------

/** Rendered framing geometry for one wall: the two plate outlines and the stud rectangles. */
export interface FramingGeometry {
  /** The two parallel plate edges (centre path offset ±depth/2). */
  plateLeft: PagePoint[];
  plateRight: PagePoint[];
  /** Each stud as its 4 corners (PDF points, ordered for a closed rectangle), plus whether it's a
   *  continuous full-height member (regular stud/king — drawn with a corner-to-corner cross) or a
   *  non-continuous one interrupted by an opening (trimmer/jack — drawn with a single diagonal,
   *  the standard architectural symbol for a non-continuous member). */
  studs: { rect: PagePoint[]; continuous: boolean }[];
  studCount: number;
  /** Door/window daylight openings (the rectangular gap in the wall), for rendering. Carries the
   *  opening's own (segmentIndex, centreMm) back so callers (the canvas hover card) can hit-test
   *  this exact rect and then look up the source Opening / its wallMembers()-tagged framing. */
  openings: { daylight: PagePoint[]; kind: "door" | "window"; segmentIndex: number; centreMm: number }[];
}

const GEOM_EPS = 1e-6;

/** Removes near-duplicate arc-length positions (within `tolerancePts`) from a list of candidate
 *  stud centres. Anchor/gable-apex candidates and the regular grid are computed independently and
 *  can coincidentally land on (or within a fraction of a mm of) the same position — e.g. a gable
 *  apex offset by half a stud thickness landing exactly on a 400mm grid line — which would
 *  otherwise push the same physical stud twice into the takeoff. Order-preserving: the first
 *  occurrence of a cluster is kept. */
function dedupePositions(positions: number[], tolerancePts: number): number[] {
  const kept: number[] = [];
  for (const p of positions) {
    if (!kept.some((k) => Math.abs(k - p) < tolerancePts)) kept.push(p);
  }
  return kept;
}

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
 * Number of stud-thickness-wide (45 mm) packer blocks that pack out the corner sheet-fixing gap
 * between corner studs 2 and 3 (docs/corner makeup.png) — one per wall depth increment: 1 for
 * 90×45, 2 for 140×45, up to 5 for 290×45. Zero for 45×45 — a wall that thin has no gap to pack at
 * all, so the corner is just 3 studs meeting flush (docs/corner makeup 45mm.png).
 */
export function cornerPackerCount(size: FramingSize): number {
  const depthMm = framingDepthMm(size);
  if (depthMm <= STUD_THICKNESS_MM) return 0;
  return Math.round((depthMm - 90) / 50) + 1;
}

/**
 * Corner sheet-fixing gap (mm) between corner studs 2 and 3 — sized to exactly fit
 * `cornerPackerCount` 45 mm-wide packer blocks with no leftover sliver (builders pack this gap
 * out with whole blocking, not a part-filled gap), rather than the raw depth − stud-thickness
 * distance. Stud 3 sits this far from stud 2, which lands its outer face at (or, for framing
 * deeper than 90×45, up to ~20 mm short of) the wall's internal corner. Equals 45 mm for a 90×45
 * wall (the docs example, an exact match with depth − thickness), 90 mm for 140×45 (depth −
 * thickness would be 95 mm — deliberately shorted to a whole packer multiple), and 0 for 45×45
 * (studs 2 and 3 sit flush against each other — a plain 3-stud corner, no packing needed). See
 * docs/corner makeup.png.
 */
export function cornerGapMm(size: FramingSize): number {
  return cornerPackerCount(size) * STUD_THICKNESS_MM;
}

/** Length (mm) of a solid corner packer block — see `cornerPackerCount`. Always 300 mm regardless
 *  of framing size; a deeper wall packs more of them side by side (`cornerPackerCount`), never a
 *  taller block. */
export const PACKER_LENGTH_MM = 300;

/** Per-segment stud set-out: `a`/`dir`/`segLen` plus the arc-length centres of the `anchor` studs
 *  (flush ends + the NZ 3-stud corner makeup, always present) and the `regular` infill studs
 *  (subject to being cut by openings). Shared by geometry and the quantity calc so they agree.
 *  `startCorner`/`endCorner` indicate that the respective end connects to an adjacent segment at a
 *  real angle (not collinear), so plates need to extend by halfDepth to fill the corner. */
export interface SegLayout {
  a: PagePoint;
  dir: PagePoint;
  segLen: number;
  anchors: number[];
  regular: number[];
  startCorner: boolean;
  endCorner: boolean;
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

  // Direction of each path segment (or null if degenerate), used to tell a real corner (the NZ
  // 3-stud makeup applies) from a straight-through joint — e.g. where a rake/gable meets an
  // adjacent flat (or differently-raked) collinear segment, which just wants a single end stud
  // on each side following its own segment's height.
  const dirs: ({ x: number; y: number } | null)[] = [];
  for (let seg = 0; seg < n - 1; seg += 1) {
    const a = path[seg];
    const b = path[seg + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    dirs.push(len < GEOM_EPS ? null : { x: dx / len, y: dy / len });
  }
  const collinear = (d1: { x: number; y: number } | null, d2: { x: number; y: number } | null) =>
    !!d1 && !!d2 && d1.x * d2.x + d1.y * d2.y > 1 - 1e-6;

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
    const startStraight = !isFirst && collinear(dirs[seg - 1], dirs[seg]);
    const endStraight = !isLast && collinear(dirs[seg], dirs[seg + 1]);
    const startStuds = isFirst || startStraight
      ? [halfThk]
      : [-halfDepth + halfThk, -halfDepth + studThkPts + gapPts + halfThk];
    const endStuds = isLast || endStraight ? [segLen - halfThk] : [segLen - halfDepth - halfThk];

    const regular: number[] = [];
    const regularFrom = startStuds[startStuds.length - 1];
    const regularTo = endStuds[0];
    for (let s = regularFrom + spacingPts; s < regularTo - GEOM_EPS; s += spacingPts) regular.push(s);

    out.push({ a, dir, segLen, anchors: [...startStuds, ...endStuds], regular, startCorner: !isFirst && !startStraight, endCorner: !isLast && !endStraight });
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

/** Point-in-convex-polygon test (used to test a stud position against an opening's expanded
 *  footprint, possibly belonging to an adjacent wall segment). */
function pointInRect(p: PagePoint, rect: PagePoint[]): boolean {
  let sign = 0;
  for (let i = 0; i < rect.length; i += 1) {
    const a = rect[i];
    const b = rect[(i + 1) % rect.length];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross !== 0) {
      const s = Math.sign(cross);
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
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
  const rakes = framing?.rakes ?? [];

  const studs: { rect: PagePoint[]; continuous: boolean }[] = [];
  const openingRects: { daylight: PagePoint[]; kind: "door" | "window"; segmentIndex: number; centreMm: number }[] = [];

  const halfDepthForCut = halfDepth;
  // Only for a DIFFERENT segment's opening reaching into this one at a corner (a corner-makeup
  // anchor can sit at negative `s`/beyond `segLen`, physically overlapping the adjacent segment's
  // footprint) — the wider (+2 stud thicknesses) tolerance accounts for the anchor's own physical
  // width, not just its centreline. The current segment's own opening is handled precisely by the
  // exact-daylight-width check in `cut()`, so it's excluded here to avoid over-cutting studs that
  // sit just outside the door but were being caught a second time by this looser margin.
  const nearAnyOpening = (p: PagePoint, ownSegmentIndex: number): boolean => {
    for (let j = 0; j < layout.length; j += 1) {
      if (j === ownSegmentIndex) continue;
      const segJ = layout[j];
      for (const o of openings.filter((op) => op.segmentIndex === j)) {
        const c = o.centreMm / mmPerPoint;
        const dh = o.daylightWidthMm / mmPerPoint / 2;
        const rect = memberRect(segJ, c - dh - 2 * studThkPts, c + dh + 2 * studThkPts, halfDepthForCut + depthPts);
        if (pointInRect(p, rect)) return true;
      }
    }
    return false;
  };

  const dedupeTolPts = 1 / mmPerPoint; // 1mm — anchor/gable-apex candidates and the regular grid are
  // computed independently and can coincidentally land on (or within a fraction of a mm of) the
  // same position, which would otherwise draw/count the same physical stud twice.

  layout.forEach((seg, segIndex) => {
    const segOpenings = openings.filter((o) => o.segmentIndex === segIndex);
    // King and trimmer jamb positions, each merged only within their own kind — mirrors the same
    // rule in `wallMembers` (never merge a king with a trimmer just because they land close
    // together; two openings whose kings coincide are still only drawn once) so the plan-view
    // overlay matches the 3D view and the takeoff quantities instead of drawing duplicate/
    // overlapping rects for every opening independently.
    const kingXs: number[] = [];
    const trimmerXs: number[] = [];
    for (const o of segOpenings) {
      const centrePts = o.centreMm / mmPerPoint;
      const dwHalf = o.daylightWidthMm / mmPerPoint / 2;
      const jambs = openingJambs(centrePts, dwHalf, studThkPts);
      for (const k of jambs.kings) if (!kingXs.some((x) => Math.abs(x - k) < dedupeTolPts)) kingXs.push(k);
      for (const t of jambs.trimmers) if (!trimmerXs.some((x) => Math.abs(x - t) < dedupeTolPts)) trimmerXs.push(t);
    }

    // Cut (and, below, overlap-priority) tests — see `wallMembers` for the fuller rationale: a
    // generic stud within half a stud thickness of a king/trimmer is a duplicate/overlapping
    // timber, since the opening's jamb — already load-bearing for its lintel — takes its place.
    const cut = (s: number) =>
      segOpenings.some((o) => Math.abs(s - o.centreMm / mmPerPoint) <= o.daylightWidthMm / mmPerPoint / 2) ||
      nearAnyOpening(pointAt(seg, s), segIndex) ||
      kingXs.some((x) => Math.abs(s - x) < studThkPts / 2) ||
      trimmerXs.some((x) => Math.abs(s - x) < studThkPts / 2);
    // Sister stud offset: toward wall interior — positive in the first half, negative in the second.
    const sisterOffset = (s: number) => (s < seg.segLen / 2 ? studThkPts : -studThkPts);
    const rake = rakes.find((r) => r.segmentIndex === segIndex);
    const gableApexS = rake?.gable && rake.middleMm !== undefined
      ? [rakeApexMm(rake, seg.segLen * mmPerPoint) / mmPerPoint - halfThk, rakeApexMm(rake, seg.segLen * mmPerPoint) / mmPerPoint + halfThk]
      : [];
    // A regular grid stud whose footprint overlaps the apex pair AT ALL (full stud thickness, not
    // just half) is dropped in favour of it — see `wallMembers` for the fuller rationale.
    const regularClearOfApex = seg.regular.filter((r) => !gableApexS.some((a) => Math.abs(a - r) < studThkPts));
    const allCandidates = dedupePositions([...seg.anchors, ...gableApexS, ...regularClearOfApex], dedupeTolPts);
    const notCut = allCandidates.filter((s) => !cut(s));
    const sisterPositions = notCut
      .filter((s) => isStudDoubled(framing, segIndex, s * mmPerPoint))
      .map((s) => s + sisterOffset(s));

    // Jack stud positions: regular-grid candidates that land inside an opening's own daylight width
    // — cut from the continuous stud run by the opening, but present in real framing as a cripple
    // ("jack") above the lintel (and, for a window, a matching sill jack below the sill, at the same
    // plan position) — mirrors `jackGridPositions` in `wallMembers`. Non-continuous in plan (single
    // diagonal), unlike a king or a full-height regular stud.
    const jackXs = allCandidates.filter((s) =>
      segOpenings.some((o) => Math.abs(s - o.centreMm / mmPerPoint) <= o.daylightWidthMm / mmPerPoint / 2),
    );

    // Unlike `wallMembers` (which correctly keeps a king and a trimmer from two DIFFERENT openings
    // as separate members when they land close together, since they occupy different HEIGHTS — a
    // door's trimmer runs to its own lintel while a window's king above continues to the ceiling), a
    // flat plan view has no height axis to tell them apart: any two footprints within half a stud
    // thickness of each other are, on this page, the same visible stud, and drawing both produces
    // the crossed/overlapping-rect artefact reported by QA. So here (only) they're deduped into one
    // rect regardless of which requirement produced them.
    const finalXs: { x: number; continuous: boolean }[] = [];
    const addFinal = (x: number, continuous: boolean) => {
      if (!finalXs.some((f) => Math.abs(f.x - x) < studThkPts / 2)) finalXs.push({ x, continuous });
    };
    // Kings and full-height regular studs are continuous; trimmers and jacks are interrupted by the
    // opening they jamb/cripple, so they get the non-continuous (single-diagonal) symbol.
    for (const x of kingXs) addFinal(x, true);
    for (const x of trimmerXs) addFinal(x, false);
    for (const s of notCut) {
      if (sisterPositions.some((sx) => Math.abs(sx - s) < studThkPts / 2)) continue;
      addFinal(s, true);
      if (isStudDoubled(framing, segIndex, s * mmPerPoint)) addFinal(s + sisterOffset(s), true);
    }
    for (const x of jackXs) addFinal(x, false);
    for (const f of finalXs) studs.push({ rect: makeStudRect(pointAt(seg, f.x), seg.dir, halfThk, halfDepth), continuous: f.continuous });

    for (const o of segOpenings) {
      const centrePts = o.centreMm / mmPerPoint;
      const dwHalf = o.daylightWidthMm / mmPerPoint / 2;
      openingRects.push({ daylight: memberRect(seg, centrePts - dwHalf, centrePts + dwHalf, halfDepth), kind: o.kind, segmentIndex: o.segmentIndex, centreMm: o.centreMm });
    }
  });

  for (const es of framing?.extraStuds ?? []) {
    const rect = extraStudRect(path, settings, mmPerPoint, es.segmentIndex, es.centreMm);
    if (rect) studs.push({ rect, continuous: true });
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
  | "packer"
  | "king"
  | "trimmer"
  | "lintel"
  | "jack"
  | "sill"
  | "sill_jack";

const KIND_ORDER: FramingComponentKind[] = ["plate", "stud", "dwang", "packer", "king", "trimmer", "lintel", "jack", "sill", "sill_jack"];
const KIND_LABEL: Record<FramingComponentKind, string> = {
  plate: "Plates",
  stud: "Studs",
  packer: "Packers",
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
 *  `sizeOverride` is always present on lintel rows (the lintel's own framing size). */
export interface FramingComponent {
  kind: FramingComponentKind;
  /** Always present on lintel rows — the lintel's framing size. Absent for all other member kinds. */
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
  /** Lintel-only: the lintel's FramingSize (always set for lintels, absent for all other kinds). */
  sizeOverride?: FramingSize;
  /** Which input-path segment (0-based, between path[i] and path[i+1]) generated this member.
   *  Purely informational metadata — never read by the quantity/rollup math itself — so a
   *  per-segment breakdown (e.g. the canvas hover card) can filter the one true member list
   *  instead of re-deriving a synthetic sub-wall that would lose corner-makeup context. */
  segmentIndex: number;
  /** Set only on king/trimmer/jack/sill_jack/lintel/sill members — identifies the specific
   *  opening this piece belongs to, by (segmentIndex, centreMm) (same identity scheme as
   *  Rake/ExtraStud/DoubledStud). Lets the hover card show "this door/window's own framing"
   *  without an array-index that would drift when opening lists get filtered/re-derived. */
  openingSegmentIndex?: number;
  openingCentreMm?: number;
  lengthM: number;
  position: [number, number, number];
  size: [number, number, number]; // [along, vertical thickness/height, depth across the wall]
  yaw: number;
  pitch: number;
  /** Rake/plumb-cut override: a quad cross-section in the local X (along-wall, metres from
   *  `position`) / Y (world height, metres) plane, extruded `depthM` along local Z (across the
   *  wall). When present this replaces the box geometry for rendering — `position` is the local
   *  origin (ground level at the cut piece's start point) and `pitch` is ignored. Used for studs
   *  whose tops are rake-cut to the underside of a sloped top plate, and for top-plate pieces
   *  whose ends are plumb-cut to the full wall length. */
  wedge?: { quad: [number, number][]; depthM: number };
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
    if (!rake) return settings.wallHeightMm;
    const f = Math.max(0, Math.min(1, frac));
    if (rake.gable && rake.middleMm !== undefined) {
      const segLenMm = (layout[segIndex]?.segLen ?? 0) * mmPerPoint;
      const apexF = segLenMm > 0 ? Math.max(0, Math.min(1, rakeApexMm(rake, segLenMm) / segLenMm)) : 0.5;
      return f <= apexF
        ? rake.startMm + (rake.middleMm - rake.startMm) * (apexF > 0 ? f / apexF : 0)
        : rake.middleMm + (rake.endMm - rake.middleMm) * (apexF < 1 ? (f - apexF) / (1 - apexF) : 0);
    }
    return rake.startMm + (rake.endMm - rake.startMm) * f;
  };

  // Corner-makeup anchors of one segment can sit at negative `s` (or beyond `segLen`), physically
  // overlapping the footprint of an ADJACENT segment. These two helpers test a world point against
  // every OTHER segment's openings/roofline, so cuts and head-height caps work across the corner.
  // The current segment's own opening is excluded here — it's handled precisely by the exact
  // daylight-width check in `cut()` below, so re-testing it with this wider (+2 stud thicknesses,
  // to account for a corner anchor's own physical width) margin would over-cut studs that sit just
  // outside the door but not actually within it.
  const halfDepthPts = depthPts / 2;
  const nearAnyOpening = (p: PagePoint, ownSegmentIndex: number): boolean => {
    for (let j = 0; j < layout.length; j += 1) {
      if (j === ownSegmentIndex) continue;
      const segJ = layout[j];
      for (const o of openings.filter((op) => op.segmentIndex === j)) {
        const c = o.centreMm / mmPerPoint;
        const dh = o.daylightWidthMm / mmPerPoint / 2;
        const rect = memberRect(segJ, c - dh - 2 * studThkPts, c + dh + 2 * studThkPts, halfDepthPts + depthPts);
        if (pointInRect(p, rect)) return true;
      }
    }
    return false;
  };
  /** The lowest underside-of-top-plate height (mm) of any segment whose footprint covers `p`. Falls
   *  back to the plain wall height when no segment's footprint covers `p` at all — e.g. a wall
   *  resized shorter than an opening still on it leaves the opening's king/trimmer positions
   *  outside every segment's arc-length range. Returning `Infinity` there (the old behaviour) would
   *  propagate into a member's `yT`, then into the dwang-row loop's upper bound below, running it
   *  forever (a real crash: `for (h = ...; h <= maxTop; h += centresMm)` never terminates against
   *  `Infinity`) — always returning a finite height keeps every downstream computation bounded. */
  const ceilingMmAt = (p: PagePoint): number => {
    let min = Infinity;
    layout.forEach((segJ, j) => {
      if (segJ.segLen <= 0) return;
      const dx = p.x - segJ.a.x;
      const dy = p.y - segJ.a.y;
      const s = dx * segJ.dir.x + dy * segJ.dir.y;
      const perp = -dx * segJ.dir.y + dy * segJ.dir.x;
      if (Math.abs(perp) <= halfDepthPts + studThkPts && s >= -depthPts && s <= segJ.segLen + depthPts) {
        const frac = Math.max(0, Math.min(1, s / segJ.segLen));
        min = Math.min(min, heightAt(j, frac) - topMakeup);
      }
    });
    return Number.isFinite(min) ? min : settings.wallHeightMm - topMakeup;
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
    // The gable apex's arc-length position — distinct from `midS` (the true geometric segment
    // midpoint, used for plate corner-extension centring, which must NOT move with the apex).
    const apexS = rake?.gable && rake.middleMm !== undefined ? rakeApexMm(rake, segRunMm) / mmPerPoint : midS;

    // Vertical member (stud-like): records it for the dwang pass and emits its box. When
    // `rakeCut` is set on a raked segment, the top is cut to the underside of the sloped top
    // plate instead of being flat (a wedge in place of a box).
    const verticals: { x: number; yB: number; yT: number }[] = [];
    // Sister stud offset: always toward wall interior so end studs double inward, not outside plates.
    const sisterOffset = (s: number) => (s < seg.segLen / 2 ? studThkPts : -studThkPts);
    const addV = (
      kind: FramingComponentKind,
      s: number,
      yB: number,
      yT: number,
      rakeCut = false,
      // Which opening this member belongs to (king/trimmer/jack/sill_jack only) — identified the
      // same way as Rake/ExtraStud/DoubledStud elsewhere in this file, by (segmentIndex, centreMm)
      // rather than an array index, since filtered/derived opening lists don't share index space
      // with the caller's own `WallFraming.openings`. Purely metadata forwarded onto the pushed
      // member; never read by the quantity/rollup math itself.
      openingId?: { segmentIndex: number; centreMm: number },
    ) => {
      if (yT - yB <= 0) return;
      verticals.push({ x: s, yB, yT });
      if (rakeCut && rake && seg.segLen > 0) {
        const sLeft = s - studThkPts / 2;
        const sRight = s + studThkPts / 2;
        // A stud's jamb offset (king/jack) can overshoot this segment's own length near a short
        // boundary segment (e.g. one carved out purely to carry a gable apex) — look up the
        // roofline at its true physical position across all segments (like `ceilingMmAt` already
        // does for the non-rake-cut branch below) instead of clamping to this segment's own rake,
        // which would silently under- or over-cut the member.
        const yTopLeft = ceilingMmAt(pointAt(seg, sLeft));
        const yTopRight = ceilingMmAt(pointAt(seg, sRight));
        if (Math.min(yTopLeft, yTopRight) - yB <= 0) return;
        const quad: [number, number][] = [
          [0, M(yB)],
          [thkM, M(yB)],
          [thkM, M(yTopRight)],
          [0, M(yTopLeft)],
        ];
        members.push({
          kind,
          segmentIndex: segIndex,
          ...(openingId ? { openingSegmentIndex: openingId.segmentIndex, openingCentreMm: openingId.centreMm } : {}),
          lengthM: M((yTopLeft + yTopRight) / 2 - yB),
          position: [fx(sLeft), 0, fz(sLeft)],
          size: [thkM, M(Math.max(yTopLeft, yTopRight) - yB), depthM],
          yaw,
          pitch: 0,
          wedge: { quad, depthM },
        });
        // Sister doubled stud — pushed to verticals so dwangs space from it, not the primary.
        if (kind === "stud" && isStudDoubled(framing, segIndex, s * mmPerPoint)) {
          const sD = s + sisterOffset(s);
          verticals.push({ x: sD, yB, yT });
          const sLeftD = sD - studThkPts / 2;
          const sRightD = sD + studThkPts / 2;
          const yTL = ceilingMmAt(pointAt(seg, sLeftD));
          const yTR = ceilingMmAt(pointAt(seg, sRightD));
          if (Math.min(yTL, yTR) - yB > 0) {
            const quadD: [number, number][] = [[0, M(yB)], [thkM, M(yB)], [thkM, M(yTR)], [0, M(yTL)]];
            members.push({ kind: "stud", segmentIndex: segIndex, lengthM: M((yTL + yTR) / 2 - yB), position: [fx(sLeftD), 0, fz(sLeftD)], size: [thkM, M(Math.max(yTL, yTR) - yB), depthM], yaw, pitch: 0, wedge: { quad: quadD, depthM } });
          }
        }
        return;
      }
      // Cap a plain (non-rake-cut) member's top to whichever segment's roofline is lowest at its
      // position — corner studs/kings on a flat segment must not poke above an adjacent raked
      // segment's lower top plate at a shared corner.
      const cappedYT = Math.min(yT, ceilingMmAt(pointAt(seg, s)));
      if (cappedYT - yB <= 0) return;
      members.push({
        kind,
        segmentIndex: segIndex,
        ...(openingId ? { openingSegmentIndex: openingId.segmentIndex, openingCentreMm: openingId.centreMm } : {}),
        lengthM: M(cappedYT - yB),
        position: [fx(s), M((yB + cappedYT) / 2), fz(s)],
        size: [thkM, M(cappedYT - yB), depthM],
        yaw,
        pitch: 0,
      });
      // Sister doubled stud — pushed to verticals so dwangs space from it, not the primary.
      if (kind === "stud" && isStudDoubled(framing, segIndex, s * mmPerPoint)) {
        const sD = s + sisterOffset(s);
        verticals.push({ x: sD, yB, yT });
        const cappedYTD = Math.min(yT, ceilingMmAt(pointAt(seg, sD)));
        if (cappedYTD - yB > 0) {
          members.push({ kind: "stud", segmentIndex: segIndex, lengthM: M(cappedYTD - yB), position: [fx(sD), M((yB + cappedYTD) / 2), fz(sD)], size: [thkM, M(cappedYTD - yB), depthM], yaw, pitch: 0 });
        }
      }
    };

    // Plates (bottom flat; top sloped + pitched on a rake).
    // Extend plates by halfDepth at each corner end so they cover the corner-makeup area of the
    // adjacent segment — without this, the corner makeup studs poke out beyond the plate face.
    const plateStartExtPts = seg.startCorner ? halfDepthPts : 0;
    const plateEndExtPts = seg.endCorner ? halfDepthPts : 0;
    const plateTotalPts = seg.segLen + plateStartExtPts + plateEndExtPts;
    const plateMidS = (plateEndExtPts - plateStartExtPts) / 2 + midS;
    const plateLenM = plateTotalPts * S;
    for (let l = 0; l < bottomLayers; l += 1) {
      members.push({ kind: "plate", segmentIndex: segIndex, lengthM: plateLenM, position: [fx(plateMidS), M(l * STUD_THICKNESS_MM + STUD_THICKNESS_MM / 2), fz(plateMidS)], size: [plateLenM, thkM, depthM], yaw, pitch: 0 });
    }
    // Top plate(s): one sloped piece spanning the segment, or (for a gable) two pieces meeting at
    // the apex (`middleMm`) at `apexS` (the segment midpoint unless `middlePositionMm` overrides it).
    const topPieces =
      rake?.gable && rake.middleMm !== undefined
        ? [
            { s0: 0, s1: apexS, h0: startH, h1: rake.middleMm },
            { s0: apexS, s1: seg.segLen, h0: rake.middleMm, h1: endH },
          ]
        : [{ s0: 0, s1: seg.segLen, h0: startH, h1: endH }];
    for (const piece of topPieces) {
      const runMm = (piece.s1 - piece.s0) * mmPerPoint;
      if (rake && runMm > 0) {
        // Plumb-cut ends: the plate spans the full horizontal run of the piece (long point at the
        // outside of the end stud / the ridge), with vertical end faces and sloped top/bottom faces.
        const runM = M(runMm);
        const lenM = M(Math.hypot(runMm, piece.h1 - piece.h0));
        const startX = fx(piece.s0);
        const startZ = fz(piece.s0);
        for (let l = 0; l < topLayers; l += 1) {
          const yBottomStart = M(piece.h0 - topMakeup + l * STUD_THICKNESS_MM);
          const yBottomEnd = M(piece.h1 - topMakeup + l * STUD_THICKNESS_MM);
          const quad: [number, number][] = [
            [0, yBottomStart],
            [runM, yBottomEnd],
            [runM, yBottomEnd + thkM],
            [0, yBottomStart + thkM],
          ];
          members.push({
            kind: "plate",
            segmentIndex: segIndex,
            lengthM: lenM,
            position: [startX, 0, startZ],
            size: [lenM, thkM, depthM],
            yaw,
            pitch: 0,
            wedge: { quad, depthM },
          });
        }
      } else {
        for (let l = 0; l < topLayers; l += 1) {
          members.push({
            kind: "plate",
            segmentIndex: segIndex,
            lengthM: plateLenM,
            position: [fx(plateMidS), M(settings.wallHeightMm - topMakeup + l * STUD_THICKNESS_MM + STUD_THICKNESS_MM / 2), fz(plateMidS)],
            size: [plateLenM, thkM, depthM],
            yaw,
            pitch: 0,
          });
        }
      }
    }

    // Opening members. Two openings can share a wall position — a window stacked directly above a
    // door — so every opening's geometry (centre/width/sill/head) is precomputed first, and each
    // vertical member (king/trimmer/jack/sill jack) is clipped against every OTHER opening's own
    // daylight "hole" at that arc-length instead of unconditionally running bottom-plate→ceiling.
    // Without this, a jack above the door ran straight through the window above it (and vice versa
    // for the window's sill jack running straight through the door below), and a king/trimmer that
    // happened to land at the same position for both openings was emitted twice.
    const segOpenings = openings.filter((o) => o.segmentIndex === segIndex);
    const openMeta = segOpenings.map((o) => {
      const centrePts = o.centreMm / mmPerPoint;
      const dwHalf = o.daylightWidthMm / mmPerPoint / 2;
      const jambs = openingJambs(centrePts, dwHalf, studThkPts);
      const isWindow = o.kind === "window";
      const sill = isWindow ? o.sillHeightMm ?? 0 : 0;
      const lintelDepth = framingDepthMm(o.lintelSize);
      // Cap the head (and so the lintel/trimmers) to the underside of the lowest top plate above
      // the king studs — whether that's this segment's own rake, or an adjacent (possibly raked)
      // segment's roofline at a shared corner — so the opening is trimmed rather than poking through.
      const rakeHeadLimit = Math.min(...jambs.kings.map((k) => ceilingMmAt(pointAt(seg, k)))) - lintelDepth;
      const head = Math.min(sill + o.daylightHeightMm, rakeHeadLimit);
      return { o, centrePts, dwHalf, sill, head, jambs, lintelDepth, isWindow };
    });

    // Every OTHER opening's occupied zone [sill, head + lintelDepth] that covers arc-length `s`,
    // sorted low→high — the daylight cavity itself PLUS the lintel bulk sitting directly above it,
    // since no other member (a stacked opening's jack, a king passing through) can occupy that
    // space either. `excludeIdxs` skips the given opening indices outright (needed for interior
    // jack/sill-jack grid positions, which sit INSIDE their own opening's width and would otherwise
    // "clip themselves" to nothing). `marginPts` widens the containment test beyond the opening's
    // exact daylight width — used for king/trimmer clipping below, where two openings of different
    // widths can put one's jamb just outside the other's daylight width yet still well within reach
    // of its king/trimmer assembly (which itself extends `2×studThk` past the daylight edge) — a
    // real QA case had a window's king only ~23mm past the door's own edge, just missing an exact
    // `dwHalf` test and so never getting clipped to sit on the door's lintel like its other side did.
    const holesAt = (
      s: number,
      excludeIdxs: ReadonlySet<number>,
      marginPts = 0,
    ): { lo: number; hi: number; isWindow: boolean }[] =>
      openMeta
        .filter((m, idx) => !excludeIdxs.has(idx) && Math.abs(s - m.centrePts) <= m.dwHalf + marginPts + GEOM_EPS)
        .map((m) => ({ lo: m.sill - (m.isWindow ? STUD_THICKNESS_MM : 0), hi: m.head + m.lintelDepth, isWindow: m.isWindow }))
        .sort((a, b) => a.lo - b.lo);
    const NO_EXCLUSIONS: ReadonlySet<number> = new Set();

    // Adds a member spanning [yB, yT] at `s`, first carving out every other opening's hole so the
    // member breaks into separate pieces around them instead of running straight through. Only the
    // top-most surviving piece (the one that actually reaches `yT`, e.g. the ceiling) gets the
    // rake-cut treatment — an intermediate piece's top is a hole boundary, not the roofline.
    const addVClipped = (
      kind: FramingComponentKind,
      s: number,
      yB: number,
      yT: number,
      excludeIdxs: ReadonlySet<number>,
      marginPts = 0,
      rakeCut = false,
      openingId?: { segmentIndex: number; centreMm: number },
    ) => {
      let cursor = yB;
      for (const hole of holesAt(s, excludeIdxs, marginPts)) {
        const lo = Math.max(hole.lo, cursor);
        const hi = Math.min(hole.hi, yT);
        if (hi <= lo) continue;
        if (lo > cursor) addV(kind, s, cursor, lo, false, openingId);
        cursor = hi;
      }
      if (cursor < yT) addV(kind, s, cursor, yT, rakeCut, openingId);
    };

    // King and trimmer jamb studs, each merged ONLY within their own kind — a king merges with
    // another opening's king landing at (near enough) the exact same position (e.g. two identically-
    // wide openings stacked on the same line put their kings at literally the same arc-length), and
    // likewise for trimmers, but a king is NEVER merged with a trimmer just because they happen to
    // land close together. A real QA case had a door's trimmer land 0.4mm from an unrelated window's
    // king (pure numeric coincidence from the specific widths involved) — merging them collapsed the
    // window's own king requirement into the door's already-unclippable trimmer run, silently hiding
    // the "sits on the lintel" break the window's king needed. Keeping kings and trimmers in
    // separate merge groups means each opening's own king still gets its own correctly-clipped
    // extent even when it happens to sit almost on top of a different opening's trimmer.
    // `ownIdxs` tracks which opening(s) a merged group's OWN kind belongs to, so those openings'
    // holes are excluded from its clip regardless of the widened margin below (a king/trimmer must
    // never be clipped by its own opening — round-tripping through the exact boundary is no longer
    // reliable once the margin is widened past the daylight edge).
    const kingGroups: { x: number; ownIdxs: Set<number> }[] = [];
    const trimmerGroups: { x: number; headMm: number; ownIdxs: Set<number> }[] = [];
    openMeta.forEach((m, idx) => {
      for (const k of m.jambs.kings) {
        const g = kingGroups.find((c) => Math.abs(c.x - k) < 1 / mmPerPoint);
        if (g) g.ownIdxs.add(idx);
        else kingGroups.push({ x: k, ownIdxs: new Set([idx]) });
      }
      for (const t of m.jambs.trimmers) {
        const g = trimmerGroups.find((c) => Math.abs(c.x - t) < 1 / mmPerPoint);
        if (g) { g.headMm = Math.max(g.headMm, m.head); g.ownIdxs.add(idx); }
        else trimmerGroups.push({ x: t, headMm: m.head, ownIdxs: new Set([idx]) });
      }
    });
    // A king/trimmer never extends past `dwHalf + 2×studThk` from its own opening's centre (the
    // king sits `1.5×studThk` out, plus its own half-thickness) — so that's the true reach of an
    // opening's jamb assembly, wider than the bare daylight width used everywhere else.
    const jambMarginPts = 2 * studThkPts;
    // A shared king/trimmer (two openings' jambs landing on the same line) is tagged to whichever
    // opening comes first in ownIdxs — a rare edge case (stacked openings), not the common case.
    const firstOwningOpening = (ownIdxs: Set<number>) => openMeta[[...ownIdxs][0]]?.o;
    for (const g of kingGroups) {
      const owner = firstOwningOpening(g.ownIdxs);
      addVClipped("king", g.x, bottomMakeup, ceilingMmAt(pointAt(seg, g.x)), g.ownIdxs, jambMarginPts, true, owner ? { segmentIndex: segIndex, centreMm: owner.centreMm } : undefined); // full, follows rake
    }
    for (const g of trimmerGroups) {
      const owner = firstOwningOpening(g.ownIdxs);
      addVClipped("trimmer", g.x, bottomMakeup, g.headMm, g.ownIdxs, jambMarginPts, false, owner ? { segmentIndex: segIndex, centreMm: owner.centreMm } : undefined); // bottom plate → underside of lintel
    }

    // Gable apex: a stud under each side's top plate, meeting at the ridge. Corner-makeup anchors
    // and the gable apex pair are otherwise drawn unconditionally — but if an opening cuts through
    // here, they become jack (and sill jack) studs below, like any other cut stud.
    const gableApexS = rake?.gable && rake.middleMm !== undefined ? [apexS - studThkPts / 2, apexS + studThkPts / 2] : [];
    // A regular grid stud can land close enough to the apex pair to physically clash with it (any
    // overlap at all, not just a near-exact coincidence) — the apex pair always wins, since it's the
    // structural requirement (the ridge meeting point), not an arbitrary spacing artefact. Unlike the
    // king/trimmer-vs-generic-stud rule above (which only drops a HALF-thickness-or-closer overlap,
    // to preserve merely-nearby regular-grid studs), this uses the FULL stud thickness: the apex pair
    // is an explicit, always-present "double stud" requirement, and the regular grid position it
    // clashes with contributes nothing the apex studs don't already cover.
    const regularClearOfApex = seg.regular.filter((r) => !gableApexS.some((a) => Math.abs(a - r) < studThkPts));

    // Studs (anchors + regulars + gable apex studs), minus anything cut by an opening's own daylight
    // width, and minus anything genuinely overlapping a king/trimmer jamb stud placed above (a door
    // or window landing on the wall's own end/corner stud, or a regular grid stud landing on a jamb,
    // say) — the opening's jamb, already load-bearing for its lintel, wins there; the generic stud
    // would just be a duplicate/overlapping timber. The threshold is deliberately HALF a stud
    // thickness, not a full one: two stud-thick members whose centres are less than half a
    // thickness apart genuinely overlap by more than half their footprint (the same physical spot);
    // further apart than that and they're two distinct, non-clashing studs — e.g. the QA-regression
    // case just above (a regular stud sitting exactly a half-thickness off a trimmer) must NOT be
    // dropped, and it sits exactly on this boundary.
    const cut = (s: number) =>
      segOpenings.some((o) => Math.abs(s - o.centreMm / mmPerPoint) <= o.daylightWidthMm / mmPerPoint / 2) ||
      nearAnyOpening(pointAt(seg, s), segIndex) ||
      kingGroups.some((g) => Math.abs(s - g.x) < studThkPts / 2) ||
      trimmerGroups.some((g) => Math.abs(s - g.x) < studThkPts / 2);
    // Anchor/gable-apex candidates and the regular grid are computed independently and can
    // coincidentally land on (or within a fraction of a mm of) the same position — e.g. a gable
    // apex offset by half a stud thickness landing exactly on a grid line — which would otherwise
    // draw/count the same physical stud twice (both as a full stud and, if cut, as two jacks).
    const allCandidates = dedupePositions([...seg.anchors, ...gableApexS, ...regularClearOfApex], 1 / mmPerPoint);
    const notCut = allCandidates.filter((x) => !cut(x));
    // A doubled stud's sister lands a full stud-thickness away, toward the wall interior — if that
    // lands on another candidate in the same set (a regular grid stud caught under a doubled gable-
    // apex stud, say), the sister wins and the plain stud there is dropped rather than overlapped.
    const sisterPositions = notCut
      .filter((s) => isStudDoubled(framing, segIndex, s * mmPerPoint))
      .map((s) => s + sisterOffset(s));
    for (const s of notCut) {
      // A sister sits exactly `studThkPts` from its own primary — well outside this half-thickness
      // "genuine overlap" test — so this never drops the primary that generated it, only a
      // genuinely different candidate landing in the same spot.
      if (sisterPositions.some((sx) => Math.abs(sx - s) < studThkPts / 2)) continue;
      addV("stud", s, bottomMakeup, ceilingMmAt(pointAt(seg, s)), true);
    }

    for (const { o, centrePts, head, lintelDepth } of openMeta) {
      const lintelLenM = M(o.daylightWidthMm + 2 * STUD_THICKNESS_MM);
      const lintelSizeOverride = o.lintelSize;
      // Lintel ply rendered as `ply` stacked beams across the depth (for legibility); length counts ×ply.
      // Each ply is offset along the wall-depth direction (perpendicular to the wall in the XZ plane)
      // so they appear as distinct side-by-side beams rather than coincident volumes.
      const plyDepthM = depthM / Math.max(1, o.lintelPly);
      for (let p = 0; p < o.lintelPly; p += 1) {
        const plyOffset = (p - (o.lintelPly - 1) / 2) * plyDepthM;
        members.push({ kind: "lintel", sizeOverride: lintelSizeOverride, segmentIndex: segIndex, openingSegmentIndex: segIndex, openingCentreMm: o.centreMm, lengthM: lintelLenM, position: [fx(centrePts) + Math.sin(yaw) * plyOffset, M(head + lintelDepth / 2), fz(centrePts) + Math.cos(yaw) * plyOffset], size: [lintelLenM, M(lintelDepth), plyDepthM], yaw, pitch: 0 });
      }
      if (o.kind === "window") {
        const sill = o.sillHeightMm ?? 0;
        members.push({ kind: "sill", segmentIndex: segIndex, openingSegmentIndex: segIndex, openingCentreMm: o.centreMm, lengthM: M(o.daylightWidthMm), position: [fx(centrePts), M(sill - STUD_THICKNESS_MM / 2), fz(centrePts)], size: [M(o.daylightWidthMm), thkM, depthM], yaw, pitch: 0 });
      }
    }

    // Interior cripple ("jack") stud positions: the regular stud-grid line threading through an
    // opening's daylight width. A position can lie inside more than one opening's width when two
    // openings are stacked (e.g. a window directly above a door) — piece the column together around
    // BOTH openings' holes in one pass (self-inclusive: the current opening's own hole is exactly
    // what carves the below-sill / above-head split) rather than computing each opening's jack run
    // independently, which used to double up members or run a sill jack straight through a lower
    // opening's daylight.
    const jackGridPositions = dedupePositions(
      openMeta.flatMap((m) => allCandidates.filter((s) => Math.abs(s - m.centrePts) <= m.dwHalf)),
      1 / mmPerPoint,
    );
    for (const s of jackGridPositions) {
      const top = ceilingMmAt(pointAt(seg, s));
      let cursor = bottomMakeup;
      // A grid line can sit inside more than one stacked opening's width; tag with whichever
      // opening's window contains it first (rare edge case — same simplification as king/trimmer).
      const owner = openMeta.find((m) => Math.abs(s - m.centrePts) <= m.dwHalf)?.o;
      const ownerId = owner ? { segmentIndex: segIndex, centreMm: owner.centreMm } : undefined;
      for (const hole of holesAt(s, NO_EXCLUSIONS)) {
        const lo = Math.max(hole.lo, cursor);
        const hi = Math.min(hole.hi, top);
        if (hi <= lo) continue;
        if (lo > cursor) addV(hole.isWindow && Math.abs(lo - hole.lo) < GEOM_EPS ? "sill_jack" : "jack", s, cursor, lo, false, ownerId);
        cursor = hi;
      }
      if (cursor < top) addV("jack", s, cursor, top, true, ownerId);
    }

    // Window-only tight support studs directly under the sill (inside the trimmers) — always a
    // plain sill jack, still clipped against a lower opening stacked on the same line.
    for (const m of openMeta) {
      if (!m.isWindow) continue;
      const sillTop = m.sill - STUD_THICKNESS_MM; // underside of the sill
      for (const s of [m.centrePts - (m.dwHalf - studThkPts / 2), m.centrePts + (m.dwHalf - studThkPts / 2)]) {
        addVClipped("sill_jack", s, bottomMakeup, sillTop, NO_EXCLUSIONS, 0, false, { segmentIndex: segIndex, centreMm: m.o.centreMm });
      }
    }

    // Dwangs — per row (fixed centres up from the bottom plate), between adjacent members present at
    // that height, skipping a bay that spans an open daylight (door: full height; window: sill→head).
    // The corner-makeup gap (between corner studs 2 & 3, docs/corner makeup.png) gets solid packer
    // blocks instead — a real dwang can't reach across it, so it's packed out with 300 mm blocking.
    // Still a single row at the dwang-row height (never stacked taller): `cornerPackerCount` blocks
    // sit side by side across the gap's width, each one stud-thickness (45 mm) wide, so a deeper
    // wall (wider gap) gets more 300 mm blocks packed in, not one taller block.
    if (settings.dwangsOn && centresMm > 0) {
      const maxTop = verticals.reduce((mx, v) => Math.max(mx, v.yT), 0);
      const cornerGapX0 = seg.startCorner ? seg.anchors[0] : null;
      const cornerGapX1 = seg.startCorner ? seg.anchors[1] : null;
      for (let h = bottomMakeup + centresMm; h <= maxTop + 1e-6; h += centresMm) {
        const present = verticals.filter((v) => v.yB <= h + 1e-6 && v.yT >= h - 1e-6).sort((a, b) => a.x - b.x);
        for (let i = 0; i + 1 < present.length; i += 1) {
          const mid = (present[i].x + present[i + 1].x) / 2;
          if (openMeta.some((o) => Math.abs(mid - o.centrePts) < o.dwHalf && h > o.sill + 1e-6 && h < o.head - 1e-6)) continue;
          const bayGapMm = (present[i + 1].x - present[i].x) * mmPerPoint - STUD_THICKNESS_MM;
          if (bayGapMm <= 0) continue;
          const isCornerGap =
            cornerGapX0 !== null &&
            cornerGapX1 !== null &&
            Math.abs(present[i].x - cornerGapX0) < GEOM_EPS &&
            Math.abs(present[i + 1].x - cornerGapX1) < GEOM_EPS;
          if (isCornerGap) {
            const packerCount = cornerPackerCount(settings.framingSize);
            const groupWidthPts = packerCount * studThkPts;
            const groupStart = mid - groupWidthPts / 2 + studThkPts / 2;
            for (let p = 0; p < packerCount; p += 1) {
              const s = groupStart + p * studThkPts;
              members.push({ kind: "packer", segmentIndex: segIndex, lengthM: M(PACKER_LENGTH_MM), position: [fx(s), M(h), fz(s)], size: [thkM, M(PACKER_LENGTH_MM), depthM], yaw, pitch: 0 });
            }
          } else {
            members.push({ kind: "dwang", segmentIndex: segIndex, lengthM: M(bayGapMm), position: [fx(mid), M(h), fz(mid)], size: [M(bayGapMm), thkM, depthM], yaw, pitch: 0 });
          }
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
      segmentIndex: es.segmentIndex,
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
 *  `sizeOverride` is always present on lintel rows — the lintel's framing size. */
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
