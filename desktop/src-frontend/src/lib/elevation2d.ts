// 2D elevation projection of timber-framing wall members, for debug/QA PDF export.
// Projects the 3D member list (world metres, Y up) onto the along-wall / height plane of a
// single straight wall segment, so it can be drawn flat for visual quantity checking.

import type { FramingComponentKind, FramingSize, WallMember } from "./framing";

export interface ElevationRect {
  kind: FramingComponentKind;
  sizeOverride?: FramingSize;
  lengthM: number;
  x: number; // along-wall, metres, left edge
  y: number; // height, metres, bottom edge
  w: number;
  h: number;
}

export interface ElevationWedge {
  kind: FramingComponentKind;
  lengthM: number;
  /** Polygon points in (along-wall, height) metres, ready to draw. */
  points: [number, number][];
}

export interface WallElevation {
  yaw: number;
  rects: ElevationRect[];
  wedges: ElevationWedge[];
  widthM: number;
  heightM: number;
}

const YAW_PRECISION = 4;

/** Groups members by their wall segment (yaw) and projects each onto its along/height plane. */
export function computeWallElevations(members: WallMember[]): WallElevation[] {
  const groups = new Map<string, { yaw: number; members: WallMember[] }>();
  for (const m of members) {
    const key = m.yaw.toFixed(YAW_PRECISION);
    let group = groups.get(key);
    if (!group) {
      group = { yaw: m.yaw, members: [] };
      groups.set(key, group);
    }
    group.members.push(m);
  }

  return Array.from(groups.values()).map(({ yaw, members: ms }) => {
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const along = (m: WallMember) => m.position[0] * cosY - m.position[2] * sinY;

    const rects: ElevationRect[] = [];
    const wedges: ElevationWedge[] = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const expand = (x: number, y: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };

    for (const m of ms) {
      const a = along(m);
      if (m.wedge) {
        const points: [number, number][] = m.wedge.quad.map(([qx, qy]) => {
          const px = a + qx;
          const py = m.position[1] + qy;
          expand(px, py);
          return [px, py];
        });
        wedges.push({ kind: m.kind, lengthM: m.lengthM, points });
      } else {
        const x = a - m.size[0] / 2;
        const y = m.position[1] - m.size[1] / 2;
        const w = m.size[0];
        const h = m.size[1];
        expand(x, y);
        expand(x + w, y + h);
        rects.push({ kind: m.kind, sizeOverride: m.sizeOverride, lengthM: m.lengthM, x, y, w, h });
      }
    }

    if (!Number.isFinite(minX)) {
      minX = 0; maxX = 0; minY = 0; maxY = 0;
    }

    // Re-base so the elevation's local origin is (0, 0) at the bottom-left of its bounding box.
    for (const r of rects) {
      r.x -= minX;
      r.y -= minY;
    }
    for (const wdg of wedges) {
      for (const p of wdg.points) {
        p[0] -= minX;
        p[1] -= minY;
      }
    }

    return { yaw, rects, wedges, widthM: maxX - minX, heightM: maxY - minY };
  });
}
