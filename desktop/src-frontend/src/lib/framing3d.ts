// 3D geometry builders (M9+). Timber framing goes through `wallMembers` (the single member model
// shared with the 2D takeoff, so the 3D view and the quantities always agree); count/length/area
// groups go through the generic builders below. World: metres, Y up, the PDF page is the floor;
// world X = page x * S, world Z = -page y * S (S = mm-per-point / 1000) — matching PageGround's
// "PDF Y → world -Z" convention. Each box member is rotated `yaw` about Y and `pitch` about its
// across-axis.

import {
  absArrayTrims,
  applyArrayTrims,
  wallInsulationPocketsFor,
  type ArrayMeta,
  type PagePoint,
  type WallSurfaceMeta,
} from "./quantity";
import {
  arrayBlockingPieces,
  framingDepthMm,
  wallFacePath,
  wallMembers,
  STUD_THICKNESS_MM,
  type FramingComponentKind,
  type FramingSettings,
  type JoistRafterSettings,
  type WallFraming,
} from "./framing";

export interface Member3D {
  kind: FramingComponentKind | "generic";
  position: [number, number, number];
  size: [number, number, number];
  yaw: number;
  pitch: number;
  /** Optional swing within the member's own pitched plane, about its (already tilted) local up-axis
   *  — see `quaternionFor` in Framing3DView. Only Joist/Rafter end blocks following an off-axis trim
   *  use it; absent/0 everywhere else. */
  roll?: number;
  wedge?: { quad: [number, number][]; depthM: number };
  /** Explicit colour override — used by generic (non-framing) members, which are coloured by
   *  their owning dimension group rather than by member kind. */
  color?: string;
}

/** A flat or volumetric extrusion of an area-group polygon (world X/Z footprint, extruded up
 *  from `baseY` by `heightM`). Rendered by `AreaMeshItem` in Framing3DView. */
export interface AreaMesh3D {
  /** World [x, z] polygon vertices, metres, not repeating the closing point. */
  points: [number, number][];
  /** Per-vertex rise (metres) above `baseY`, index-aligned with `points`, from the group's mono-
   *  pitch. All zero for an unpitched area; the lowest vertex is always 0, so a pitched area
   *  hinges up off its own low edge rather than sinking below the group's Z datum. */
  rises: number[];
  baseY: number;
  heightM: number;
  color: string;
}

const MIN_GENERIC_SIZE_M = 0.1;
const MIN_AREA_HEIGHT_M = 0.02;
/** Thickness used for a dimension a length group's `default_display` doesn't actually measure —
 *  thin enough to read as a flat face rather than a box, thick enough to stay visible/pickable. */
const MIN_FACE_THICKNESS_M = 0.02;

function pageToWorld(p: PagePoint, S: number): [number, number] {
  return [p.x * S, -p.y * S];
}

/** Member colours, loosely matching docs/window makeup.png + the 3D references. */
export const MEMBER_COLOURS: Record<string, string> = {
  plate: "#C77F2E",
  stud: "#3F6FB0",
  dwang: "#7A7F87",
  packer: "#5C6270",
  king: "#2E8B57",
  trimmer: "#C0392B",
  lintel: "#7D3C98",
  jack: "#E67E22",
  sill: "#B8860B",
  sill_jack: "#E07B39",
};

export function computeWall3D(
  path: PagePoint[],
  settings: FramingSettings,
  mmPerPoint: number | null,
  framing?: WallFraming,
): Member3D[] {
  return wallMembers(path, settings, mmPerPoint, framing).map((m) => ({
    kind: m.kind,
    position: m.position,
    size: m.size,
    yaw: m.yaw,
    pitch: m.pitch,
    wedge: m.wedge,
  }));
}

/** Shifts members up by `offsetM` along world Y — applies a dimension group's
 *  `default_offset` (height above datum) in the 3D view. */
export function offsetMembers(members: Member3D[], offsetM: number): Member3D[] {
  if (!offsetM) return members;
  return members.map((m) => ({
    ...m,
    position: [m.position[0], m.position[1] + offsetM, m.position[2]],
  }));
}

