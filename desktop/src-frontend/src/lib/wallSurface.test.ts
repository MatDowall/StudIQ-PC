import { describe, expect, it } from "vitest";
import {
  buildWallSurfaceMeta,
  pointInWallFace,
  wallBodyQuads,
  wallFacePath,
  wallFaceQuads,
  wallInsulationPockets,
  wallPathLengthMm,
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
    const inner = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, "left", null)!;
    const outer = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, "right", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, undefined, "left", null)!;
    expect(wallSurfaceAreaM2(meta, true)).toBeCloseTo(3 * 2.4, 9);
  });

  it("follows a raking frame, using the mean height over the segment", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, framing, "left", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, framing, "left", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, framing, "left", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null)!;
    expect(wallSurfaceDeducts(meta, props(null))).toBe(true);
    expect(wallSurfaceDeducts(meta, props(JSON.stringify({ deductOpenings: false })))).toBe(false);
    expect(wallSurfaceDeducts({ ...meta, deductOpenings: true }, props(JSON.stringify({ deductOpenings: false })))).toBe(true);
    expect(wallSurfaceDeducts({ ...meta, deductOpenings: false }, props(null))).toBe(false);
  });
});

describe("wall surface snapshot", () => {
  it("round-trips through JSON", () => {
    const meta = buildWallSurfaceMeta(7, 9, straightWall, settings(), MMPP, undefined, "right", false)!;
    expect(parseWallSurfaceMeta(serializeWallSurfaceMeta(meta))).toEqual(meta);
  });

  it("detects framing drift but ignores the estimator's own deduction choice", () => {
    const base = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, undefined, "left", null)!;
    const taller = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2700 }), MMPP, undefined, "left", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, corner, settings(), MMPP, undefined, side, null)!;
    const panels = computeWallSurface3D(corner, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    expect(panels).toHaveLength(2);
    const [endX, endZ] = endOf(panels[0]);
    expect(endX).toBeCloseTo(panels[1].position[0], 9);
    expect(endZ).toBeCloseTo(panels[1].position[2], 9);
  });

  it("stands the panel on the measured face, not the wall centre line", () => {
    // A single straight wall running along +X: the left face sits at +halfDepth in page Y, which
    // maps to NEGATIVE world Z (pageToWorld flips Y). 90 mm framing + 20 mm panel → 55 mm out.
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null)!;
    const [panel] = computeWallSurface3D(straightWall, MMPP, meta, { offsetM: 0, color: "#fff", deductOpenings: true });
    expect(panel.position[2]).toBeCloseTo(-0.055, 9);
    const right = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "right", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings({ wallHeightMm: 2400 }), MMPP, framing, "left", null)!;
    const opts = { offsetM: 0, color: "#fff" };
    // Left of the door, the spandrel over it, right of the door.
    expect(computeWallSurface3D(straightWall, MMPP, meta, { ...opts, deductOpenings: true })).toHaveLength(3);
    expect(computeWallSurface3D(straightWall, MMPP, meta, { ...opts, deductOpenings: false })).toHaveLength(1);
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
    expect(wallInsulationAreaM2(meta) * 1e6).toBeCloseTo(gross - framed, 6);
  });

  it("is always smaller than the lining measure of the same wall", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, settings(), MMPP, undefined, "left", null)!;
    expect(wallInsulationAreaM2(meta)).toBeGreaterThan(0);
    expect(wallInsulationAreaM2(meta)).toBeLessThan(wallSurfaceAreaM2(meta, true));
  });

  it("adds a pocket row when dwangs break the bays up, without changing the total", () => {
    const noDwangs = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
    const withDwangs = buildWallSurfaceMeta(
      1, 2, straightWall,
      settings({ wallHeightMm: 2400, studSpacingMm: 600, dwangsOn: true, dwangCentresMm: 800 }),
      MMPP, undefined, "left", null,
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null)!;
    const flat = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
    // A taller wall has more cavity, and no pocket may poke above the sloping top plate.
    expect(wallInsulationAreaM2(meta)).toBeGreaterThan(wallInsulationAreaM2(flat));
    for (const pocket of meta.pockets) {
      const roofAt = (x: number) => 2400 + (3600 - 2400) * (x / 3000);
      expect(pocket.yt0).toBeLessThanOrEqual(roofAt(pocket.x0) + 1e-6);
      expect(pocket.yt1).toBeLessThanOrEqual(roofAt(pocket.x1) + 1e-6);
    }
  });

  it("measures by the group's own type, off one shared snapshot", () => {
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
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
    const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
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
    const left = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;
    const right = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "right", null)!;
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
  const meta = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null)!;

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
    const inner = buildWallSurfaceMeta(1, 2, cornerWall, plain, MMPP, framing, "left", null)!;
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
  const whole = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null)!;

  it("measures only the drawn stretch", () => {
    // Middle metre of a 3 m wall.
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 1000, endMm: 2000 })!;
    expect(run.spanStartMm).toBe(1000);
    expect(run.spanEndMm).toBe(2000);
    expect(wallSurfaceAreaM2(run, true)).toBeCloseTo(1 * 2.4, 9);
    expect(wallSurfaceAreaM2(whole, true)).toBeCloseTo(3 * 2.4, 9);
  });

  it("normalises a run drawn backwards, and clamps one drawn past the ends", () => {
    const backwards = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 2000, endMm: 1000 })!;
    expect(backwards.spanStartMm).toBe(1000);
    expect(backwards.spanEndMm).toBe(2000);
    const overshoot = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: -500, endMm: 9999 })!;
    // Clamped back to the whole wall, which is stored as "no span" rather than an explicit range.
    expect(overshoot.spanStartMm).toBeNull();
    expect(wallSurfaceAreaM2(overshoot, true)).toBeCloseTo(wallSurfaceAreaM2(whole, true), 9);
  });

  it("keeps a whole-wall run indistinguishable from a plain take-off", () => {
    const full = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 0, endMm: 3000 })!;
    expect(full).toEqual(whole);
  });

  it("clips the insulation pockets to the run as well", () => {
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 1000, endMm: 2000 })!;
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
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, { startMm: 0, endMm: 1500 })!;
    expect(run.openings).toHaveLength(1);
    expect(run.openings[0].widthMm).toBeCloseTo(450, 9);
    expect(run.openings[0].frameCentreMm).toBeCloseTo(1500 - 225, 9);
  });

  it("samples rake heights where the run actually starts and stops", () => {
    const framing: WallFraming = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, { startMm: 1000, endMm: 2000 })!;
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
    const acrossApex = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, { startMm: 1000, endMm: 2000 })!;
    expect(acrossApex.segments[0].apexHeightMm).toBe(4000);
    const oneSlope = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, framing, "left", null, { startMm: 0, endMm: 1000 })!;
    expect(oneSlope.segments[0].apexHeightMm).toBeUndefined();
  });

  it("detects overlap between two runs on the same wall", () => {
    const wallLengthMm = wallPathLengthMm(straightWall, MMPP);
    const run = (startMm: number, endMm: number) =>
      buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm, endMm })!;
    expect(wallSpansOverlap(run(0, 1000), run(1000, 2000), wallLengthMm)).toBe(false);
    expect(wallSpansOverlap(run(0, 1200), run(1000, 2000), wallLengthMm)).toBe(true);
    // A whole-wall surface has no explicit span, and clashes with everything on that wall.
    expect(wallSpansOverlap(whole, run(1000, 2000), wallLengthMm)).toBe(true);
  });

  // The drift re-sync in appStore rebuilds each surface from its source wall on every visit. If
  // it drops the run, a partial surface silently snaps back to covering the whole wall.
  it("survives being rebuilt from its own snapshot", () => {
    const wallLengthMm = wallPathLengthMm(straightWall, MMPP);
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 1000, endMm: 2000 })!;
    const rebuilt = buildWallSurfaceMeta(
      1, 2, straightWall, plain, MMPP, undefined, "left", null,
      wallSurfaceSpanOf(run, wallLengthMm),
    )!;
    expect(rebuilt).toEqual(run);
    expect(wallSurfaceMetaMatches(rebuilt, run)).toBe(true);
    // And a whole-wall surface round-trips as "no run" rather than an explicit full range.
    expect(wallSurfaceSpanOf(whole, wallLengthMm)).toBeNull();
    const wholeRebuilt = buildWallSurfaceMeta(
      1, 2, straightWall, plain, MMPP, undefined, "left", null,
      wallSurfaceSpanOf(whole, wallLengthMm),
    )!;
    expect(wholeRebuilt).toEqual(whole);
  });

  it("fills only the drawn stretch in plan", () => {
    const run = buildWallSurfaceMeta(1, 2, straightWall, plain, MMPP, undefined, "left", null, { startMm: 1000, endMm: 2000 })!;
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
