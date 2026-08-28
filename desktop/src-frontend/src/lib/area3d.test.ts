// Area group 3D geometry — the mono-pitch tilt. Same 1 pt = 1 mm convention as framing.test.ts,
// so a 4000-pt edge is 4 m.

import { describe, expect, it } from "vitest";
import { computeAreaMesh3D } from "./framing3d";
import {
  deriveQuantity,
  parsePitchAxis,
  resolvePitch,
  transformPitchAxisJson,
  withPitchAxis,
  type GroupProps,
  type PagePoint,
  type PitchAxis,
} from "./quantity";

const MM_PER_PT = 1;

/** 4 m (page X) × 3 m (page Y) rectangle. */
const RECT: PagePoint[] = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
  { x: 4000, y: 3000 },
  { x: 0, y: 3000 },
];

const BASE = { heightM: 0.2, offsetM: 0, color: "#fff" };

/** Area of the (possibly tilted) top face, via the polygon's 3D cross-product sum. */
function tiltedAreaM2(points: [number, number][], rises: number[]): number {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < points.length; i += 1) {
    const j = (i + 1) % points.length;
    const [ax, az] = points[i];
    const [bx, bz] = points[j];
    const ay = rises[i];
    const by = rises[j];
    nx += ay * bz - az * by;
    ny += az * bx - ax * bz;
    nz += ax * by - ay * bx;
  }
  return Math.hypot(nx, ny, nz) / 2;
}

describe("computeAreaMesh3D — pitch", () => {
  it("leaves an unpitched area flat", () => {
    const mesh = computeAreaMesh3D(RECT, MM_PER_PT, BASE)!;
    expect(mesh.rises).toEqual([0, 0, 0, 0]);
  });

  it("tilts along page X for pitch direction 0, hinged on the low edge", () => {
    const mesh = computeAreaMesh3D(RECT, MM_PER_PT, { ...BASE, pitchAngleDeg: 30, pitchDirectionDeg: 0 })!;
    const rise = 4 * Math.tan(Math.PI / 6);
    // Vertices at page x = 0 stay down; the far edge lifts by run × tan θ.
    expect(mesh.rises[0]).toBeCloseTo(0, 12);
    expect(mesh.rises[3]).toBeCloseTo(0, 12);
    expect(mesh.rises[1]).toBeCloseTo(rise, 12);
    expect(mesh.rises[2]).toBeCloseTo(rise, 12);
    expect(Math.min(...mesh.rises)).toBe(0);
  });

  it("tilts along page Y for pitch direction 90", () => {
    const mesh = computeAreaMesh3D(RECT, MM_PER_PT, { ...BASE, pitchAngleDeg: 30, pitchDirectionDeg: 90 })!;
    const rise = 3 * Math.tan(Math.PI / 6);
    expect(mesh.rises[0]).toBeCloseTo(0, 12);
    expect(mesh.rises[1]).toBeCloseTo(0, 12);
    expect(mesh.rises[2]).toBeCloseTo(rise, 12);
    expect(mesh.rises[3]).toBeCloseTo(rise, 12);
  });

  it("leaves the plan footprint alone and yields the quantity's plan area / cos θ", () => {
    for (const deg of [15, 30, 45, 60]) {
      for (const dir of [0, 90]) {
        const mesh = computeAreaMesh3D(RECT, MM_PER_PT, { ...BASE, pitchAngleDeg: deg, pitchDirectionDeg: dir })!;
        expect(mesh.points).toEqual([
          [0, -0],
          [4, -0],
          [4, -3],
          [0, -3],
        ]);
        expect(tiltedAreaM2(mesh.points, mesh.rises)).toBeCloseTo(12 / Math.cos((deg * Math.PI) / 180), 10);
      }
    }
  });
});

const AXIS: PitchAxis = { angleDeg: 30, directionDeg: 0, originX: 2000, originY: 0 };