/** Shifts an area mesh's base up by `offsetM` along world Y. */
export function offsetArea(area: AreaMesh3D, offsetM: number): AreaMesh3D {
  if (!offsetM) return area;
  return { ...area, baseY: area.baseY + offsetM };
}

/** A "count" measurement's 3D marker: a small cube at the point, offset up by `offsetM`. Sized
 *  by the group's default width/height when `countType === "custom"` (matching the 2D custom-count
 *  rectangle), else a fixed small marker cube. */
export function computeCountMarker3D(
  point: PagePoint,
  mmPerPoint: number | null,
  opts: { widthM: number; heightM: number; countType: string; offsetM: number; color: string },
): Member3D | null {
  if (!mmPerPoint || !(mmPerPoint > 0)) return null;
  const S = mmPerPoint / 1000;
  const [x, z] = pageToWorld(point, S);
  const custom = opts.countType === "custom" && opts.widthM > 0 && opts.heightM > 0;
  const w = custom ? opts.widthM : MIN_GENERIC_SIZE_M;
  const h = custom ? opts.heightM : MIN_GENERIC_SIZE_M;
  return {
    kind: "generic",
    position: [x, opts.offsetM + h / 2, z],
    size: [w, h, w],
    yaw: 0,
    pitch: 0,
    color: opts.color,
  };
}

/** A "length" measurement's 3D extrusion: one box per segment, offset up by `offsetM`. The
 *  cross-section follows which of width/height the group's `default_display` actually measures
 *  (see `deriveQuantity` in quantity.ts) — a dimension the 2D quantity ignores is rendered as a
 *  thin face rather than a wide extrusion, so e.g. a "wall_area" run (length × height only, no
 *  width) shows as a vertical face, and a plan "area" run (length × width only, no height) shows
 *  as a flat ribbon. Only "volume" (length × width × height) gets a genuine box. */
export function computeLengthMembers3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  opts: { widthM: number; heightM: number; offsetM: number; color: string; display: string },
): Member3D[] {
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 2) return [];
  const S = mmPerPoint / 1000;
  let w: number;
  let h: number;
  switch (opts.display) {
    case "wall_area":
      w = MIN_FACE_THICKNESS_M;
      h = opts.heightM > 0 ? opts.heightM : MIN_GENERIC_SIZE_M;
      break;
    case "area":
      w = opts.widthM > 0 ? opts.widthM : MIN_GENERIC_SIZE_M;
      h = MIN_FACE_THICKNESS_M;
      break;
    case "volume":
      w = opts.widthM > 0 ? opts.widthM : MIN_GENERIC_SIZE_M;
      h = opts.heightM > 0 ? opts.heightM : MIN_GENERIC_SIZE_M;
      break;
    default:
      // Plain "length" (or deferred "weight") — neither width nor height is meaningful: a thin line.
      w = MIN_FACE_THICKNESS_M;
      h = MIN_FACE_THICKNESS_M;
      break;
  }
  const members: Member3D[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const [x1, z1] = pageToWorld(points[i - 1], S);
    const [x2, z2] = pageToWorld(points[i], S);
    const dx = x2 - x1;
    const dz = z2 - z1;
    const segLen = Math.hypot(dx, dz);
    if (segLen <= 0) continue;
    const yaw = Math.atan2(dx, dz);
    members.push({
      kind: "generic",
      position: [(x1 + x2) / 2, opts.offsetM + h / 2, (z1 + z2) / 2],
      size: [w, h, segLen],
      yaw,
      pitch: 0,
      color: opts.color,
    });
  }
  return members;
}

/** A Joist/Rafter ("array") measurement's 3D extrusion: one sized box per (trimmed) member —
 *  the baseline plus every extruded extra member, offset and clipped exactly like
 *  `getArrayMembers`/`drawArray` in ViewerCanvas.tsx, so 2D and 3D never disagree on member
 *  count. Each box stands with the group's timber size's depth (D) vertical and the constant
 *  45mm thickness (T) as its plan-view width, matching the 2D dimensional rendering. A non-zero
 *  pitch tilts each member about its own width axis and stretches it to the true sloped length,
 *  rising from `points[0]` (drawn first) to `points[1]` — the same low-to-high convention as
 *  drawing a rafter directly along the slope.
 *
 *  When the group has blocking switched on, a box is added across each bay for every blocking piece
 *  `arrayBlockingPieces` produces (the same pieces the 2D overlay draws and the quantity counts),
 *  rolled to the same pitch as the members and hung so its top face is flush and coplanar with
 *  theirs. */
