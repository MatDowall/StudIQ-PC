import { describe, expect, it } from "vitest";
import {
  buildWallSurfaceMeta,
  pointInWallFace,
  wallBodyQuads,
  wallFacePath,
  wallFaceQuads,
  wallInsulationPockets,
  wallPathLengthMm,
  type WallPocket,
  wallSurfaceMetaMatches,
  wallSurfaceSpanQuads,
  DEFAULT_FRAMING_SETTINGS,
  type FramingSettings,
  type WallFraming,
} from "./framing";
import { computeWallSurface3D } from "./framing3d";
import {
  parseWallSurfaceMeta,
  serializeWallSurfaceMeta,
  wallSurfaceAreaM2,
  wallInsulationAreaM2,
  wallInsulationPocketsFor,
  wallSpansOverlap,
  isWallInsulationType,
  isWallSurfaceType,
  wallSurfaceDeducts,
  wallSurfaceSpanOf,
  wallSurfaceMeasureM2,
  wallSurfacePocketAreaMm2,
  wallSurfaceSegmentAreaMm2,
  type GroupProps,
  type PagePoint,
} from "./quantity";

// 1 point = 10 mm, so a 300 pt wall is exactly 3 m — keeps the expected areas readable.
const MMPP = 10;
const settings = (over: Partial<FramingSettings> = {}): FramingSettings => ({ ...DEFAULT_FRAMING_SETTINGS, ...over });
const straightWall: PagePoint[] = [
  { x: 0, y: 0 },
  { x: 300, y: 0 },
];
const props = (framingPropsJson: string | null): Pick<GroupProps, "framing_props_json"> => ({ framing_props_json: framingPropsJson });
/** Group props for one of the two framing-derived surface types. */
const surfaceProps = (
  measurementType: string,
  deductOpenings = true,
): Pick<GroupProps, "measurement_type" | "framing_props_json"> => ({
  measurement_type: measurementType,
  framing_props_json: JSON.stringify({ deductOpenings }),
});

describe("wall face geometry", () => {
  it("offsets the face by half the wall depth, to either side", () => {
    // 90x45 framing → 90 mm deep → 4.5 pt off the centre line at 10 mm/pt.
    expect(wallFacePath(straightWall, 90, MMPP, "left")).toEqual([
      { x: 0, y: 4.5 },
      { x: 300, y: 4.5 },
    ]);
    expect(wallFacePath(straightWall, 90, MMPP, "right")).toEqual([
      { x: 0, y: -4.5 },
      { x: 300, y: -4.5 },
    ]);
  });

  it("picks a point inside the hovered face strip and rejects the other side", () => {
    const left = wallFaceQuads(straightWall, 90, MMPP, "left");
    const right = wallFaceQuads(straightWall, 90, MMPP, "right");
    expect(pointInWallFace({ x: 150, y: 2 }, left)).toBe(true);
    expect(pointInWallFace({ x: 150, y: 2 }, right)).toBe(false);
    expect(pointInWallFace({ x: 150, y: -2 }, right)).toBe(true);
    expect(pointInWallFace({ x: 150, y: 20 }, left)).toBe(false);
  });

  it("gives the inside and outside of a corner different face lengths", () => {
    // An L-shaped wall: the mitre pulls one face in and pushes the other out.
    const corner: PagePoint[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
    ];
    const inner = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, "left", null, 0)!;
    const outer = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, "right", null, 0)!;
    const total = (m: typeof inner) => m.segments.reduce((sum, seg) => sum + seg.faceLengthMm, 0);
    expect(total(inner)).toBeLessThan(total(outer));
    // Both segments meet the corner, and each one's mitred end moves half the wall depth in on
    // the inside and half back out on the outside: 4 × 45 mm across the pair.
    expect(total(inner)).toBeCloseTo(2 * (3000 - 45), 6);
    expect(total(outer)).toBeCloseTo(2 * (3000 + 45), 6);
  });
});

