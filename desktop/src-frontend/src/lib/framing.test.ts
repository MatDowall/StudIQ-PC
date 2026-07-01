import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOOR,
  DEFAULT_FRAMING_SETTINGS,
  type FramingSettings,
  computeFramingGeometry,
  computeFramingQuantities,
  cornerGapMm,
  dwangRowCount,
  dwangRowsForStudHeight,
  orthogonalConstrain,
  plateLayerCount,
  reindexFramingForVertexDeletion,
  reindexFramingForVertexInsertion,
  studHeightMm,
  wallMembers,
} from "./framing";

// 1 pt = 1 mm keeps the worked examples readable: a 4000-pt path is a 4 m wall.
const MM_PER_PT = 1;
const wall4m = [
  { x: 0, y: 0 },
  { x: 4000, y: 0 },
];

function settings(overrides: Partial<FramingSettings> = {}): FramingSettings {
  return { ...DEFAULT_FRAMING_SETTINGS, ...overrides };
}

describe("plate layers & stud height", () => {
  it("single top + bottom = 2 layers, stud height 2310 (docs worked example)", () => {
    const s = settings({ wallHeightMm: 2400 });
    expect(plateLayerCount(s)).toBe(2);
    expect(studHeightMm(s)).toBe(2310);
  });

  it("double top plate = 3 layers, stud height 2265", () => {
    const s = settings({ wallHeightMm: 2400, topPlate: { on: true, double: true } });
    expect(plateLayerCount(s)).toBe(3);
    expect(studHeightMm(s)).toBe(2265);
  });

  it("bottom plate off = 1 layer", () => {
    const s = settings({ bottomPlate: { on: false, double: false } });
    expect(plateLayerCount(s)).toBe(1);
  });
});

describe("dwang rows (floor(stud-zone / centres), docs/dwang theory.png)", () => {
  it("2.4 m wall (single T&B → 2310 stud zone) at 800 → 2 rows", () => {
    expect(dwangRowsForStudHeight(2310, 800)).toBe(2);
    expect(dwangRowCount(settings({ wallHeightMm: 2400, dwangCentresMm: 800 }))).toBe(2);
  });
  it("rows = floor(studZone / centres) — a row is omitted where it can't clear the top plate", () => {
    expect(dwangRowsForStudHeight(2317.5, 800)).toBe(2); // raked bay lower end, omits the 3rd
    expect(dwangRowsForStudHeight(2517.5, 800)).toBe(3);
    expect(dwangRowsForStudHeight(700, 800)).toBe(0);
  });
  it("zero when dwangs off", () => {
    expect(dwangRowCount(settings({ dwangsOn: false }))).toBe(0);
  });
});

describe("stud set-out (4 m wall, 600 cts, 90×45)", () => {
  it("places 8 studs", () => {
    const geom = computeFramingGeometry(wall4m, settings({ framingSize: "90x45" }), MM_PER_PT);
    expect(geom.studCount).toBe(8);
  });
});