export function computeArrayMembers3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  meta: ArrayMeta,
  settings: JoistRafterSettings,
  opts: { offsetM: number; color: string; pitchAngleDeg: number },
): Member3D[] {
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 2) return [];
  const S = mmPerPoint / 1000;
  const [p1, p2] = points;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const baseLen = Math.hypot(dx, dy);
  if (baseLen < 1e-9) return [];
  const perpX = -dy / baseLen;
  const perpY = dx / baseLen;
  const absTrimsList = absArrayTrims(meta.trims, p1);
  const depthM = framingDepthMm(settings.framingSize) / 1000;
  const widthM = STUD_THICKNESS_MM / 1000;
  const pitchRad = Math.min(89.9, Math.max(0, opts.pitchAngleDeg)) * (Math.PI / 180);
  const tan = pitchRad !== 0 ? Math.tan(pitchRad) : 0;
  const cos = pitchRad !== 0 ? Math.cos(pitchRad) : 1;

  const members: Member3D[] = [];
  for (let i = 0; i <= meta.extraMembers; i += 1) {
    const off = i * meta.spacingPts * meta.direction;
    const a: PagePoint = { x: p1.x + perpX * off, y: p1.y + perpY * off };
    const b: PagePoint = { x: p2.x + perpX * off, y: p2.y + perpY * off };
    for (const [ca, cb] of applyArrayTrims([a, b], absTrimsList)) {
      const [x1, z1] = pageToWorld(ca, S);
      const [x2, z2] = pageToWorld(cb, S);
      const runDx = x2 - x1;
      const runDz = z2 - z1;
      const planLen = Math.hypot(runDx, runDz);
      if (planLen <= 0) continue;
      // Unlike computeLengthMembers3D (whose box puts its length on local Z, paired with
      // yaw = atan2(dx, dz)), this box's length is on local X (size[0]) so pitch — which rotates
      // about local Z per Framing3DView's quaternionFor — pivots the length axis about the width
      // axis, not the other way round. Aligning local X (not Z) to the run direction needs the
      // complementary formula: atan2(-dz, dx).
      const yaw = Math.atan2(-runDz, runDx);
      const lengthM = pitchRad !== 0 ? planLen / cos : planLen;
      const riseM = pitchRad !== 0 ? planLen * tan : 0;
      members.push({
        kind: "generic",
        position: [(x1 + x2) / 2, opts.offsetM + depthM / 2 + riseM / 2, (z1 + z2) / 2],
        size: [lengthM, depthM, widthM],
        yaw,
        pitch: pitchRad,
        color: opts.color,
      });
    }
  }

  // Blocking. Two things have to hold against the rafters it sits between:
  //
  //  1. It is rolled to the roof pitch, not left plumb — its top face is coplanar with the
  //     rafters' top faces. It gets the SAME yaw and pitch as the members above, which is what
  //     guarantees that: `quaternionFor` composes Ry(yaw)·Rz(pitch), so an identical (yaw, pitch)
  //     gives an identical local-Y axis — the tilted "up" normal the rafters already have. To use
  //     that shared rotation the box's length has to sit on local Z (the axis Rz leaves alone, and
  //     which that yaw points across the slope), with the 45 mm thickness on local X — the mirror
  //     of the members' own [length, depth, width] layout.
  //  2. Its TOP is flush with the rafters' top, whatever depth the blocking timber is — shallower
  //     blocking hangs from the top rather than sitting on the bottom.
  //
  // Working vertically in the (run, up) cross-section: a rafter's centreline runs from
  // `offsetM + depthM/2` at the start of the run up at tan(pitch), and its top face is a further
  // (depthM/2)·sec(pitch) above that measured vertically (the perpendicular offset read off
  // vertically). The blocking's own top face is likewise (blockingDepthM/2)·sec(pitch) above its
  // centre, so matching the two planes leaves the half-depth *difference*, scaled by sec(pitch).
  const blockingDepthM = framingDepthMm(settings.blockingSize) / 1000;
  const sec = pitchRad !== 0 ? 1 / cos : 1;
  const [rx1, rz1] = pageToWorld(p1, S);
  const [rx2, rz2] = pageToWorld(p2, S);
  const runYaw = Math.atan2(-(rz2 - rz1), rx2 - rx1);
  for (const piece of arrayBlockingPieces(points, meta, settings, mmPerPoint, opts.pitchAngleDeg)) {
    const [bx1, bz1] = pageToWorld(piece.a, S);
    const [bx2, bz2] = pageToWorld(piece.b, S);
    if (Math.hypot(bx2 - bx1, bz2 - bz1) <= 0) continue;
    // Resolve the piece into the roof plane's own two axes: across the slope (level, so plan
    // distance is true distance) and down the slope (stretched by 1/cos). An ordinary square row is
    // purely across; an end row following an off-axis trim also runs down the slope, and `roll`
    // swings it by that much within the plane — leaving the plane's normal, and so the flush top
    // face, untouched.
    const alongPlanM = (piece.runPtsB - piece.runPtsA) * S;
    const alongSlopeM = alongPlanM * sec;
    const acrossM = dotAcross(bx2 - bx1, bz2 - bz1, rx2 - rx1, rz2 - rz1);
    const lengthM = Math.hypot(acrossM, alongSlopeM);
    if (lengthM <= 0) continue;
    const roll = Math.atan2(alongSlopeM, acrossM);
    // Height reference is the piece's midpoint; the roll keeps both ends on the same plane.
    const midRunM = ((piece.runPtsA + piece.runPtsB) / 2) * S;
    const riseM = tan !== 0 ? midRunM * tan : 0;
    members.push({
      kind: "generic",
      position: [
        (bx1 + bx2) / 2,
        opts.offsetM + depthM / 2 + ((depthM - blockingDepthM) / 2) * sec + riseM,
        (bz1 + bz2) / 2,
      ],
      size: [widthM, blockingDepthM, lengthM],
      yaw: runYaw,
      pitch: pitchRad,
      roll,
      color: opts.color,
    });
  }

  return members;
}