describe("wall surface area", () => {
  it("is plate run × wall height for a plain wall", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, undefined, "left", null, 0)!;
    expect(wallSurfaceAreaM2(meta, true)).toBeCloseTo(3 * 2.4, 9);
  });

  it("follows a raking frame, using the mean height over the segment", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, framing, "left", null, 0)!;
    expect(meta.segments[0]).toMatchObject({ startHeightMm: 2400, endHeightMm: 3600 });
    expect(wallSurfaceAreaM2(meta, true)).toBeCloseTo(3 * 3.0, 9);
  });

  it("follows a gable rake as two runs meeting at the apex", () => {
    // Apex a quarter of the way along: 0.25 × mean(2400,4000) + 0.75 × mean(4000,2400) — the
    // apex position cancels for a symmetric pair of heights, so shift one end to prove it doesn't.
    const framing: WallFraming = {
      openings: [],
      rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2000, gable: true, middleMm: 4000, middlePositionMm: 750 }],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, framing, "left", null, 0)!;
    expect(meta.segments[0].apexFrac).toBeCloseTo(0.25, 9);
    const expectedMm2 = 3000 * (0.25 * ((2400 + 4000) / 2) + 0.75 * ((4000 + 2000) / 2));
    expect(wallSurfaceSegmentAreaMm2(meta.segments[0])).toBeCloseTo(expectedMm2, 6);
    expect(wallSurfaceAreaM2(meta, true)).toBeCloseTo(expectedMm2 / 1e6, 9);
  });

  it("deducts a door's full daylight and a window's glass hole only when deducting is on", () => {
    const framing: WallFraming = {
      openings: [
        { kind: "door", segmentIndex: 0, centreMm: 700, daylightHeightMm: 2000, daylightWidthMm: 900, lintelSize: "90x45", lintelPly: 2 },
        { kind: "window", segmentIndex: 0, centreMm: 2200, daylightHeightMm: 1200, daylightWidthMm: 1500, lintelSize: "90x45", lintelPly: 2, sillHeightMm: 900 },
      ],
      rakes: [],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, framing, "left", null, 0)!;
    expect(meta.openings).toEqual([
      { segmentIndex: 0, centreMm: 700, frameCentreMm: 700, widthMm: 900, headMm: 2000, sillMm: 0 },
      { segmentIndex: 0, centreMm: 2200, frameCentreMm: 2200, widthMm: 1500, headMm: 2100, sillMm: 900 },
    ]);
    const gross = 3 * 2.4;
    const holes = (0.9 * 2.0) + (1.5 * 1.2);
    expect(wallSurfaceAreaM2(meta, false)).toBeCloseTo(gross, 9);
    expect(wallSurfaceAreaM2(meta, true)).toBeCloseTo(gross - holes, 9);
  });

  it("takes the deduction from the surface's own override, else the group default", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null, 0)!;
    expect(wallSurfaceDeducts(meta, props(null))).toBe(true);
    expect(wallSurfaceDeducts(meta, props(JSON.stringify({ deductOpenings: false })))).toBe(false);
    expect(wallSurfaceDeducts({ ...meta, deductOpenings: true }, props(JSON.stringify({ deductOpenings: false })))).toBe(true);
    expect(wallSurfaceDeducts({ ...meta, deductOpenings: false }, props(null))).toBe(false);
  });
});

describe("wall surface snapshot", () => {
  it("round-trips through JSON", () => {
    const meta = buildWallSurfaceMeta(7, 9, straightWall, settings(), MMPP, undefined, "right", false, 0)!;
    expect(parseWallSurfaceMeta(serializeWallSurfaceMeta(meta))).toEqual(meta);
  });

  it("detects framing drift but ignores the estimator's own deduction choice", () => {
    const base = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, undefined, "left", null, 0)!;
    const taller = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2700 }), MMPP, undefined, "left", null, 0)!;
    expect(wallSurfaceMetaMatches(base, { ...base, deductOpenings: false })).toBe(true);
    expect(wallSurfaceMetaMatches(base, taller)).toBe(false);
  });

  it("falls back to an empty snapshot for missing or foreign blobs", () => {
    expect(parseWallSurfaceMeta(null).segments).toEqual([]);
    expect(parseWallSurfaceMeta(JSON.stringify({ type: "array", extraMembers: 3 })).segments).toEqual([]);
    expect(parseWallSurfaceMeta("{ not json").segments).toEqual([]);
  });
});

describe("wall surface 3D", () => {
  const corner: PagePoint[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 300 },
  ];

  /** Where a panel's far end lands in world space: its origin run out along its own yaw. */
  const endOf = (m: ReturnType<typeof computeWallSurface3D>[number]): [number, number] => [
    m.position[0] + Math.cos(m.yaw) * m.size[0],
    m.position[2] - Math.sin(m.yaw) * m.size[0],
  ];

  // The bug this guards: offsetting each panel out along its OWN segment normal (rather than
  // mitring the offset) left a gap of the panel thickness at every corner — visible in 3D as a
  // notch where two wall faces should meet.
  it.each(["left", "right"] as const)("closes the corner on the %s face", (side) => {
    const meta = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, side, null, 0)!;
    const panels = computeWallSurface3D(corner, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    expect(panels).toHaveLength(2);
    const [endX, endZ] = endOf(panels[0]);
    expect(endX).toBeCloseTo(panels[1].position[0], 9);
    expect(endZ).toBeCloseTo(panels[1].position[2], 9);
  });

  it("stands the panel on the measured face, not the wall centre line", () => {
    // A single straight wall running along +X: the left face sits at +halfDepth in page Y, which
    // maps to NEGATIVE world Z (pageToWorld flips Y). 90 mm framing + 20 mm panel → 55 mm out.
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null, 0)!;
    const [panel] = computeWallSurface3D(straightWall, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    expect(panel.position[2]).toBeCloseTo(-0.055, 9);
    const right = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "right", null, 0)!;
    const [rightPanel] = computeWallSurface3D(straightWall, MMPP, right, { offsetM: 0, color: "#fff", deductOpenings: true });
    expect(rightPanel.position[2]).toBeCloseTo(0.055, 9);
  });

  it("splits the panel around a deducted opening and leaves it whole when not deducting", () => {
    const framing: WallFraming = {
      openings: [
        { kind: "door", segmentIndex: 0, centreMm: 1500, daylightHeightMm: 2000, daylightWidthMm: 900, lintelSize: "90x45", lintelPly: 2 },
      ],
      rakes: [],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, framing, "left", null, 0)!;
    const opts = { offsetM: 0, color: "#fff" };
    // Left of the door, the spandrel over it, right of the door.
    expect(computeWallSurface3D(straightWall, MMPP, meta, { ...opts, deductOpenings: true })).toHaveLength(3);
    expect(computeWallSurface3D(straightWall, MMPP, meta, { ...opts, deductOpenings: false })).toHaveLength(1);
  });
});