describe("corners (M4)", () => {
  // L-wall: 2 m run east, 2 m run south, square corner at (2000,0).
  const lWall = [
    { x: 0, y: 0 },
    { x: 2000, y: 0 },
    { x: 2000, y: -2000 },
  ];

  it("L-wall studs = 11 (5 on the lead-in, 6 on the lead-out incl. the 3-stud corner)", () => {
    const geom = computeFramingGeometry(lWall, settings({ framingSize: "90x45" }), MM_PER_PT);
    expect(geom.studCount).toBe(11);
  });

  it("corner studs do not overlap (they sit adjacent, per corner makeup.png)", () => {
    const geom = computeFramingGeometry(lWall, settings({ framingSize: "90x45" }), MM_PER_PT);
    const aabb = (stud: { x: number; y: number }[]) => ({
      minX: Math.min(...stud.map((p) => p.x)),
      maxX: Math.max(...stud.map((p) => p.x)),
      minY: Math.min(...stud.map((p) => p.y)),
      maxY: Math.max(...stud.map((p) => p.y)),
    });
    const boxes = geom.studs.map(aabb);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const ix = Math.max(0, Math.min(boxes[i].maxX, boxes[j].maxX) - Math.max(boxes[i].minX, boxes[j].minX));
        const iy = Math.max(0, Math.min(boxes[i].maxY, boxes[j].maxY) - Math.max(boxes[i].minY, boxes[j].minY));
        expect(ix * iy).toBeLessThan(1); // < 1 mm² overlap (touching edges allowed)
      }
    }
  });

  it("plate outlines mitre at the interior corner (no NaN, 3 vertices each)", () => {
    const geom = computeFramingGeometry(lWall, settings(), MM_PER_PT);
    expect(geom.plateLeft).toHaveLength(3);
    expect(geom.plateRight).toHaveLength(3);
    for (const p of [...geom.plateLeft, ...geom.plateRight]) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("orthogonalConstrain forces a 90° turn after the first segment", () => {
    const draft = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 }, // segment runs east
    ];
    // A point down-and-slightly-right snaps to a pure vertical (perpendicular) segment.
    const out = orthogonalConstrain(draft, { x: 1100, y: -800 });
    expect(out.x).toBeCloseTo(1000, 6); // x locked to the corner
    expect(out.y).toBeCloseTo(-800, 6);
  });

  it("orthogonalConstrain leaves the first segment free", () => {
    const out = orthogonalConstrain([{ x: 0, y: 0 }], { x: 37, y: 91 });
    expect(out).toEqual({ x: 37, y: 91 });
  });

  it("corner gap scales with wall depth (depth − thickness)", () => {
    expect(cornerGapMm("90x45")).toBe(45);
    expect(cornerGapMm("140x45")).toBe(95);
    expect(cornerGapMm("190x45")).toBe(145);
  });

  it("corner studs stay non-overlapping for a deeper 140×45 frame", () => {
    const geom = computeFramingGeometry(lWall, settings({ framingSize: "140x45" }), MM_PER_PT);
    const aabb = (stud: { x: number; y: number }[]) => ({
      minX: Math.min(...stud.map((p) => p.x)),
      maxX: Math.max(...stud.map((p) => p.x)),
      minY: Math.min(...stud.map((p) => p.y)),
      maxY: Math.max(...stud.map((p) => p.y)),
    });
    const boxes = geom.studs.map(aabb);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const ix = Math.max(0, Math.min(boxes[i].maxX, boxes[j].maxX) - Math.max(boxes[i].minX, boxes[j].minX));
        const iy = Math.max(0, Math.min(boxes[i].maxY, boxes[j].maxY) - Math.max(boxes[i].minY, boxes[j].minY));
        expect(ix * iy).toBeLessThan(1);
      }
    }
  });
});

describe("computeFramingQuantities — docs worked example", () => {
  // 90×45, single top & bottom, 2400 high, 4 m long.
  const q = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT)!;

  it("stud height 2310 mm, 8 studs", () => {
    expect(q.studHeightMm).toBe(2310);
    expect(q.studCount).toBe(8);
  });

  it("plates = 8 m (2 layers × 4 m)", () => {
    expect(q.components.find((c) => c.kind === "plate")!.totalM).toBeCloseTo(8, 6);
  });

  it("studs = 18.48 m (2.310 × 8)", () => {
    expect(q.components.find((c) => c.kind === "stud")!.totalM).toBeCloseTo(18.48, 6);
  });

  it("dwangs = 2 rows of pieces between 8 studs (7 bays, Σ gaps 3640 mm × 2 = 7.28 m)", () => {
    expect(q.components.find((c) => c.kind === "dwang")!.totalM).toBeCloseTo(7.28, 6);
  });

  it("total = 8 (plates) + 18.48 (studs) + 7.28 (dwangs) = 33.76 m", () => {
    expect(q.totalM).toBeCloseTo(33.76, 6);
  });
});