/** Component of the world vector (vx, vz) along the array's across-slope axis — the horizontal
 *  direction perpendicular to the run (rx, rz). Signed, so a mirrored extrusion direction simply
 *  rolls the (symmetric) box the other way round. */
function dotAcross(vx: number, vz: number, runX: number, runZ: number): number {
  const len = Math.hypot(runX, runZ);
  if (len <= 0) return Math.hypot(vx, vz);
  // The across axis used by `quaternionFor`'s yaw is (-runZ, runX) normalised.
  return (vx * -runZ + vz * runX) / len;
}

/** An "area" measurement's 3D extrusion: the polygon footprint extruded up from `offsetM` by the
 *  group's default height (or a thin slab when unset, so a flat area group still renders as a
 *  visible floor plate rather than nothing). */
/**
 * An area measurement's 3D geometry. A pitch (`pitchAngleDeg` ≠ 0) tilts the slab into its
 * mono-pitch plane: every vertex is displaced by its distance along the uphill direction times
 * tan(pitch), so the plan footprint is unchanged — the same mono-pitch model by which
 * `deriveQuantity` scales the area to (plan area / cos θ). `pitchDirectionDeg` is the uphill
 * bearing in PAGE space (0 = along page +X, 90 = along page +Y), the convention shared with
 * `pitchedSegmentLengthPts` and with the group's own `pitch_direction_deg`.
 *
 * `pitchOrigin` is the pivot the plane rotates about, in page points — from the measurement's own
 * `PitchAxis`. The plane passes through it at `offsetM`, rising on its uphill side and dropping
 * BELOW the datum on the other, which is what makes a picked ridge or eaves line behave like a
 * real hinge. With no origin (a group-wide pitch, which has no pivot to give) the shape's own
 * lowest vertex is used instead, so the slab hinges up off its low edge and never sinks below the
 * group's Z datum.
 */