describe("pitch axis — storage in framing_json", () => {
  it("round-trips through withPitchAxis/parsePitchAxis", () => {
    const json = withPitchAxis(null, AXIS);
    expect(parsePitchAxis(json)).toEqual(AXIS);
  });

  it("merges into an existing blob without disturbing it, and clears back out", () => {
    const existing = JSON.stringify({ extraMembers: 4, spacingPts: 600 });
    const withAxis = withPitchAxis(existing, AXIS);
    const parsed = JSON.parse(withAxis!);
    expect(parsed.extraMembers).toBe(4);
    expect(parsed.spacingPts).toBe(600);
    expect(parsePitchAxis(withAxis)).toEqual(AXIS);

    const cleared = withPitchAxis(withAxis, null);
    expect(parsePitchAxis(cleared)).toBeNull();
    expect(JSON.parse(cleared!).extraMembers).toBe(4);
  });

  it("drops back to a null column once nothing else is left in the blob", () => {
    expect(withPitchAxis(withPitchAxis(null, AXIS), null)).toBeNull();
  });

  it("clamps a stored axis and ignores a blob with no pitch key", () => {
    const steep = parsePitchAxis(withPitchAxis(null, { ...AXIS, angleDeg: 120, directionDeg: 900 }));
    expect(steep!.angleDeg).toBe(89.9);
    expect(steep!.directionDeg).toBe(360);
    expect(parsePitchAxis('{"rakes":[]}')).toBeNull();
    expect(parsePitchAxis(null)).toBeNull();
    expect(parsePitchAxis("not json")).toBeNull();
  });

  it("prefers the measure's axis over the group's pitch, and falls back when it has none", () => {
    expect(resolvePitch(withPitchAxis(null, AXIS), 15, 90)).toEqual({
      angleDeg: 30,
      directionDeg: 0,
      origin: { x: 2000, y: 0 },
    });
    expect(resolvePitch(null, 15, 90)).toEqual({ angleDeg: 15, directionDeg: 90, origin: null });
  });
});

describe("computeAreaMesh3D — pitch axis pivot", () => {
  it("hinges on the pivot: level there, up one side, below the datum on the other", () => {
    // Pivot mid-shape (page x = 2000 of a 0..4000 rectangle), rising towards +X.
    const mesh = computeAreaMesh3D(RECT, MM_PER_PT, {
      ...BASE,
      pitchAngleDeg: 30,
      pitchDirectionDeg: 0,
      pitchOrigin: { x: 2000, y: 0 },
    })!;
    const t = Math.tan(Math.PI / 6);
    expect(mesh.rises[0]).toBeCloseTo(-2 * t, 12); // 2 m downhill of the pivot
    expect(mesh.rises[3]).toBeCloseTo(-2 * t, 12);
    expect(mesh.rises[1]).toBeCloseTo(2 * t, 12); // 2 m uphill
    expect(mesh.rises[2]).toBeCloseTo(2 * t, 12);
  });

  it("puts the whole shape below the datum when the pivot is its high corner", () => {
    const mesh = computeAreaMesh3D(RECT, MM_PER_PT, {
      ...BASE,
      pitchAngleDeg: 30,
      pitchDirectionDeg: 0,
      pitchOrigin: { x: 4000, y: 0 },
    })!;
    expect(Math.max(...mesh.rises)).toBeCloseTo(0, 12);
    expect(Math.min(...mesh.rises)).toBeCloseTo(-4 * Math.tan(Math.PI / 6), 12);
  });

  it("tips the other way for a negative angle", () => {
    const opts = { ...BASE, pitchDirectionDeg: 0, pitchOrigin: { x: 0, y: 0 } };
    const up = computeAreaMesh3D(RECT, MM_PER_PT, { ...opts, pitchAngleDeg: 30 })!;
    const down = computeAreaMesh3D(RECT, MM_PER_PT, { ...opts, pitchAngleDeg: -30 })!;
    up.rises.forEach((r, i) => expect(down.rises[i]).toBeCloseTo(-r, 12));
  });

  it("keeps the true area at plan / cos θ wherever the pivot sits", () => {
    for (const origin of [{ x: 0, y: 0 }, { x: 2000, y: 1500 }, { x: 4000, y: 3000 }]) {
      const mesh = computeAreaMesh3D(RECT, MM_PER_PT, {
        ...BASE,
        pitchAngleDeg: 35,
        pitchDirectionDeg: 20,
        pitchOrigin: origin,
      })!;
      expect(tiltedAreaM2(mesh.points, mesh.rises)).toBeCloseTo(12 / Math.cos((35 * Math.PI) / 180), 10);
    }
  });
});