describe("doors (M5) — 4 m wall, 90×45, single T&B, 2400 high, door at 2.0 m (DH 2100, DW 910, 90×45 2-ply)", () => {
  const door = {
    openings: [
      {
        kind: "door" as const,
        segmentIndex: 0,
        centreMm: 2000,
        daylightHeightMm: 2100,
        daylightWidthMm: 910,
        lintelSize: "90x45" as const,
        lintelPly: 2,
      },
    ],
    rakes: [],
    extraStuds: [],
  };
  const q = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, door)!;
  const comp = (kind: string) => q.components.find((c) => c.kind === kind);

  it("parent studs drop to 6 (8 − 2 cut by the opening)", () => {
    expect(q.studCount).toBe(6);
    expect(comp("stud")!.totalM).toBeCloseTo(6 * 2.31, 6);
  });
  it("2 king studs, full height (2 × 2.310)", () => {
    expect(comp("king")!.count).toBe(2);
    expect(comp("king")!.totalM).toBeCloseTo(4.62, 6);
  });
  it("2 trimmers (2 × (2100 − 45 bottom plate) = 4.110 m)", () => {
    expect(comp("trimmer")!.totalM).toBeCloseTo(4.11, 6);
  });
  it("lintel = (910 + 90) × 2 ply = 2.000 m", () => {
    expect(comp("lintel")!.totalM).toBeCloseTo(2.0, 6);
  });
  it("2 jacks above the lintel (2400 − 45 − 2100 − 90 = 165 mm each)", () => {
    expect(comp("jack")!.count).toBe(2);
    expect(comp("jack")!.totalM).toBeCloseTo(2 * 0.165, 6);
  });
  it("dwangs infill beside the opening (incl. regular→king bays), skipping the daylight = 5.28 m", () => {
    expect(comp("dwang")!.totalM).toBeCloseTo(5.28, 6);
  });
  it("plates unaffected by the door (8.000 m)", () => {
    expect(comp("plate")!.totalM).toBeCloseTo(8.0, 6);
  });
});

describe("regression: a regular stud just outside the door's daylight width must stay a full stud, not vanish (QA-reported jack-stud undercount)", () => {
  // 4 m wall, 500mm centres, 90×45. Door centred at 1022.5mm with the default 910mm daylight width
  // (dwHalf = 455mm) puts two regular studs (at 522.5mm and 1522.5mm, i.e. exactly 500mm off the
  // door centre) just OUTSIDE the daylight width but within the stale "+2 stud thicknesses" buffer
  // the cut logic used to apply — which silently dropped them (neither a full stud nor a jack).
  const wall = wall4m;
  const spacedSettings = settings({ framingSize: "90x45", wallHeightMm: 2400, studSpacingMm: 500 });
  const framing = {
    openings: [{ kind: "door" as const, segmentIndex: 0, centreMm: 1022.5, daylightHeightMm: 2100, daylightWidthMm: 910, lintelSize: "90x45" as const, lintelPly: 2 }],
    rakes: [],
    extraStuds: [],
  };

  it("every original stud position is accounted for — either as a full stud or a jack, never dropped", () => {
    const baseCount = wallMembers(wall, spacedSettings, MM_PER_PT).filter((m) => m.kind === "stud").length;
    const members = wallMembers(wall, spacedSettings, MM_PER_PT, framing);
    const studCount = members.filter((m) => m.kind === "stud").length;
    const jackCount = members.filter((m) => m.kind === "jack").length;
    // Only the one stud dead-centre on the door (distance 0 < dwHalf) should convert to a jack;
    // every other original position — including the two just outside the daylight width — stays put.
    expect(jackCount).toBe(1);
    expect(studCount + jackCount).toBe(baseCount);
  });

  it("the two studs just outside the daylight width (500mm off-centre, daylight half-width 455mm) remain full height", () => {
    const members = wallMembers(wall, spacedSettings, MM_PER_PT, framing);
    const studXsMm = members.filter((m) => m.kind === "stud").map((m) => Math.round(m.position[0] * 1000));
    expect(studXsMm).toContain(523); // 522.5mm, rounds to 523
    expect(studXsMm).toContain(1523); // 1522.5mm
  });
});