export function computeAreaMesh3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  opts: {
    heightM: number;
    offsetM: number;
    color: string;
    pitchAngleDeg?: number;
    pitchDirectionDeg?: number;
    pitchOrigin?: PagePoint | null;
  },
): AreaMesh3D | null {
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 3) return null;
  const S = mmPerPoint / 1000;
  const world = points.map((p) => pageToWorld(p, S));
  const pitchRad = ((opts.pitchAngleDeg ?? 0) * Math.PI) / 180;
  let rises = world.map(() => 0);
  if (pitchRad !== 0) {
    const dirRad = ((opts.pitchDirectionDeg ?? 0) * Math.PI) / 180;
    // Page-space uphill axis (cos dir, sin dir) expressed in world terms: world x = page x * S and
    // world z = -page y * S, so the page's +y component reads as -z.
    const alongOf = (x: number, z: number) => x * Math.cos(dirRad) - z * Math.sin(dirRad);
    const along = world.map(([x, z]) => alongOf(x, z));
    const origin = opts.pitchOrigin;
    const base = origin ? alongOf(...pageToWorld(origin, S)) : Math.min(...along);
    rises = along.map((u) => (u - base) * Math.tan(pitchRad));
  }
  return {
    points: world,
    rises,
    baseY: opts.offsetM,
    heightM: Math.max(opts.heightM, MIN_AREA_HEIGHT_M),
    color: opts.color,
  };
}

/** Lining panel thickness (m) used to give a Wall Surface a visible body in 3D. It is purely
 *  representational — the quantity is an area and carries no thickness. */
const WALL_SURFACE_THICKNESS_M = 0.02;

/** Splits a face segment's full-height profile into the vertical strips left once its openings
 *  are punched out: solid full-height pieces either side, plus the spandrel above each head and
 *  the apron below each sill. Ranges are along-face metres; heights come from `heightAt`. */
function wallSurfaceStrips(
  lengthM: number,
  openings: { x0: number; x1: number; sillM: number; headM: number }[],
  heightAt: (x: number) => number,
): { x0: number; x1: number; y0: (x: number) => number; y1: (x: number) => number }[] {
  const out: { x0: number; x1: number; y0: (x: number) => number; y1: (x: number) => number }[] = [];
  const sorted = [...openings].sort((a, b) => a.x0 - b.x0);
  let cursor = 0;
  for (const op of sorted) {
    const x0 = Math.max(0, Math.min(lengthM, op.x0));
    const x1 = Math.max(0, Math.min(lengthM, op.x1));
    if (x0 > cursor + 1e-9) out.push({ x0: cursor, x1: x0, y0: () => 0, y1: heightAt });
    if (x1 > x0) {
      if (op.sillM > 1e-9) out.push({ x0, x1, y0: () => 0, y1: () => op.sillM });
      out.push({ x0, x1, y0: () => op.headM, y1: heightAt });
    }
    cursor = Math.max(cursor, x1);
  }
  if (cursor < lengthM - 1e-9) out.push({ x0: cursor, x1: lengthM, y0: () => 0, y1: heightAt });
  return out;
}

/**
 * A "wall surface" measurement's 3D geometry: one thin upright panel per face segment, standing on
 * the wall's face line and following the segment's rake (a gable segment is split at its apex, so
 * both slopes are true). When the surface deducts openings the panel is split around each hole, so
 * what's drawn is exactly the area that was measured.
 *
 * `points` is the source wall's centre line (as stored in `geometry_json`); the face offset comes
 * from the snapshot's own `framingDepthMm`, so the panel lands on the same face the 2D canvas fills.
 */
/**
 * An insulation measure's 3D geometry: one batt per pocket, sitting in the frame's voids rather
 * than covering the wall face. Pockets are set out along the wall's CENTRE line (that is where the
 * frame is set out), so each batt is placed off the centre-line segment and pushed out onto the
 * face — not off the mitred face path a lining panel uses.
 *
 * Batts are drawn the full depth of the framing, since that is what a batt fills. `meta.side` is
 * deliberately unused here: both faces of a wall look into the same cavity, so measuring the
 * insulation off either face gives the same batts in the same place.
 */