describe("openings trimmed by a rake", () => {
  // The reported edge case: a "gable" whose apex and end are at the same height, so the wall rakes
  // up over the first third of its run and is flat thereafter. A 6 m wall, apex at 2 m.
  const rakeThenFlat: PagePoint[] = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
  ];
  const raked = settings({ wallHeightMm: 2400 });
  const framing = (centreMm: number): WallFraming => ({
    openings: [{ kind: "door", segmentIndex: 0, centreMm, daylightHeightMm: 2100, daylightWidthMm: 910, lintelSize: "190x45", lintelPly: 2 }],
    rakes: [{ segmentIndex: 0, startMm: 1200, endMm: 2400, gable: true, middleMm: 2400, middlePositionMm: 2000 }],
    extraStuds: [],
  });

  it("snapshots the head the frame actually carries, not the nominal daylight height", () => {
    // Under the rake the lintel is pushed down to the underside of the top plate over the LOWER
    // king (at 945 mm: roofline 1767, less the 190 lintel and the 45 plate makeup) — well below
    // the door's nominal 2100 head.
    const under = buildWallSurfaceMeta(1, 2, rakeThenFlat, raked, MMPP, framing(1400), "left", true, 0)!;
    expect(under.openings[0].headMm).toBeCloseTo(1491.5, 6);
    // Clear of the rake, the nominal head stands.
    const clear = buildWallSurfaceMeta(1, 2, rakeThenFlat, raked, MMPP, framing(4000), "left", true, 0)!;
    expect(clear.openings[0].headMm).toBeCloseTo(2100, 6);
  });

  it("leaves the band between a trimmed head and the roofline as insulation pockets", () => {
    const pockets = wallInsulationPockets(rakeThenFlat, raked, MMPP, framing(1400));
    // Nothing may start at the nominal head — the space between the lintel top (1681.5) and the
    // roofline is solid frame to be insulated, not daylight.
    expect(pockets.some((p) => Math.abs(p.yb0 - 2100) < 1e-6)).toBe(false);
    const overDoor = pockets.filter((p) => p.x0 >= 945 - 1e-6 && p.x1 <= 1855 + 1e-6);
    expect(overDoor.length).toBeGreaterThan(0);
    for (const pocket of overDoor) {
      expect(pocket.yb0).toBeCloseTo(1681.5, 6);
      // A pocket is never inverted: the sweep must not put a floor above its own roofline.
      expect(pocket.yt0).toBeGreaterThan(pocket.yb0);
      expect(pocket.yt1).toBeGreaterThan(pocket.yb1);
    }
  });

  it("stops the lining hole at the trimmed head", () => {
    const meta = buildWallSurfaceMeta(1, 2, rakeThenFlat, raked, MMPP, framing(1400), "left", true, 0)!;
    const panels = computeWallSurface3D(rakeThenFlat, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    // The spandrel over the door survives (it would collapse to nothing at a 2100 head, leaving a
    // full-height hole in the lining) and its underside sits on the lintel, not at 2100.
    const spandrel = panels.find((m) => m.wedge!.quad[0][1] > 1e-6)!;
    expect(spandrel.wedge!.quad[0][1]).toBeCloseTo(1.4915, 6);
    expect(spandrel.wedge!.quad[3][1]).toBeGreaterThan(spandrel.wedge!.quad[0][1]);
  });
});