describe("regression: a gable-apex candidate coinciding with a regular-grid position must not be double-counted (QA-reported jack-stud overcount)", () => {
  // Segment 0 is a 2-point wall of length 2420mm, 400mm centres — regular grid (from the flush
  // start anchor at 22.5mm) lands on 422.5, 822.5, 1222.5, 1622.5, 2022.5. A gable apex placed at
  // 1600mm gives a candidate at apex + half-stud-thickness = 1600 + 22.5 = 1622.5mm — landing
  // EXACTLY on a regular grid position. Before the fix, `[...seg.regular, ...cutCandidates]` was a
  // plain concatenation with no dedup, so that one physical stud was pushed into the door's jack
  // list twice (an identical duplicate member), inflating both the jack count and total length.
  const wall = [
    { x: 0, y: 0 },
    { x: 2420, y: 0 },
  ];
  const gableSettings = settings({ framingSize: "140x45", wallHeightMm: 2400, studSpacingMm: 400 });
  const framing = {
    openings: [{ kind: "door" as const, segmentIndex: 0, centreMm: 1298.5, daylightHeightMm: 2040, daylightWidthMm: 1950, lintelSize: "140x45" as const, lintelPly: 1 }],
    rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 4500, middlePositionMm: 1600 }],
    extraStuds: [],
  };

  it("no two jack members share the same position — the coincident apex/grid candidate is only counted once", () => {
    const members = wallMembers(wall, gableSettings, MM_PER_PT, framing);
    const jacks = members.filter((m) => m.kind === "jack");
    const positions = jacks.map((m) => Math.round(m.position[0] * 1e6)); // metres, high precision
    expect(new Set(positions).size).toBe(positions.length); // no duplicate positions
  });

  it("jack count matches the number of distinct grid/anchor/apex positions inside the door span, not the raw (pre-dedup) candidate count", () => {
    const members = wallMembers(wall, gableSettings, MM_PER_PT, framing);
    // Distinct candidates inside the door span [1298.5-975, 1298.5+975] = [323.5, 2273.5]:
    // regular 422.5, 822.5, 1222.5, 1622.5, 2022.5 (all 5, since the wall is only 2420mm); gable
    // apex 1577.5 (1600-22.5, new) and 1622.5 (1600+22.5, coincides with the regular grid stud
    // above, so it must NOT add a 7th) — 6 distinct positions, not 7 (raw pre-dedup count).
    expect(members.filter((m) => m.kind === "jack")).toHaveLength(6);
  });
});

