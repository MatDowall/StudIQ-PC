// Timber Framing — 3D members (M9). Thin adapter over `wallMembers` (the single member model shared
// with the 2D takeoff, so the 3D view and the quantities always agree). World: metres, Y up, the PDF
// page is the floor; each member is a box rotated `yaw` about Y and `pitch` about its across-axis.

import type { PagePoint } from "./quantity";
import { wallMembers, type FramingComponentKind, type FramingSettings, type WallFraming } from "./framing";

export interface Member3D {
  kind: FramingComponentKind;
  position: [number, number, number];
  size: [number, number, number];
  yaw: number;
  pitch: number;
  wedge?: { quad: [number, number][]; depthM: number };
}

/** Member colours, loosely matching docs/window makeup.png + the 3D references. */
export const MEMBER_COLOURS: Record<string, string> = {
  plate: "#C77F2E",
  stud: "#3F6FB0",
  dwang: "#7A7F87",
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
