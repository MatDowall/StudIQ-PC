import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOOR,
  DEFAULT_FRAMING_SETTINGS,
  STUD_THICKNESS_MM,
  type FramingSettings,
  computeFramingGeometry,
  computeFramingQuantities,
  cornerGapMm,
  cornerPackerCount,
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
    const boxes = geom.studs.map((s) => aabb(s.rect));
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

  it("corner gap is sized to exact 45mm packer multiples, not the raw depth − thickness distance", () => {
    expect(cornerGapMm("90x45")).toBe(45); // exact match: depth − thickness is already 45
    expect(cornerGapMm("140x45")).toBe(90); // depth − thickness would be 95; shorted to 2 × 45
    expect(cornerGapMm("190x45")).toBe(135); // depth − thickness would be 145; shorted to 3 × 45
  });

  it("corner studs stay non-overlapping for a deeper 140×45 frame", () => {
    const geom = computeFramingGeometry(lWall, settings({ framingSize: "140x45" }), MM_PER_PT);
    const aabb = (stud: { x: number; y: number }[]) => ({
      minX: Math.min(...stud.map((p) => p.x)),
      maxX: Math.max(...stud.map((p) => p.x)),
      minY: Math.min(...stud.map((p) => p.y)),
      maxY: Math.max(...stud.map((p) => p.y)),
    });
    const boxes = geom.studs.map((s) => aabb(s.rect));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const ix = Math.max(0, Math.min(boxes[i].maxX, boxes[j].maxX) - Math.max(boxes[i].minX, boxes[j].minX));
        const iy = Math.max(0, Math.min(boxes[i].maxY, boxes[j].maxY) - Math.max(boxes[i].minY, boxes[j].minY));
        expect(ix * iy).toBeLessThan(1);
      }
    }
  });

  it("packer count scales with corner gap width, ~1 per 50 mm (docs/corner makeup.png)", () => {
    expect(cornerPackerCount("45x45")).toBe(0); // no gap to pack — plain 3-stud corner
    expect(cornerPackerCount("90x45")).toBe(1);
    expect(cornerPackerCount("140x45")).toBe(2);
    expect(cornerPackerCount("190x45")).toBe(3);
    expect(cornerPackerCount("240x45")).toBe(4);
    expect(cornerPackerCount("290x45")).toBe(5);
  });

  it("a 45×45 corner has zero gap and gets no packer at all — just 3 flush studs", () => {
    expect(cornerGapMm("45x45")).toBe(0);
    const members = wallMembers(lWall, settings({ framingSize: "45x45" }), MM_PER_PT);
    expect(members.filter((m) => m.kind === "packer")).toHaveLength(0);
    // The two corner-makeup studs sit exactly one stud-thickness apart (flush, touching faces).
    const arcLenMm = (m: (typeof members)[number]) => m.position[2] * 1000;
    const cornerStuds = members
      .filter((m) => m.kind === "stud" && Math.abs(m.position[0] - 2) < 1e-9)
      .sort((a, b) => arcLenMm(a) - arcLenMm(b))
      .slice(0, 2);
    expect(arcLenMm(cornerStuds[1]) - arcLenMm(cornerStuds[0])).toBeCloseTo(STUD_THICKNESS_MM, 6);
  });

  it("the corner-makeup gap gets packer blocks instead of a dwang (2 rows × 1 packer for 90×45)", () => {
    const members = wallMembers(lWall, settings({ framingSize: "90x45" }), MM_PER_PT);
    const packers = members.filter((m) => m.kind === "packer");
    expect(packers).toHaveLength(2);
    for (const p of packers) {
      expect(p.lengthM).toBeCloseTo(0.3, 6); // always 300 mm long, never taller
      expect(p.size[0]).toBeCloseTo(STUD_THICKNESS_MM / 1000, 6); // 45 mm wide
      expect(p.size[1]).toBeCloseTo(0.3, 6);
      expect(p.size[2]).toBeCloseTo(0.09, 6); // full 90 mm wall depth
    }
    // None of the plain dwangs span the corner gap itself (45 mm) — it's packer-only.
    const dwangs = members.filter((m) => m.kind === "dwang");
    expect(dwangs.every((d) => Math.abs(d.lengthM - cornerGapMm("90x45") / 1000) > 1e-6)).toBe(true);
  });

  it("a deeper 140×45 corner packs 2 blocks side by side in a single row, never a taller stack", () => {
    const members = wallMembers(lWall, settings({ framingSize: "140x45" }), MM_PER_PT);
    const packers = members.filter((m) => m.kind === "packer");
    expect(packers).toHaveLength(4); // 2 dwang rows × 2 blocks each
    for (const p of packers) {
      expect(p.lengthM).toBeCloseTo(0.3, 6); // still always 300 mm, never grows
      expect(p.size[1]).toBeCloseTo(0.3, 6);
      expect(p.size[2]).toBeCloseTo(0.14, 6); // full 140 mm wall depth
    }
    // Group by row height (Y position) — each row's pair sits at the SAME height (single row),
    // spread apart in X (the wall-run axis) rather than stacked taller in Y.
    const byRow = new Map<number, typeof packers>();
    for (const p of packers) {
      const key = Math.round(p.position[1] * 1e6);
      byRow.set(key, [...(byRow.get(key) ?? []), p]);
    }
    expect(byRow.size).toBe(2); // 2 distinct row heights, not 4
    for (const rowPackers of byRow.values()) {
      expect(rowPackers).toHaveLength(2);
      const [a, b] = rowPackers;
      expect(a.position[1]).toBeCloseTo(b.position[1], 6); // same height
      const dx = a.position[0] - b.position[0];
      const dz = a.position[2] - b.position[2];
      expect(Math.hypot(dx, dz)).toBeCloseTo(STUD_THICKNESS_MM / 1000, 6); // offset sideways by 45 mm
    }
  });

  it("the packer group fills the corner gap flush, with zero leftover sliver either side", () => {
    const members = wallMembers(lWall, settings({ framingSize: "140x45" }), MM_PER_PT);
    // Segment 1 (the corner segment) runs due south, so its world Z directly encodes arc-length
    // (mm, since MM_PER_PT = 1) — usable here to compare stud faces against the packer footprint.
    const arcLenMm = (m: (typeof members)[number]) => m.position[2] * 1000;
    const cornerStuds = members
      .filter((m) => m.kind === "stud" && Math.abs(m.position[0] - 2) < 1e-9)
      .sort((a, b) => arcLenMm(a) - arcLenMm(b))
      .slice(0, 2); // the two corner-makeup studs sit first along the segment
    const gapLo = arcLenMm(cornerStuds[0]) + STUD_THICKNESS_MM / 2; // stud 2's outer face
    const gapHi = arcLenMm(cornerStuds[1]) - STUD_THICKNESS_MM / 2; // stud 3's inner face
    expect(gapHi - gapLo).toBeCloseTo(cornerGapMm("140x45"), 6);

    const rowPackers = members
      .filter((m) => m.kind === "packer" && Math.abs(m.position[1] - 0.845) < 1e-6)
      .sort((a, b) => arcLenMm(a) - arcLenMm(b));
    expect(rowPackers).toHaveLength(2);
    const footprintLo = arcLenMm(rowPackers[0]) - STUD_THICKNESS_MM / 2;
    const footprintHi = arcLenMm(rowPackers[rowPackers.length - 1]) + STUD_THICKNESS_MM / 2;
    expect(footprintLo).toBeCloseTo(gapLo, 6);
    expect(footprintHi).toBeCloseTo(gapHi, 6);
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

  it("plan view: kings are continuous (full cross), but trimmers and jacks are non-continuous — and the jacks above the lintel (previously omitted from the plan) are now present", () => {
    const geom = computeFramingGeometry(wall4m, settings({ framingSize: "90x45", wallHeightMm: 2400 }), MM_PER_PT, door);
    const centreXMm = (stud: (typeof geom.studs)[number]) => stud.rect.reduce((sum, p) => sum + p.x, 0) / stud.rect.length;
    const near = (xMm: number) => geom.studs.find((s) => Math.abs(centreXMm(s) - xMm) < 1);
    // Kings at 2000 ± (455 + 67.5); trimmers at 2000 ± (455 + 22.5) (openingJambs, dwHalf 455, studThk 45).
    expect(near(1477.5)?.continuous).toBe(true);
    expect(near(2522.5)?.continuous).toBe(true);
    expect(near(1522.5)?.continuous).toBe(false);
    expect(near(2477.5)?.continuous).toBe(false);
    // The 2 jacks above the lintel sit at the regular 600mm-grid positions inside the daylight width
    // (1822.5 and 2422.5, inside [1545, 2455]) — dropped from the plan entirely before this fix.
    expect(near(1822.5)).toBeDefined();
    expect(near(1822.5)?.continuous).toBe(false);
    expect(near(2422.5)).toBeDefined();
    expect(near(2422.5)?.continuous).toBe(false);
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

describe("stacked openings (regression) — a window directly above a door on the same wall line", () => {
  // Door 0–2100mm (head), a 300mm solid band, then a window from 2400mm sill to 3300mm head —
  // both centred at 2000mm with the same 910mm daylight width, so their jamb studs land on
  // exactly the same wall positions. Before the fix, a jack above the door ran straight through
  // the window above it (and the window's sill jack ran straight through the door below it), and
  // a king/trimmer that happened to coincide for both openings was emitted twice.
  const stacked = {
    openings: [
      { kind: "door" as const, segmentIndex: 0, centreMm: 2000, daylightHeightMm: 2100, daylightWidthMm: 910, lintelSize: "90x45" as const, lintelPly: 1 },
      { kind: "window" as const, segmentIndex: 0, centreMm: 2000, sillHeightMm: 2400, daylightHeightMm: 900, daylightWidthMm: 910, lintelSize: "90x45" as const, lintelPly: 1 },
    ],
    rakes: [],
    extraStuds: [],
  };
  const s = settings({ framingSize: "90x45", wallHeightMm: 3700 });
  const members = wallMembers(wall4m, s, MM_PER_PT, stacked);
  const cavitiesMm = [
    { lo: 0, hi: 2100 }, // door daylight
    { lo: 2400, hi: 3300 }, // window daylight
  ];

  it("jack / sill-jack cripple studs never run through either opening's clear daylight", () => {
    for (const m of members) {
      if (m.kind !== "jack" && m.kind !== "sill_jack") continue;
      const yBmm = (m.position[1] - m.size[1] / 2) * 1000;
      const yTmm = (m.position[1] + m.size[1] / 2) * 1000;
      for (const c of cavitiesMm) {
        const overlapMm = Math.min(yTmm, c.hi) - Math.max(yBmm, c.lo);
        expect(overlapMm).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it("king and trimmer studs at the shared jamb line are deduped, not doubled", () => {
    const q = computeFramingQuantities(wall4m, s, MM_PER_PT, stacked)!;
    expect(q.components.find((c) => c.kind === "king")!.count).toBe(2);
    expect(q.components.find((c) => c.kind === "trimmer")!.count).toBe(2);
  });

  it("both lintels are present, aggregated as one 90×45 row of count 2", () => {
    const q = computeFramingQuantities(wall4m, s, MM_PER_PT, stacked)!;
    const lintelRows = q.components.filter((c) => c.kind === "lintel");
    expect(lintelRows).toHaveLength(1);
    expect(lintelRows[0].count).toBe(2);
  });
});

describe("overlap priority (regression) — an opening's king lands on the wall's own flush end stud", () => {
  // 3.4 m wall, 90×45, flush (unmitred) ends. A door centred so its right trimmer (2900 + 455 +
  // 22.5 = 3377.5mm) lands EXACTLY on the wall's own flush end anchor (3400 − 22.5 = 3377.5mm) —
  // the classic "opening right up against the end of the wall" case. Before this fix the generic
  // end stud and the door's trimmer were both drawn as separate, fully overlapping full-height
  // studs; the opening's own jamb should win and the redundant end stud should be dropped.
  const wallEnd = [
    { x: 0, y: 0 },
    { x: 3400, y: 0 },
  ];
  const doorNearEnd = {
    openings: [{ kind: "door" as const, segmentIndex: 0, centreMm: 2900, daylightHeightMm: 2100, daylightWidthMm: 910, lintelSize: "90x45" as const, lintelPly: 1 }],
    rakes: [],
    extraStuds: [],
  };
  const s = settings({ framingSize: "90x45", wallHeightMm: 2400 });

  it("no two full-height vertical members share (near enough) the same wall position", () => {
    const members = wallMembers(wallEnd, s, MM_PER_PT, doorNearEnd);
    const fullHeightXsMm = members
      .filter((m) => (m.kind === "stud" || m.kind === "king" || m.kind === "trimmer") && !m.wedge)
      .map((m) => m.position[0] * 1000);
    for (let i = 0; i < fullHeightXsMm.length; i += 1) {
      for (let j = i + 1; j < fullHeightXsMm.length; j += 1) {
        expect(Math.abs(fullHeightXsMm[i] - fullHeightXsMm[j])).toBeGreaterThanOrEqual(45);
      }
    }
  });
});

describe("QA-reported real project case — a wide door and a narrower window on a gabled wall, where " +
  "the window's right king coincidentally lands ~23mm past the door's own daylight edge", () => {
  // Exact geometry from a real project: 140×45, 400mm centres, single T&B, 2.35m gabled wall.
  // A 1950mm-wide door and a 1200mm-wide window (asymmetric widths/positions, not stacked/aligned)
  // put the window's right king at 2270.9mm — just past the door's own right daylight edge
  // (2247.9mm) but still well within reach of the door's jamb assembly. On the LEFT the window's
  // king (935.9mm) already landed inside the door's daylight width and clipped correctly (sits on
  // the door's lintel at 2140mm); on the RIGHT it didn't, because it was ~23mm outside the exact
  // boundary — so it ran uncut all the way to the bottom plate. A second, independent bug: the
  // door's own right trimmer (2270.4mm) sat only 0.4mm from the window's right king and was
  // getting silently merged into it (king wins), hiding the trimmer from the takeoff entirely.
  const wall = [
    { x: 1063.019287109375, y: 992.7774047851562 },
    { x: 1063.019287109375, y: 1125.940673828125 },
  ];
  const mmPerPoint = 17.638851407605607;
  const gableSettings: FramingSettings = {
    framingSize: "140x45",
    studSpacingMm: 400,
    topPlate: { on: true, double: false },
    bottomPlate: { on: true, double: false },
    wallHeightMm: 2400,
    dwangCentresMm: 800,
    dwangsOn: true,
  };
  const framing = {
    openings: [
      { kind: "door" as const, daylightHeightMm: 2000, daylightWidthMm: 1950, lintelSize: "140x45" as const, lintelPly: 3, segmentIndex: 0, centreMm: 1272.926635234765 },
      { kind: "window" as const, daylightHeightMm: 600, daylightWidthMm: 1200, lintelSize: "90x45" as const, lintelPly: 2, sillHeightMm: 3850, segmentIndex: 0, centreMm: 1603.3591272242506 },
    ],
    rakes: [{ segmentIndex: 0, startMm: 4260, endMm: 4480, gable: true, middleMm: 4630, middlePositionMm: 1670 }],
    extraStuds: [],
  };
  const members = wallMembers(wall, gableSettings, mmPerPoint, framing);
  // Local arc-length (mm) along the wall and true vertical [yB, yT] (mm), accounting for the
  // half-stud-thickness shift `addV` applies to a wedge (rake-cut) member's recorded position.
  const rows = members
    .filter((m) => m.kind === "king" || m.kind === "trimmer")
    .map((m) => {
      const arcMm = -(m.position[2] * 1000) - wall[0].y * mmPerPoint + (m.wedge ? STUD_THICKNESS_MM / 2 : 0);
      const ys = m.wedge ? m.wedge.quad.map((p) => p[1] * 1000) : [(m.position[1] - m.size[1] / 2) * 1000, (m.position[1] + m.size[1] / 2) * 1000];
      return { kind: m.kind, arcMm, yB: Math.min(...ys), yT: Math.max(...ys) };
    });
  const near = (target: number) => rows.filter((r) => Math.abs(r.arcMm - target) < 2);

  it("the window's right king sits on the door's lintel (yB ≈ 2140mm), matching its left side", () => {
    const leftKing = near(935.9).find((r) => r.kind === "king");
    const rightKing = near(2270.9).find((r) => r.kind === "king");
    expect(leftKing?.yB).toBeCloseTo(2140, 0);
    expect(rightKing?.yB).toBeCloseTo(2140, 0);
  });

  it("the door's own right trimmer is present (not silently merged into the window's king)", () => {
    const doorRightTrimmer = near(2270.4).find((r) => r.kind === "trimmer");
    expect(doorRightTrimmer).toBeDefined();
    expect(doorRightTrimmer?.yB).toBeCloseTo(45, 0);
    expect(doorRightTrimmer?.yT).toBeCloseTo(2000, 0);
  });

  it("the door's own right king is unaffected — full height, independent of the window", () => {
    const doorRightKing = near(2315.4).find((r) => r.kind === "king");
    expect(doorRightKing?.yB).toBeCloseTo(45, 0);
  });

  it("the gable apex pair (1647.5mm / 1692.5mm) wins over the 25mm-distant regular grid stud at 1622.5mm — no overlapping column there", () => {
    const allMembers = members.filter((m) => Math.abs((-(m.position[2] * 1000) - wall[0].y * mmPerPoint + (m.wedge ? STUD_THICKNESS_MM / 2 : 0)) - 1622.5) < 2);
    expect(allMembers).toHaveLength(0);
  });

  it("the 2D plan view collapses the door's right trimmer and the window's right king (0.4mm apart) into a single stud, not a crossed/overlapping pair", () => {
    const geom = computeFramingGeometry(wall, gableSettings, mmPerPoint, framing);
    const centreArcLenMm = (stud: (typeof geom.studs)[number]) => {
      const cy = stud.rect.reduce((sum, p) => sum + p.y, 0) / stud.rect.length;
      return (cy - wall[0].y) * mmPerPoint;
    };
    const near2270 = geom.studs.filter((stud) => Math.abs(centreArcLenMm(stud) - 2270) < 5);
    expect(near2270).toHaveLength(1);
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