describe("openings straddling a segment join", () => {
  // How a wall is made to rake over part of its run: one straight line split at a vertex, the
  // first stretch raked and the rest flat. A door set out near the start of the flat stretch runs
  // back past the split — `wallMembers` frames it across the join, so the surface must cut it
  // across the join too. 1 pt = 10 mm, so this is 3 m of rake then 3 m flat.
  const split: PagePoint[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 600, y: 0 },
  ];
  const raked = settings({ wallHeightMm: 2400 });
  // Daylight 1700 wide centred 600 along segment 1 -> it overhangs 250 mm back onto segment 0.
  const straddling: WallFraming = {
    openings: [{ kind: "door", segmentIndex: 1, centreMm: 600, daylightHeightMm: 2100, daylightWidthMm: 1700, lintelSize: "140x45", lintelPly: 2 }],
    rakes: [{ segmentIndex: 0, startMm: 1300, endMm: 2400 }],
    extraStuds: [],
  };

  it("cuts the daylight across both segments instead of clipping it to its own", () => {
    const meta = buildWallSurfaceMeta(1, 2, split, raked, MMPP, straddling, "left", true, 0)!;
    expect(meta.openings.map((o) => o.segmentIndex)).toEqual([0, 1]);
    expect(meta.openings[0].widthMm).toBeCloseTo(250, 6);
    expect(meta.openings[1].widthMm).toBeCloseTo(1450, 6);
    // The whole door is accounted for, and the piece on its own segment keeps its true set-out
    // rather than being re-centred on what survived the clip.
    expect(meta.openings.reduce((a, o) => a + o.widthMm, 0)).toBeCloseTo(1700, 6);
    expect(meta.openings[1].frameCentreMm).toBeCloseTo(725, 6);
    // One lintel spans the join, so both pieces carry the same head.
    expect(meta.openings[0].headMm).toBeCloseTo(meta.openings[1].headMm, 9);
  });

  it("punches the lining on both sides of the join", () => {
    const meta = buildWallSurfaceMeta(1, 2, split, raked, MMPP, straddling, "left", true, 0)!;
    const panels = computeWallSurface3D(split, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    // Segment 0 previously ran solid over the doorway. Anything of it still covering the last
    // 250 mm before the join must now start at the head — only the spandrel survives there.
    const headM = meta.openings[0].headMm / 1000;
    const overDoorway = panels.filter((m) => m.position[0] + m.size[0] > 2.75 + 1e-6 && m.position[0] < 3 - 1e-6);
    expect(overDoorway.length).toBeGreaterThan(0);
    for (const panel of overDoorway) {
      expect(Math.min(panel.wedge!.quad[0][1], panel.wedge!.quad[1][1])).toBeCloseTo(headM, 6);
    }
  });

  it("blocks the batts with the jambs and lintel that stand past the join", () => {
    // The opening's kings, trimmers and lintel are set out from segment 1 but physically stand on
    // segment 0. They have to block segment 0's cavity, or a batt is drawn straight through them.
    const pockets = wallInsulationPockets(split, raked, MMPP, straddling);
    const meta = buildWallSurfaceMeta(1, 2, split, raked, MMPP, straddling, "left", true, 0)!;
    const lintelTopMm = meta.openings[0].headMm + 140;
    // The king sits at 2660, so from there on nothing may run below the lintel: the jamb studs and
    // the lintel itself fill that stretch, and a pocket through them draws a batt inside timber.
    const past = pockets.filter((p) => p.segmentIndex === 0 && p.x1 > 2660 + 1e-6);
    expect(past.length).toBeGreaterThan(0);
    for (const p of past) expect(Math.min(p.yb0, p.yb1)).toBeGreaterThanOrEqual(lintelTopMm - 1e-6);
    // The bay before the king is untouched and still runs off the bottom plate.
    expect(pockets.some((p) => p.segmentIndex === 0 && p.x1 <= 2660 + 1e-6 && p.yb0 < 100)).toBe(true);
  });

  it("carries the cut along a whole straight run, however many segments", () => {
    // Nothing about this is two-segment-specific: a wide opening reaches as far as the run does.
    const threeSeg: PagePoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 160, y: 0 },
      { x: 500, y: 0 },
    ];
    const wide: WallFraming = {
      openings: [{ kind: "door", segmentIndex: 1, centreMm: 300, daylightHeightMm: 2100, daylightWidthMm: 2400, lintelSize: "140x45", lintelPly: 2 }],
      rakes: [],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, threeSeg, raked, MMPP, wide, "left", true, 0)!;
    expect(meta.openings.map((o) => o.segmentIndex)).toEqual([0, 1, 2]);
    expect(meta.openings.reduce((a, o) => a + o.widthMm, 0)).toBeCloseTo(2400, 6);
  });

  it("works the other way round, and for a window's sill", () => {
    // An opening set out on an EARLIER segment running past its end is the same problem mirrored.
    const forward: WallFraming = {
      openings: [{ kind: "window", segmentIndex: 0, centreMm: 2700, daylightHeightMm: 1200, daylightWidthMm: 1800, sillHeightMm: 900, lintelSize: "140x45", lintelPly: 2 }],
      rakes: [],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, split, raked, MMPP, forward, "left", true, 0)!;
    expect(meta.openings.map((o) => o.segmentIndex)).toEqual([0, 1]);
    expect(meta.openings.reduce((a, o) => a + o.widthMm, 0)).toBeCloseTo(1800, 6);
    for (const o of meta.openings) expect(o.sillMm).toBeCloseTo(900, 6);
  });

  it("stops the cut at a corner, where the frame puts no door either", () => {
    // `wallMembers` extrapolates an overhanging jamb along its own segment's direction, straight
    // past a corner rather than around it. So the daylight must clip at the join, or the hole
    // wraps into the return wall's lining while the jambs and lintel do not follow it there.
    const corner: PagePoint[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
    ];
    const overhang: WallFraming = {
      openings: [{ kind: "door", segmentIndex: 1, centreMm: 600, daylightHeightMm: 2100, daylightWidthMm: 1700, lintelSize: "140x45", lintelPly: 2 }],
      rakes: [],
      extraStuds: [],
    };
    const meta = buildWallSurfaceMeta(1, 2, corner, raked, MMPP, overhang, "left", true, 0)!;
    expect(meta.openings.map((o) => o.segmentIndex)).toEqual([1]);
    expect(meta.openings[0].widthMm).toBeCloseTo(1450, 6);
  });

  it("leaves a corner's cavities alone", () => {
    // The cross-join rule is for one straight run split at a vertex. A segment that turns a corner
    // must not start blocking its neighbour's bays, or every corner in the job changes quantity.
    const corner: PagePoint[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
    ];
    const plainWall = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });
    const first = wallInsulationPockets(corner, plainWall, MMPP, undefined).filter((p) => p.segmentIndex === 0);
    expect(first.length).toBeGreaterThan(0);
    // Every bay still runs plate to plate; the return wall's studs cross this segment's line but
    // must not be taken as blockers on it.
    for (const p of first) {
      expect(p.yb0).toBeCloseTo(45, 6);
      expect(p.yt0).toBeCloseTo(2355, 6);
    }
  });

  it("stops the batts at the true edge of the doorway", () => {
    const pockets = wallInsulationPockets(split, raked, MMPP, straddling);
    // Nothing on the raked segment may sit inside the overhang (2750 mm along it) below the head.
    const inDoorway = pockets.filter(
      (p) => p.segmentIndex === 0 && p.x1 > 2750 + 1e-6 && p.yb0 < 1700,
    );
    expect(inDoorway).toEqual([]);
  });
});

