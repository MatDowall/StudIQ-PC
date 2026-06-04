import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRAMING_SETTINGS,
  type FramingSettings,
  computeFramingGeometry,
  computeFramingQuantities,
  cornerGapMm,
  dwangRowCount,
  dwangRowsForStudHeight,
  orthogonalConstrain,
  plateLayerCount,
  studHeightMm,
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