function computeWallBatts3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  meta: WallSurfaceMeta,
  opts: { offsetM: number; color: string; deductOpenings: boolean },
): Member3D[] {
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 2) return [];
  const S = mmPerPoint / 1000;
  const depthM = meta.framingDepthMm / 1000;
  const members: Member3D[] = [];
  // Same list the quantity sums, so a surface that isn't deducting openings shows a batt filling
  // the daylight too rather than drawing less than it charges for.
  const pocketList = wallInsulationPocketsFor(meta, opts.deductOpenings);

  for (const pocket of pocketList) {
    const a = points[pocket.segmentIndex];
    const b = points[pocket.segmentIndex + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const dir = { x: dx / len, y: dy / len };
    const yaw = Math.atan2(dir.y, dir.x);

    const width = (pocket.x1 - pocket.x0) / 1000;
    const yb0 = pocket.yb0 / 1000;
    const yb1 = pocket.yb1 / 1000;
    const yt0 = Math.max(pocket.yt0 / 1000, yb0);
    const yt1 = Math.max(pocket.yt1 / 1000, yb1);
    if (width < 1e-9 || (yt0 - yb0 < 1e-9 && yt1 - yb1 < 1e-9)) continue;

    // Start of the pocket on the centre line, then out to the middle of the wall's own depth —
    // the batt sits inside the frame, so it straddles the centre line rather than standing off it.
    // A pocket only needs a wedge when a rake has left its top or bottom sloped. Square ones —
    // the overwhelming majority, since only the top row of a raked wall is cut — go out as plain
    // boxes so `Members` can batch them into instanced meshes. Emitting every batt as a wedge
    // gives each one its own mesh and draw call, which is what stalled the 3D view on a page
    // carrying a lot of insulation.
    const sloped = Math.abs(yb1 - yb0) > 1e-9 || Math.abs(yt1 - yt0) > 1e-9;
    if (!sloped) {
      // Box members are centred on `position` in both the along and the vertical axis.
      const centrePts = (pocket.x0 + pocket.x1) / 2 / mmPerPoint;
      const centrePage = { x: a.x + dir.x * centrePts, y: a.y + dir.y * centrePts };
      const [cx, cz] = pageToWorld(centrePage, S);
      // `Members` keys its instanced batches on the size tuple stringified, so the float noise a
      // pocket picks up round-tripping through world coordinates would give every identical bay
      // its own batch of one — no batching at all. Quantise to the micrometre, far below anything
      // visible, so bays that are the same size really do share a key.
      const micron = (v: number) => Math.round(v * 1e6) / 1e6;
      members.push({
        kind: "generic",
        position: [cx, opts.offsetM + (yb0 + yt0) / 2, cz],
        size: [micron(width), micron(yt0 - yb0), micron(depthM)],
        yaw,
        pitch: 0,
        color: opts.color,
      });
      continue;
    }
    const startPage = { x: a.x + dir.x * (pocket.x0 / mmPerPoint), y: a.y + dir.y * (pocket.x0 / mmPerPoint) };
    const [originX, originZ] = pageToWorld(startPage, S);
    members.push({
      kind: "generic",
      position: [originX, opts.offsetM, originZ],
      size: [width, Math.max(yt0, yt1), depthM],
      yaw,
      pitch: 0,
      color: opts.color,
      wedge: {
        quad: [
          [0, yb0],
          [width, yb1],
          [width, yt1],
          [0, yt0],
        ],
        depthM,
      },
    });
  }

  return members;
}