describe("insulation pockets", () => {
  // A plain 3 m x 2.4 m wall, single top and bottom plate, no dwangs. Its stud set-out is flush
  // end studs at 22.5 and 2977.5 with 600 centres between, so the pockets are hand-checkable.
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });

  it("leaves exactly the voids between the studs and plates", () => {
    const pockets = wallInsulationPockets(straightWall, plain, MMPP, undefined);
    // 6 studs -> 5 bays. Four at 600 centres (600 - 45 = 555 clear) and a last one of 510,
    // each running the full 2310 between the plates.
    // Widths come back through a world-coordinate round trip, so compare at mm precision.
    const widths = pockets.map((p) => p.x1 - p.x0).sort((a, b) => a - b);
    expect(widths).toHaveLength(5);
    for (const [i, expected] of [510, 555, 555, 555, 555].entries()) {
      expect(widths[i]).toBeCloseTo(expected, 6);
    }
    for (const pocket of pockets) {
      expect(pocket.yb0).toBeCloseTo(45, 9); // top of the bottom plate
      expect(pocket.yt0).toBeCloseTo(2355, 9); // underside of the top plate
    }
    const areaMm2 = pockets.reduce((sum, p) => sum + wallSurfacePocketAreaMm2(p), 0);
    expect(areaMm2).toBeCloseTo(2730 * 2310, 6);
  });

  it("equals the face area less every framing member, independently derived", () => {
    // Cross-check against gross - Σ(member elevation areas): 2 plates at 3000 x 45, plus
    // 6 studs at 45 x 2310. The two derivations share no code beyond `wallMembers`.
    const gross = 3000 * 2400;
    const framed = 2 * (3000 * 45) + 6 * (45 * 2310);
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    expect(wallInsulationAreaM2(meta) * 1e6).toBeCloseTo(gross - framed, 6);
  });

  it("is always smaller than the lining measure of the same wall", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null, 0)!;
    expect(wallInsulationAreaM2(meta)).toBeGreaterThan(0);
    expect(wallInsulationAreaM2(meta)).toBeLessThan(wallSurfaceAreaM2(meta, true));
  });

  it("adds a pocket row when dwangs break the bays up, without changing the total", () => {
    const noDwangs = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const withDwangs = buildWallSurfaceMeta(
      1, 2, straightWall,
      settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: true, dwangCentresMm: 800 }),
      MMPP, undefined, "left", null, 0,
    )!;
    expect(withDwangs.pockets.length).toBeGreaterThan(noDwangs.pockets.length);
    // Dwangs are real timber, so they come out of the insulation area.
    expect(wallInsulationAreaM2(withDwangs)).toBeLessThan(wallInsulationAreaM2(noDwangs));
  });

  it("puts no pocket inside a door opening", () => {
    const framing: WallFraming = {
      openings: [
        { kind: "door", segmentIndex: 0, centreMm: 1500, daylightHeightMm: 2000, daylightWidthMm: 900, lintelSize: "90x45", lintelPly: 2 },
      ],
      rakes: [],
      extraStuds: [],
    };
    const pockets = wallInsulationPockets(straightWall, plain, MMPP, framing);
    const doorLeft = 1500 - 450;
    const doorRight = 1500 + 450;
    for (const pocket of pockets) {
      const insideX = pocket.x0 >= doorLeft - 1e-6 && pocket.x1 <= doorRight + 1e-6;
      // Anything spanning the doorway horizontally must sit clear above the head.
      if (insideX) expect(pocket.yb0).toBeGreaterThanOrEqual(2000 - 1e-6);
    }
  });

  it("follows a rake, trimming the top pockets to the roofline", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0)!;
    const flat = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    // A taller wall has more cavity, and no pocket may poke above the sloping top plate.
    expect(wallInsulationAreaM2(meta)).toBeGreaterThan(wallInsulationAreaM2(flat));
    for (const pocket of meta.pockets) {
      const roofAt = (x: number) => 2400 + (3600 - 2400) * (x / 3000);
      expect(pocket.yt0).toBeLessThanOrEqual(roofAt(pocket.x0) + 1e-6);
      expect(pocket.yt1).toBeLessThanOrEqual(roofAt(pocket.x1) + 1e-6);
    }
  });

  it("measures by the group's own type, off one shared snapshot", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    expect(wallSurfaceMeasureM2(meta, surfaceProps("wall_surface"))).toBeCloseTo(3 * 2.4, 9);
    expect(wallSurfaceMeasureM2(meta, surfaceProps("wall_insulation"))).toBeCloseTo(wallInsulationAreaM2(meta), 9);
    // The deduction flag is the estimator's, for both types.
    expect(wallSurfaceDeducts(meta, surfaceProps("wall_insulation", false))).toBe(false);
    expect(wallSurfaceDeducts(meta, surfaceProps("wall_surface", false))).toBe(false);
  });

  it("recognises both surface types, and only insulation as insulation", () => {
    expect(isWallSurfaceType("wall_surface")).toBe(true);
    expect(isWallSurfaceType("wall_insulation")).toBe(true);
    expect(isWallSurfaceType("timber_framing")).toBe(false);
    expect(isWallInsulationType("wall_insulation")).toBe(true);
    expect(isWallInsulationType("wall_surface")).toBe(false);
  });

  it("renders one batt per pocket, in the cavity rather than on the face", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const batts = computeWallSurface3D(straightWall, MMPP, meta, {
      offsetM: 0, color: "#fff", deductOpenings: true, insulation: true,
    });
    expect(batts).toHaveLength(meta.pockets.length);
    // Batts sit on the wall centre line and fill its full depth; a lining panel stands off it.
    for (const batt of batts) expect(batt.position[2]).toBeCloseTo(0, 9);
    expect(batts[0].size[2]).toBeCloseTo(0.09, 9);
  });
});