describe("deriveQuantity — per-measurement pitch overrides the group's", () => {
  const props: GroupProps = {
    measurement_type: "area",
    default_display: "area",
    default_multiplier: 1,
    default_width: 0,
    default_height: 0,
    pitch_angle_deg: 0,
    pitch_direction_deg: 0,
  } as GroupProps;

  it("scales the plan area by 1/cos of the measure's own angle", () => {
    const flat = deriveQuantity(RECT, MM_PER_PT, props)!;
    expect(flat.value).toBeCloseTo(12, 10);
    const pitched = deriveQuantity(RECT, MM_PER_PT, props, withPitchAxis(null, { ...AXIS, angleDeg: 30 }))!;
    expect(pitched.value).toBeCloseTo(12 / Math.cos(Math.PI / 6), 10);
  });

  it("reads the same for a negative angle — a plane tipped the other way has the same area", () => {
    const up = deriveQuantity(RECT, MM_PER_PT, props, withPitchAxis(null, { ...AXIS, angleDeg: 30 }))!;
    const down = deriveQuantity(RECT, MM_PER_PT, props, withPitchAxis(null, { ...AXIS, angleDeg: -30 }))!;
    expect(down.value).toBeCloseTo(up.value, 12);
  });

  it("beats the group's own pitch angle when both are set", () => {
    const grouped = { ...props, pitch_angle_deg: 45 };
    const q = deriveQuantity(RECT, MM_PER_PT, grouped, withPitchAxis(null, { ...AXIS, angleDeg: 30 }))!;
    expect(q.value).toBeCloseTo(12 / Math.cos(Math.PI / 6), 10);
  });

  it("uses the measure's direction for the perimeter, which IS direction-dependent", () => {
    const perim = { ...props, default_display: "perimeter" };
    const alongX = deriveQuantity(RECT, MM_PER_PT, perim, withPitchAxis(null, { ...AXIS, angleDeg: 30, directionDeg: 0 }))!;
    const alongY = deriveQuantity(RECT, MM_PER_PT, perim, withPitchAxis(null, { ...AXIS, angleDeg: 30, directionDeg: 90 }))!;
    // Falling along X stretches the two 4 m edges; along Y stretches the two 3 m edges.
    expect(alongX.value).toBeCloseTo(2 * (4 / Math.cos(Math.PI / 6)) + 2 * 3, 10);
    expect(alongY.value).toBeCloseTo(2 * 4 + 2 * (3 / Math.cos(Math.PI / 6)), 10);
  });
});

describe("transformPitchAxisJson — the pivot travels with the geometry", () => {
  const json = withPitchAxis(null, { angleDeg: 45, directionDeg: 90, originX: 100, originY: 200 });

  it("translates the pivot and leaves the bearing alone", () => {
    const moved = parsePitchAxis(transformPitchAxisJson(json, (p) => ({ x: p.x - 136, y: p.y + 136 })))!;
    expect(moved).toEqual({ angleDeg: 45, directionDeg: 90, originX: -36, originY: 336 });
  });

  it("mirrors the bearing about the right axis for each flip", () => {
    // Mirroring x: an uphill of 0° (page +X) becomes 180°; 90° (page +Y) is untouched.
    const flipX = (deg: number) => parsePitchAxis(
      transformPitchAxisJson(withPitchAxis(null, { angleDeg: 30, directionDeg: deg, originX: 10, originY: 0 }), (p) => ({ x: -p.x, y: p.y }), (d) => 180 - d),
    )!;
    expect(flipX(0).directionDeg).toBe(180);
    expect(flipX(90).directionDeg).toBe(90);
    expect(flipX(-90).directionDeg).toBe(-90);
    expect(flipX(0).originX).toBe(-10);

    // Mirroring y: 90° becomes −90°; 0° is untouched.
    const flipY = (deg: number) => parsePitchAxis(
      transformPitchAxisJson(withPitchAxis(null, { angleDeg: 30, directionDeg: deg, originX: 0, originY: 10 }), (p) => ({ x: p.x, y: -p.y }), (d) => -d),
    )!;
    expect(flipY(90).directionDeg).toBe(-90);
    expect(flipY(0).directionDeg).toBe(0);
  });

  it("turns the bearing a quarter turn with the shape", () => {
    const ccw = parsePitchAxis(transformPitchAxisJson(json, (p) => ({ x: -p.y, y: p.x }), (d) => d + 90))!;
    expect(ccw.directionDeg).toBe(180);
    expect(ccw).toMatchObject({ originX: -200, originY: 100 });
    const cw = parsePitchAxis(transformPitchAxisJson(json, (p) => ({ x: p.y, y: -p.x }), (d) => d - 90))!;
    expect(cw.directionDeg).toBe(0);
  });

  it("wraps rather than clamps, so repeated turns stay in range", () => {
    let out = json;
    for (let i = 0; i < 8; i += 1) out = transformPitchAxisJson(out, (p) => p, (d) => d + 90);
    const dir = parsePitchAxis(out)!.directionDeg;
    expect(dir).toBeGreaterThanOrEqual(-180);
    expect(dir).toBeLessThan(180);
    expect(dir).toBe(90); // eight quarter turns is a full 720° round trip
  });

  it("passes a measurement with no axis straight through", () => {
    expect(transformPitchAxisJson(null, (p) => ({ x: p.x + 5, y: p.y }))).toBeNull();
    const arrayMeta = JSON.stringify({ extraMembers: 3 });
    expect(transformPitchAxisJson(arrayMeta, (p) => ({ x: p.x + 5, y: p.y }))).toBe(arrayMeta);
  });
});