export function computeWallSurface3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  meta: WallSurfaceMeta,
  opts: { offsetM: number; color: string; deductOpenings: boolean; insulation?: boolean },
): Member3D[] {
  // Insulation shows the batts filling the frame's pockets instead of a sheet over the face.
  if (opts.insulation) {
    return computeWallBatts3D(points, mmPerPoint, meta, {
      offsetM: opts.offsetM,
      color: opts.color,
      deductOpenings: opts.deductOpenings,
    });
  }
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 2 || meta.segments.length === 0) return [];
  const S = mmPerPoint / 1000;
  const members: Member3D[] = [];

  // The panel's own centre plane, mitred. Offsetting the centre line by (depth + thickness)/2 is
  // exactly `wallFacePath` at that widened depth, so the mitre at every corner is computed the
  // same way the plate lines are and consecutive panels meet on a shared vertex. Pushing each
  // panel out along its OWN segment normal instead would leave a gap of the panel thickness at
  // every corner — the two segments' normals differ there.
  const panelPath = wallFacePath(points, meta.framingDepthMm + WALL_SURFACE_THICKNESS_M * 1000, mmPerPoint, meta.side);
  if (panelPath.length < 2) return [];
  // Whether this surface covers only part of the wall — the snapshot is the authority.
  const partialRun = meta.spanStartMm !== null || meta.spanEndMm !== null;

  for (let i = 0; i < meta.segments.length && i < panelPath.length - 1; i += 1) {
    const seg = meta.segments[i];
    const a = panelPath[i];
    const b = panelPath[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9 || !(seg.faceLengthMm > 0)) continue;
    const dir = { x: dx / len, y: dy / len };
    const yaw = Math.atan2(dir.y, dir.x);

    // A partial surface starts partway along the segment, so advance along the panel path by the
    // snapshot's own face offset before laying the panel down.
    const faceOffsetM = seg.faceStartMm / 1000;
    const [segOriginX, segOriginZ] = pageToWorld(a, S);
    const originX = segOriginX + Math.cos(yaw) * faceOffsetM;
    const originZ = segOriginZ - Math.sin(yaw) * faceOffsetM;

    // A whole-wall panel spans its own mitred length rather than the snapshot plate-line face
    // length, so corners close exactly; the two differ by at most half the panel thickness at a
    // mitred end. A partial run has real ends of its own, so it uses the measured length directly.
    // Note this must key off the snapshot's own span, NOT off comparing those two lengths — at a
    // mitred corner they differ by design, which would mistake a whole wall for a partial run and
    // reopen the corner gap.
    const lengthM = partialRun ? seg.faceLengthMm / 1000 : len * S;
    const startM = seg.startHeightMm / 1000;
    const endM = seg.endHeightMm / 1000;
    const apexM = seg.apexHeightMm !== undefined ? seg.apexHeightMm / 1000 : null;
    const apexX = apexM !== null ? Math.max(0, Math.min(1, seg.apexFrac ?? 0.5)) * lengthM : null;
    const heightAt = (x: number): number => {
      if (apexM === null || apexX === null) return startM + ((endM - startM) * x) / lengthM;
      return x <= apexX
        ? startM + (apexX > 0 ? ((apexM - startM) * x) / apexX : 0)
        : apexM + (apexX < lengthM ? ((endM - apexM) * (x - apexX)) / (lengthM - apexX) : 0);
    };

    const holes = opts.deductOpenings
      ? meta.openings
          .filter((o) => o.segmentIndex === i && o.widthMm > 0 && o.headMm > o.sillMm)
          .map((o) => ({
            x0: (o.centreMm - o.widthMm / 2) / 1000,
            x1: (o.centreMm + o.widthMm / 2) / 1000,
            sillM: o.sillMm / 1000,
            headM: o.headMm / 1000,
          }))
      : [];

    for (const strip of wallSurfaceStrips(lengthM, holes, heightAt)) {
      // The apex splits a gable strip in two so each half stays a straight-topped quad.
      const cuts = apexX !== null && apexX > strip.x0 + 1e-9 && apexX < strip.x1 - 1e-9
        ? [[strip.x0, apexX], [apexX, strip.x1]]
        : [[strip.x0, strip.x1]];
      for (const [x0, x1] of cuts) {
        const yb0 = strip.y0(x0);
        const yb1 = strip.y0(x1);
        const yt0 = Math.max(strip.y1(x0), yb0);
        const yt1 = Math.max(strip.y1(x1), yb1);
        if (x1 - x0 < 1e-9 || (yt0 - yb0 < 1e-9 && yt1 - yb1 < 1e-9)) continue;
        members.push({
          kind: "generic",
          position: [originX + Math.cos(yaw) * x0, opts.offsetM, originZ - Math.sin(yaw) * x0],
          size: [x1 - x0, Math.max(yt0, yt1), WALL_SURFACE_THICKNESS_M],
          yaw,
          pitch: 0,
          color: opts.color,
          wedge: {
            quad: [
              [0, yb0],
              [x1 - x0, yb1],
              [x1 - x0, yt1],
              [0, yt0],
            ],
            depthM: WALL_SURFACE_THICKNESS_M,
          },
        });
      }
    }
  }

  return members;
}