describe("insulation targets the wall, not a face", () => {
  it("picks the whole wall body, both sides of the centre line", () => {
    const body = wallBodyQuads(straightWall, 90, MMPP);
    // A lining's face strip only covers its own side; the body covers both.
    expect(pointInWallFace({ x: 150, y: 2 }, body)).toBe(true);
    expect(pointInWallFace({ x: 150, y: -2 }, body)).toBe(true);
    // Still bounded by the wall's own thickness — 4.5 pt either side at 10 mm/pt.
    expect(pointInWallFace({ x: 150, y: 6 }, body)).toBe(false);
    expect(pointInWallFace({ x: 150, y: -6 }, body)).toBe(false);
  });

  it("gives both faces the same batts, so measuring either side is the same quantity", () => {
    const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });
    const left = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const right = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "right", null, 0)!;
    expect(wallInsulationAreaM2(left)).toBeCloseTo(wallInsulationAreaM2(right), 9);
    expect(left.pockets).toEqual(right.pockets);
  });
});

describe("insulation opening deduction", () => {
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });
  const framing: WallFraming = {
    openings: [
      { kind: "door", segmentIndex: 0, centreMm: 1500, daylightHeightMm: 2000, daylightWidthMm: 900, lintelSize: "90x45", lintelPly: 2 },
    ],
    rakes: [],
    extraStuds: [],
  };
  const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0)!;

  it("adds the daylight back exactly when openings are not deducted", () => {
    const deducted = wallInsulationAreaM2(meta, true);
    const gross = wallInsulationAreaM2(meta, false);
    // The daylight is clear of framing by construction, so the difference is exactly its area.
    expect(gross - deducted).toBeCloseTo((0.9 * 2.0), 9);
    expect(gross).toBeGreaterThan(deducted);
  });

  it("gives the added-back daylight its own pocket, on the frame's set-out", () => {
    const deducted = wallInsulationPocketsFor(meta, true);
    const gross = wallInsulationPocketsFor(meta, false);
    expect(gross).toHaveLength(deducted.length + 1);
    const added = gross[gross.length - 1];
    expect(added.x0).toBeCloseTo(1500 - 450, 9);
    expect(added.x1).toBeCloseTo(1500 + 450, 9);
    expect(added.yb0).toBeCloseTo(0, 9);
    expect(added.yt0).toBeCloseTo(2000, 9);
  });

  it("keeps the frame's own set-out separate from the mitred face set-out", () => {
    const cornerWall: PagePoint[] = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
    ];
    // On the inner face the mitre shortens the segment, so the face position of an opening is
    // pulled in while its position on the frame is untouched.
    const inner = buildWallSurfaceMeta(1, 2, cornerWall, plain, MMPP, framing, "left", null, 0)!;
    expect(inner.openings[0].frameCentreMm).toBeCloseTo(1500, 9);
    expect(inner.openings[0].centreMm).toBeLessThan(1500);
  });

  it("honours the flag through the measure dispatcher", () => {
    const on = surfaceProps("wall_insulation", true);
    const off = surfaceProps("wall_insulation", false);
    expect(wallSurfaceMeasureM2(meta, on)).toBeCloseTo(wallInsulationAreaM2(meta, true), 9);
    expect(wallSurfaceMeasureM2(meta, off)).toBeCloseTo(wallInsulationAreaM2(meta, false), 9);
  });

  it("draws a batt in the daylight only when it is being counted", () => {
    const base = { offsetM: 0, color: "#fff", insulation: true };
    const on = computeWallSurface3D(straightWall, MMPP, meta, { ...base, deductOpenings: true });
    const off = computeWallSurface3D(straightWall, MMPP, meta, { ...base, deductOpenings: false });
    expect(off).toHaveLength(on.length + 1);
  });
});