describe("windows (M6) — 4 m wall, 90×45, single T&B, 2400 high, window at 2.0 m (sill 900, glass 1200 → head 2100, width 1200, 90×45 2-ply)", () => {
  const window = {
    openings: [
      {
        kind: "window" as const,
        segmentIndex: 0,
        centreMm: 2000,
        daylightHeightMm: 1200,
        daylightWidthMm: 1200,
        lintelSize: "90x45" as const,
        lintelPly: 2,
        sillHeightMm: 900,
      },
    ],
    rakes: [],
    extraStuds: [],
  };
  const q = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, window)!;
  const comp = (kind: string) => q.components.find((c) => c.kind === kind);

  it("parent studs drop to 6", () => {
    expect(q.studCount).toBe(6);
  });
  it("trimmers run full height (bottom plate → lintel): 2 × (2100 − 45) = 4.110 m", () => {
    expect(comp("trimmer")!.totalM).toBeCloseTo(4.11, 6);
  });
  it("lintel = (1200 + 90) × 2 = 2.580 m", () => {
    expect(comp("lintel")!.totalM).toBeCloseTo(2.58, 6);
  });
  it("2 jacks above the lintel (2400 − 45 − 2100 − 90 = 165 mm)", () => {
    expect(comp("jack")!.count).toBe(2);
    expect(comp("jack")!.totalM).toBeCloseTo(2 * 0.165, 6);
  });
  it("sill spans the daylight width (1.200 m)", () => {
    expect(comp("sill")!.count).toBe(1);
    expect(comp("sill")!.totalM).toBeCloseTo(1.2, 6);
  });
  it("sill jacks = 2 under-sill (aligned) + 2 support = 4 × (900 − 45 − 45 = 810 mm) = 3.240 m", () => {
    expect(comp("sill_jack")!.count).toBe(4);
    expect(comp("sill_jack")!.totalM).toBeCloseTo(3.24, 6);
  });
  it("dwangs infill beside the opening + below the sill, skipping the glass = 5.72 m", () => {
    expect(comp("dwang")!.totalM).toBeCloseTo(5.72, 6);
  });
});

describe("raking frames (M7)", () => {
  // 4 m wall, 90×45, single T&B, raked 2400 → 3600, 800 dwang centres.
  const raked = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3600 }], extraStuds: [] };
  const q = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400, dwangCentresMm: 800 }), MM_PER_PT, raked)!;
  const comp = (kind: string) => q.components.find((c) => c.kind === kind);

  it("top plate uses slope length (4.176 m) + flat bottom plate (4.0 m) = 8.176 m", () => {
    expect(comp("plate")!.totalM).toBeCloseTo(4.0 + Math.hypot(4000, 1200) / 1000, 4);
  });
  it("studs graduate with the local height (Σ over 8 studs = 23.5005 m)", () => {
    expect(q.studCount).toBe(8);
    expect(comp("stud")!.totalM).toBeCloseTo(23.5005, 4);
  });
  it("dwangs are height-relative pieces, lower-end clearance (22 pieces, 11.23 m)", () => {
    // Per-bay rows [2,3,3,3,3,4,4] × gaps [555×6, 310] → 11230 mm; 22 pieces.
    expect(comp("dwang")!.count).toBe(22);
    expect(comp("dwang")!.totalM).toBeCloseTo(11.23, 4);
  });

  // Direct SketchUp reconciliation: 3 m wall, 90×45, single T&B, raked 2400 → 3400, 800 cts.
  // SketchUp report: 14 dwangs = 7635 mm (11 × 555 + 3 × 510); top plate 3162 mm.
  it("matches the SketchUp 3 m raked wall: 14 dwangs / 7.635 m, top plate slope", () => {
    const wall3m = [
      { x: 0, y: 0 },
      { x: 3000, y: 0 },
    ];
    const q3 = computeFramingQuantities(
      wall3m,
      settings({ framingSize: "90x45", wallHeightMm: 2400, dwangCentresMm: 800 }),
      MM_PER_PT,
      { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3400 }], extraStuds: [] },
    )!;
    const dwang = q3.components.find((c) => c.kind === "dwang")!;
    expect(dwang.count).toBe(14);
    expect(dwang.totalM).toBeCloseTo(7.635, 4);
    expect(q3.components.find((c) => c.kind === "plate")!.totalM).toBeCloseTo(3.0 + Math.hypot(3000, 1000) / 1000, 4);
  });
});

