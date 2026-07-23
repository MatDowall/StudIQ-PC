// 3D geometry builders (M9+). Timber framing goes through `wallMembers` (the single member model
// shared with the 2D takeoff, so the 3D view and the quantities always agree); count/length/area
// groups go through the generic builders below. World: metres, Y up, the PDF page is the floor;
// world X = page x * S, world Z = -page y * S (S = mm-per-point / 1000) — matching PageGround's
// "PDF Y → world -Z" convention. Each box member is rotated `yaw` about Y and `pitch` about its
// across-axis.

import { absArrayTrims, applyArrayTrims, type ArrayMeta, type PagePoint } from "./quantity";
import { framingDepthMm, wallMembers, STUD_THICKNESS_MM, type FramingComponentKind, type FramingSettings, type FramingSize, type WallFraming } from "./framing";

export interface Member3D {
  kind: FramingComponentKind | "generic";
  position: [number, number, number];
  size: [number, number, number];
  yaw: number;
  pitch: number;
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
 *  drawing a rafter directly along the slope. */
export function computeArrayMembers3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  meta: ArrayMeta,
  framingSize: FramingSize,
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
  const depthM = framingDepthMm(framingSize) / 1000;
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
  return members;
}

/** An "area" measurement's 3D extrusion: the polygon footprint extruded up from `offsetM` by the
 *  group's default height (or a thin slab when unset, so a flat area group still renders as a
 *  visible floor plate rather than nothing). */
export function computeAreaMesh3D(
  points: PagePoint[],
  mmPerPoint: number | null,
  opts: { heightM: number; offsetM: number; color: string },
): AreaMesh3D | null {
  if (!mmPerPoint || !(mmPerPoint > 0) || points.length < 3) return null;
  const S = mmPerPoint / 1000;
  return {
    points: points.map((p) => pageToWorld(p, S)),
    baseY: opts.offsetM,
    heightM: Math.max(opts.heightM, MIN_AREA_HEIGHT_M),
    color: opts.color,
  };
}