describe("partial runs along a wall", () => {
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });
  const whole = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;

  it("measures only the drawn stretch", () => {
    // Middle metre of a 3 m wall.
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    expect(run.spanStartMm).toBe(1000);
    expect(run.spanEndMm).toBe(2000);
    expect(wallSurfaceAreaM2(run, true)).toBeCloseTo(1 * 2.4, 9);
    expect(wallSurfaceAreaM2(whole, true)).toBeCloseTo(3 * 2.4, 9);
  });

  it("normalises a run drawn backwards, and clamps one drawn past the ends", () => {
    const backwards = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 2000, endMm: 1000 })!;
    expect(backwards.spanStartMm).toBe(1000);
    expect(backwards.spanEndMm).toBe(2000);
    const overshoot = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: -500, endMm: 9999 })!;
    // Clamped back to the whole wall, which is stored as "no span" rather than an explicit range.
    expect(overshoot.spanStartMm).toBeNull();
    expect(wallSurfaceAreaM2(overshoot, true)).toBeCloseTo(wallSurfaceAreaM2(whole, true), 9);
  });

  it("keeps a whole-wall run indistinguishable from a plain take-off", () => {
    const full = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 0, endMm: 3000 })!;
    expect(full).toEqual(whole);
  });

  it("clips the insulation pockets to the run as well", () => {
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    expect(wallInsulationAreaM2(run)).toBeGreaterThan(0);
    expect(wallInsulationAreaM2(run)).toBeLessThan(wallInsulationAreaM2(whole));
    for (const pocket of run.pockets) {
      expect(pocket.x0).toBeGreaterThanOrEqual(1000 - 1e-6);
      expect(pocket.x1).toBeLessThanOrEqual(2000 + 1e-6);
    }
  });

  it("clips an opening the run only partly covers", () => {
    const framing: WallFraming = {
      openings: [
        { kind: "door", segmentIndex: 0, centreMm: 1500, daylightHeightMm: 2000, daylightWidthMm: 900, lintelSize: "90x45", lintelPly: 2 },
      ],
      rakes: [],
      extraStuds: [],
    };
    // Run ends halfway through the doorway: only that half comes out of the measure.
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0, { startMm: 0, endMm: 1500 })!;
    expect(run.openings).toHaveLength(1);
    expect(run.openings[0].widthMm).toBeCloseTo(450, 9);
    expect(run.openings[0].frameCentreMm).toBeCloseTo(1500 - 225, 9);
  });

  it("samples rake heights where the run actually starts and stops", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    // Linear rake over 3 m: 2400 at 0, 3600 at 3000 -> 2800 at 1000 and 3200 at 2000.
    expect(run.segments[0].startHeightMm).toBeCloseTo(2800, 9);
    expect(run.segments[0].endHeightMm).toBeCloseTo(3200, 9);
    expect(wallSurfaceAreaM2(run, true)).toBeCloseTo(1 * 3.0, 9);
  });

  it("drops a gable apex the run does not reach", () => {
    const framing: WallFraming = {
      openings: [],
      rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 4000, middlePositionMm: 1500 }],
      extraStuds: [],
    };
    const acrossApex = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    expect(acrossApex.segments[0].apexHeightMm).toBe(4000);
    const oneSlope = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0, { startMm: 0, endMm: 1000 })!;
    expect(oneSlope.segments[0].apexHeightMm).toBeUndefined();
  });

  it("detects overlap between two runs on the same wall", () => {
    const wallLengthMm = wallPathLengthMm(straightWall, MMPP);
    const run = (startMm: number, endMm: number) =>
      buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm, endMm })!;
    expect(wallSpansOverlap(run(0, 1000), run(1000, 2000), wallLengthMm)).toBe(false);
    expect(wallSpansOverlap(run(0, 1200), run(1000, 2000), wallLengthMm)).toBe(true);
    // A whole-wall surface has no explicit span, and clashes with everything on that wall.
    expect(wallSpansOverlap(whole, run(1000, 2000), wallLengthMm)).toBe(true);
  });

  // The drift re-sync in appStore rebuilds each surface from its source wall on every visit. If
  // it drops the run, a partial surface silently snaps back to covering the whole wall.
  it("survives being rebuilt from its own snapshot", () => {
    const wallLengthMm = wallPathLengthMm(straightWall, MMPP);
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    const rebuilt = buildWallSurfaceMeta(
      1, 2, straightWall, plain, MMPP, undefined, "left", null, 0,
      wallSurfaceSpanOf(run, wallLengthMm),
    )!;
    expect(rebuilt).toEqual(run);
    expect(wallSurfaceMetaMatches(rebuilt, run)).toBe(true);
    // And a whole-wall surface round-trips as "no run" rather than an explicit full range.
    expect(wallSurfaceSpanOf(whole, wallLengthMm)).toBeNull();
    const wholeRebuilt = buildWallSurfaceMeta(
      1, 2, straightWall, plain, MMPP, undefined, "left", null, 0,
      wallSurfaceSpanOf(whole, wallLengthMm),
    )!;
    expect(wholeRebuilt).toEqual(whole);
  });

  it("fills only the drawn stretch in plan", () => {
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, { startMm: 1000, endMm: 2000 })!;
    const quads = wallSurfaceSpanQuads(straightWall, run, MMPP, false);
    // 10 mm per point, so the run covers 100..200 pt of a 300 pt wall.
    expect(pointInWallFace({ x: 150, y: 2 }, quads)).toBe(true);
    expect(pointInWallFace({ x: 50, y: 2 }, quads)).toBe(false);
    expect(pointInWallFace({ x: 250, y: 2 }, quads)).toBe(false);
    // Insulation spans the body, so both sides of the centre line pick up within the run.
    const body = wallSurfaceSpanQuads(straightWall, run, MMPP, true);
    expect(pointInWallFace({ x: 150, y: -2 }, body)).toBe(true);
    expect(pointInWallFace({ x: 50, y: -2 }, body)).toBe(false);
  });
});