describe("gable apex position (middlePositionMm — removes the need to add a polyline point to steer the ridge)", () => {
  // 4 m wall, flat 2400, gable rising to a 3600 apex.
  const gableAt = (middlePositionMm?: number) => ({
    openings: [],
    rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 3600, middlePositionMm }],
    extraStuds: [],
  });

  it("defaults to the segment midpoint when middlePositionMm is absent (back-compat)", () => {
    const geomDefault = computeFramingGeometry(wall4m, settings({ framingSize: "90x45" }), MM_PER_PT, gableAt(undefined));
    const geomExplicitMid = computeFramingGeometry(wall4m, settings({ framingSize: "90x45" }), MM_PER_PT, gableAt(2000));
    expect(geomDefault.studCount).toBe(geomExplicitMid.studCount);
  });

  it("an off-centre apex moves the top-plate wedge split and the apex stud pair", () => {
    const q = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, gableAt(1000))!;
    // Top plate = flat bottom (4.0 m) + two sloped top pieces: 1000mm run rising 2400->3600 (1200mm
    // rise) then 3000mm run falling 3600->2400 (1200mm rise/fall).
    const expectedTop = 4.0 + Math.hypot(1000, 1200) / 1000 + Math.hypot(3000, 1200) / 1000;
    expect(q.components.find((c) => c.kind === "plate")!.totalM).toBeCloseTo(expectedTop, 4);
  });

  it("an off-centre apex is asymmetric — unlike the default midpoint case, the two top-plate wedges differ in length", () => {
    const members = wallMembers(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, gableAt(1000));
    const plateWedges = members.filter((m) => m.kind === "plate" && m.wedge);
    expect(plateWedges).toHaveLength(2);
    const lengths = plateWedges.map((m) => m.lengthM).sort((a, b) => a - b);
    expect(lengths[0]).toBeCloseTo(Math.hypot(1000, 1200) / 1000, 4);
    expect(lengths[1]).toBeCloseTo(Math.hypot(3000, 1200) / 1000, 4);
  });
});

describe("extra studs (M8)", () => {
  it("a manually-placed stud adds one to the count and its height to the total", () => {
    const base = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT)!;
    const withExtra = computeFramingQuantities(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, {
      openings: [],
      rakes: [],
      extraStuds: [{ segmentIndex: 0, centreMm: 1000 }],
    })!;
    expect(withExtra.studCount).toBe(base.studCount + 1);
    expect(withExtra.components.find((c) => c.kind === "stud")!.totalM).toBeCloseTo(base.components.find((c) => c.kind === "stud")!.totalM + 2.31, 6);
  });
});

describe("king/jack studs near a segment boundary (regression: bug report of a missing end stud + stray trimmer on a wall split for gable-apex control)", () => {
  // 2-segment wall: a long raked run (0 -> 2000, rising 2400 -> 3000) followed by a short flat
  // run (2000 -> 2400) — the shape of a wall that was split purely to steer where a raking
  // frame's apex lands, per the bug report. A door on the raked segment sits close enough to the
  // boundary that its far king's arc-length offset overshoots past that segment's own length and
  // lands physically on the short flat segment.
  const boundaryWall = [
    { x: 0, y: 0 },
    { x: 2000, y: 0 },
    { x: 2400, y: 0 },
  ];
  const framing = {
    openings: [{ ...DEFAULT_DOOR, segmentIndex: 0, centreMm: 1800 }],
    rakes: [
      { segmentIndex: 0, startMm: 2400, endMm: 3000 },
      { segmentIndex: 1, startMm: 2400, endMm: 1800 }, // deliberately different from segment 0's own slope
    ],
    extraStuds: [],
  };

  it("the far king stud (whose arc-length overshoots into the neighbouring segment) follows that segment's own roofline, not the door's own segment clamped to its end height", () => {
    const members = wallMembers(boundaryWall, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, framing);
    const kings = members.filter((m) => m.kind === "king").sort((a, b) => a.position[0] - b.position[0]);
    expect(kings).toHaveLength(2);
    const farKing = kings[1]; // the one nearer the segment-0/segment-1 boundary
    // Segment 0's own (wrong, pre-fix) clamped height would put this stud near 3000-45=2955mm
    // tall (its own segment's raked-up end). The correct cross-segment height, taken from
    // segment 1's flat/dipping roofline at that physical position, is well below that.
    expect(farKing.lengthM).toBeLessThan(2.2);
    expect(farKing.lengthM).toBeGreaterThan(1.5);
  });

  it("no king/jack/stud member is silently dropped by an under-height rake-cut clamp near the boundary", () => {
    const members = wallMembers(boundaryWall, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, framing);
    // Every kind we expect around a door: 2 kings, 2 trimmers, a lintel, and at least one jack.
    expect(members.filter((m) => m.kind === "king")).toHaveLength(2);
    expect(members.filter((m) => m.kind === "trimmer")).toHaveLength(2);
    expect(members.filter((m) => m.kind === "lintel").length).toBeGreaterThan(0);
    expect(members.filter((m) => m.kind === "jack").length).toBeGreaterThan(0);
  });
});