describe("inherited Z datum", () => {
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });

  it("snapshots the framing group's offset, not the surface group's", () => {
    const firstFloor = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 3.1)!;
    expect(firstFloor.sourceOffsetM).toBeCloseTo(3.1, 9);
    const ground = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    expect(ground.sourceOffsetM).toBe(0);
    // The datum belongs to the wall, so it is part of the drift check: move the framing group and
    // the surface must be re-cut rather than left standing at the old level.
    expect(wallSurfaceMetaMatches(firstFloor, ground)).toBe(false);
  });

  it("stands both a lining panel and a batt at the inherited level", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 3.1)!;
    const [panel] = computeWallSurface3D(straightWall, MMPP, meta, {
      offsetM: meta.sourceOffsetM, color: "#fff", deductOpenings: true,
    });
    expect(panel.position[1]).toBeCloseTo(3.1, 9);
    const [batt] = computeWallSurface3D(straightWall, MMPP, meta, {
      offsetM: meta.sourceOffsetM, color: "#fff", deductOpenings: true, insulation: true,
    });
    // A square batt is a box, so it is centred on `position`; its underside is what sits at the
    // inherited datum plus the pocket's own height above FFL.
    expect(batt.position[1] - batt.size[1] / 2).toBeCloseTo(3.1 + meta.pockets[0].yb0 / 1000, 9);
  });

  it("defaults to the ground datum for snapshots written before it was inherited", () => {
    const legacy = JSON.stringify({ type: "wall_surface", segments: [], openings: [], pockets: [] });
    expect(parseWallSurfaceMeta(legacy).sourceOffsetM).toBe(0);
  });
});

describe("rebuild cost", () => {
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: true, dwangCentresMm: 800 });

  it("accepts pre-swept pockets and produces the identical snapshot", () => {
    // The store re-syncs every loaded surface on each visit; the pocket sweep runs wallMembers
    // over the whole wall and depends only on the wall, so it is hoisted and shared. This pins
    // that the shortcut cannot change the result.
    const swept: WallPocket[] = wallInsulationPockets(straightWall, plain, MMPP, undefined);
    expect(swept.length).toBeGreaterThan(0);
    const derived = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const reused = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, null, swept)!;
    expect(reused).toEqual(derived);
  });

  it("clips pre-swept pockets to a partial run exactly as it would fresh ones", () => {
    const swept = wallInsulationPockets(straightWall, plain, MMPP, undefined);
    const span = { startMm: 1000, endMm: 2000 };
    const derived = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, span)!;
    const reused = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0, span, swept)!;
    expect(reused).toEqual(derived);
    expect(wallInsulationAreaM2(reused)).toBeCloseTo(wallInsulationAreaM2(derived), 12);
  });

  it("is stable across rebuilds, so a settled surface stops rewriting itself", () => {
    // wallSurfaceMetaMatches drives the drift check; if a rebuild of unchanged input ever differed
    // the store would rewrite every surface on every visit, which is what made the app lag.
    const first = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 2.7)!;
    const second = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 2.7)!;
    expect(wallSurfaceMetaMatches(second, first)).toBe(true);
  });
});

describe("batt draw cost", () => {
  const plain = settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: false });
  const batts = (meta: ReturnType<typeof buildWallSurfaceMeta>) =>
    computeWallSurface3D(straightWall, MMPP, meta!, { offsetM: 0, color: "#fff", deductOpenings: true, insulation: true });

  it("emits square batts as boxes so they can be instanced", () => {
    // Every wedge is its own mesh and draw call in Framing3DView; a wall's worth of square
    // pockets emitted as wedges is what stalled the 3D view.
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const built = batts(meta);
    expect(built.length).toBe(meta.pockets.length);
    expect(built.every((m) => !m.wedge)).toBe(true);
    // Identical bays share a size, which is what lets them batch into one instanced mesh.
    const sizes = new Set(built.map((m) => m.size.join(",")));
    expect(sizes.size).toBeLessThan(built.length);
  });

  it("still uses a wedge where a rake has sloped the pocket", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, 0)!;
    const built = batts(meta);
    expect(built.some((m) => m.wedge)).toBe(true);
  });

  it("puts a box batt in the same place the wedge form would", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, 0)!;
    const [box] = batts(meta);
    const pocket = meta.pockets[0];
    // Box members are centred; the pocket runs yb..yt above FFL and x0..x1 along the wall.
    expect(box.position[1]).toBeCloseTo((pocket.yb0 + pocket.yt0) / 2 / 1000, 9);
    expect(box.size[0]).toBeCloseTo((pocket.x1 - pocket.x0) / 1000, 9);
    expect(box.size[1]).toBeCloseTo((pocket.yt0 - pocket.yb0) / 1000, 9);
    expect(box.size[2]).toBeCloseTo(0.09, 9);
  });
});