describe("reindexFramingForVertexInsertion / reindexFramingForVertexDeletion (bug: add/delete vertex left openings/rakes pointing at stale segments)", () => {
  const path3 = [
    { x: 0, y: 0 },
    { x: 2000, y: 0 },
    { x: 4000, y: 0 },
  ];

  it("insertion before an entry leaves it unchanged", () => {
    const framing = { openings: [{ ...DEFAULT_DOOR, segmentIndex: 1, centreMm: 500 }], rakes: [], extraStuds: [] };
    const { framing: out, warnings } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 1000, y: 0 }, MM_PER_PT);
    expect(warnings).toHaveLength(0);
    expect(out.openings[0].segmentIndex).toBe(2); // segment 1 shifts to 2 (a new segment was inserted before it)
    expect(out.openings[0].centreMm).toBe(500); // local offset unchanged
  });

  it("insertion splitting the entry's own segment re-bases centreMm onto the correct new sub-segment", () => {
    const framing = { openings: [], rakes: [], extraStuds: [{ segmentIndex: 0, centreMm: 1500 }] };
    const { framing: out } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 1000, y: 0 }, MM_PER_PT);
    // Split at 1000mm; the extra stud at 1500mm moves to the new second sub-segment (index 1) at local 500mm.
    expect(out.extraStuds[0]).toEqual({ segmentIndex: 1, centreMm: 500 });
  });

  it("splitting a plain rake interpolates the height at the split point", () => {
    const framing = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 3200 }], extraStuds: [] };
    const { framing: out } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 500, y: 0 }, MM_PER_PT);
    expect(out.rakes).toHaveLength(2);
    // Split 500mm into a 2000mm segment rising 2400->3200: height at split = 2400 + 800*(500/2000) = 2600.
    expect(out.rakes[0]).toEqual({ segmentIndex: 0, startMm: 2400, endMm: 2600 });
    expect(out.rakes[1]).toEqual({ segmentIndex: 1, startMm: 2600, endMm: 3200 });
  });

  it("splitting a gable rake before the apex keeps the gable on the second sub-segment", () => {
    const framing = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 3600 }], extraStuds: [] };
    // Segment is 2000mm, apex defaults to the midpoint (1000mm); split at 400mm (before the apex).
    const { framing: out } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 400, y: 0 }, MM_PER_PT);
    expect(out.rakes).toHaveLength(2);
    expect(out.rakes[0].gable).toBeUndefined();
    expect(out.rakes[0].segmentIndex).toBe(0);
    expect(out.rakes[0].startMm).toBe(2400);
    // Height at 400mm on the start(2400)->apex(3600 @1000mm) slope = 2400 + 1200*(400/1000) = 2880.
    expect(out.rakes[0].endMm).toBeCloseTo(2880, 6);
    expect(out.rakes[1]).toMatchObject({ segmentIndex: 1, gable: true, middleMm: 3600, middlePositionMm: 600 }); // 1000 - 400
    expect(out.rakes[1].startMm).toBeCloseTo(2880, 6);
    expect(out.rakes[1].endMm).toBe(2400);
  });

  it("splitting a gable rake after the apex keeps the gable on the first sub-segment", () => {
    const framing = { openings: [], rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 3600 }], extraStuds: [] };
    const { framing: out } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 1600, y: 0 }, MM_PER_PT);
    expect(out.rakes[0]).toMatchObject({ segmentIndex: 0, gable: true, middleMm: 3600, middlePositionMm: 1000 });
    expect(out.rakes[1].gable).toBeUndefined();
    expect(out.rakes[1].segmentIndex).toBe(1);
    expect(out.rakes[1].endMm).toBe(2400);
  });

  it("an opening whose footprint straddles the split point is assigned whole to one sub-segment and warns", () => {
    const framing = { openings: [{ ...DEFAULT_DOOR, segmentIndex: 0, centreMm: 1000 }], rakes: [], extraStuds: [] };
    const { framing: out, warnings } = reindexFramingForVertexInsertion(framing, path3, 0, { x: 1000, y: 0 }, MM_PER_PT);
    expect(warnings.length).toBeGreaterThan(0);
    expect(out.openings).toHaveLength(1); // never split into two
  });

  it("deleting an interior vertex merges the two adjacent segments, re-basing entries on the later one", () => {
    const framing = { openings: [{ ...DEFAULT_DOOR, segmentIndex: 1, centreMm: 300 }], rakes: [], extraStuds: [{ segmentIndex: 0, centreMm: 1000 }] };
    const { framing: out, warnings } = reindexFramingForVertexDeletion(framing, path3, 1, MM_PER_PT);
    expect(warnings).toHaveLength(0);
    expect(out.extraStuds[0]).toEqual({ segmentIndex: 0, centreMm: 1000 }); // was on segment 0, unchanged
    expect(out.openings[0]).toEqual({ ...DEFAULT_DOOR, segmentIndex: 0, centreMm: 2300 }); // 2000 (seg0 len) + 300
  });

  it("deleting an interior vertex drops a discontinuous or gabled rake with a warning rather than guessing a shape", () => {
    const framing = {
      openings: [],
      rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2400, gable: true, middleMm: 3600 }, { segmentIndex: 1, startMm: 2400, endMm: 2400 }],
      extraStuds: [],
    };
    const { framing: out, warnings } = reindexFramingForVertexDeletion(framing, path3, 1, MM_PER_PT);
    expect(out.rakes).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("deleting an interior vertex auto-merges two continuous, non-gabled rakes", () => {
    const framing = {
      openings: [],
      rakes: [{ segmentIndex: 0, startMm: 2400, endMm: 2800 }, { segmentIndex: 1, startMm: 2800, endMm: 3000 }],
      extraStuds: [],
    };
    const { framing: out, warnings } = reindexFramingForVertexDeletion(framing, path3, 1, MM_PER_PT);
    expect(warnings).toHaveLength(0);
    expect(out.rakes).toEqual([{ segmentIndex: 0, startMm: 2400, endMm: 3000 }]);
  });

  it("deleting an endpoint vertex drops the extremal segment's entries with a warning", () => {
    const framing = { openings: [{ ...DEFAULT_DOOR, segmentIndex: 0, centreMm: 500 }], rakes: [], extraStuds: [] };
    const { framing: out, warnings } = reindexFramingForVertexDeletion(framing, path3, 0, MM_PER_PT);
    expect(out.openings).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("computeFramingQuantities — guards", () => {
  it("null without a scale", () => {
    expect(computeFramingQuantities(wall4m, settings(), null)).toBeNull();
  });
  it("null for a single point", () => {
    expect(computeFramingQuantities([{ x: 0, y: 0 }], settings(), MM_PER_PT)).toBeNull();
  });
  it("no dwang component when dwangs are off", () => {
    const q = computeFramingQuantities(wall4m, settings({ dwangsOn: false }), MM_PER_PT)!;
    expect(q.components.some((c) => c.kind === "dwang")).toBe(false);
  });
});
