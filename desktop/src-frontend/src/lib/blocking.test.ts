// Joist / Rafter blocking (dwanging) — set-out, quantity roll-up, and 3D placement.
// Same 1 pt = 1 mm convention as framing.test.ts, so a 6000-pt baseline is a 6 m joist run.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOIST_RAFTER_SETTINGS,
  STUD_THICKNESS_MM,
  type JoistRafterSettings,
  aggregateArrayGroup,
  arrayBlockingPieces,
  parseJoistRafterSettings,
  serializeJoistRafterSettings,
} from "./framing";
import { computeArrayMembers3D } from "./framing3d";
import type { ArrayMeta, ArrayTrim, PagePoint } from "./quantity";

const MM_PER_PT = 1;

const RUN_6M: PagePoint[] = [
  { x: 0, y: 0 },
  { x: 6000, y: 0 },
];
/** 5 members at 600 c/c — 4 bays. */
const ARRAY_5x600: ArrayMeta = { extraMembers: 4, spacingPts: 600, direction: 1, trims: [] };
/** Clear bay width in metres: centre-to-centre spacing less one timber thickness. */
const CLEAR_M = (600 - STUD_THICKNESS_MM) / 1000;

function jr(overrides: Partial<JoistRafterSettings> = {}): JoistRafterSettings {
  return { ...DEFAULT_JOIST_RAFTER_SETTINGS, blockingOn: true, blockingCentresMm: 1500, ...overrides };
}

/** The distinct row positions (plan arc-length along the run) present in a set of pieces, taking
 *  each piece's midpoint. Rounded only enough to collapse float noise between bays, not enough to
 *  blunt an assertion. */
function rowPositions(pieces: { runPtsA: number; runPtsB: number }[]): number[] {
  return [...new Set(pieces.map((p) => Number(((p.runPtsA + p.runPtsB) / 2).toFixed(9))))].sort((a, b) => a - b);
}

describe("joist/rafter settings", () => {
  it("round-trips through serialize/parse", () => {
    const s = jr({ framingSize: "140x45", blockingSize: "90x45", blockingCentresMm: 800 });
    expect(parseJoistRafterSettings(serializeJoistRafterSettings(s))).toEqual(s);
  });

  it("a group saved before blocking existed defaults blockingSize to its own timber, so nothing splits out", () => {
    const s = parseJoistRafterSettings(JSON.stringify({ framingSize: "240x45" }));
    expect(s.blockingOn).toBe(false);
    expect(s.blockingSize).toBe("240x45");
  });

  it("rejects a junk size / non-positive centres rather than propagating them", () => {
    const s = parseJoistRafterSettings(JSON.stringify({ framingSize: "nope", blockingSize: "0x0", blockingCentresMm: 0 }));
    expect(s.framingSize).toBe(DEFAULT_JOIST_RAFTER_SETTINGS.framingSize);
    expect(s.blockingSize).toBe(DEFAULT_JOIST_RAFTER_SETTINGS.framingSize);
    expect(s.blockingCentresMm).toBe(DEFAULT_JOIST_RAFTER_SETTINGS.blockingCentresMm);
  });
});

describe("arrayBlockingPieces — set-out", () => {
  it("blocks both ends of every bay plus the interior grid, flush with the joist ends", () => {
    const pieces = arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), MM_PER_PT, 0);
    // End rows sit half a 45mm thickness in, so the outer face is flush with the joist end.
    expect(rowPositions(pieces)).toEqual([22.5, 1500, 3000, 4500, 5977.5]);
    expect(pieces).toHaveLength(5 * 4); // 5 rows x 4 bays
  });

  it("each piece is one timber thickness shorter than the member spacing (face to face)", () => {
    const [piece] = arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), MM_PER_PT, 0);
    expect(piece.lengthM).toBeCloseTo(CLEAR_M, 9);
    expect(Math.hypot(piece.b.x - piece.a.x, piece.b.y - piece.a.y)).toBeCloseTo(555, 9);
  });

  it("a grid row landing on an end row is de-duped — one timber, not two", () => {
    const pieces = arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr({ blockingCentresMm: 5977.5 }), MM_PER_PT, 0);
    expect(rowPositions(pieces)).toEqual([22.5, 5977.5]);
  });

  it("no bay, no blocking: a single-member array produces nothing", () => {
    expect(arrayBlockingPieces(RUN_6M, { ...ARRAY_5x600, extraMembers: 0 }, jr(), MM_PER_PT, 0)).toHaveLength(0);
  });

  it("produces nothing when blocking is switched off, or without a page scale", () => {
    expect(arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr({ blockingOn: false }), MM_PER_PT, 0)).toHaveLength(0);
    expect(arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), null, 0)).toHaveLength(0);
  });

  it("spacing at or below one timber thickness leaves no gap to block", () => {
    expect(arrayBlockingPieces(RUN_6M, { ...ARRAY_5x600, spacingPts: STUD_THICKNESS_MM }, jr(), MM_PER_PT, 0)).toHaveLength(0);
  });

  it("a negative extrusion direction blocks the same bays, mirrored", () => {
    const down = arrayBlockingPieces(RUN_6M, { ...ARRAY_5x600, direction: -1 }, jr(), MM_PER_PT, 0);
    expect(down).toHaveLength(5 * 4);
    expect(down.every((p) => p.lengthM === CLEAR_M)).toBe(true);
    expect(down.every((p) => p.a.y <= 0 && p.b.y <= 0)).toBe(true);
  });
});

describe("arrayBlockingPieces — pitch", () => {
  it("rows are set out along the rafter, so they close up in plan by cos(pitch)", () => {
    const cos30 = Math.cos((30 * Math.PI) / 180);
    const rows = rowPositions(arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), MM_PER_PT, 30));
    // Ends, then the grid: a 6.93 m rafter fits four 1.5 m rows where the 6 m plan run fits three.
    expect(rows).toHaveLength(6);
    // The end rows' half-thickness inset is measured down the slope too, so it foreshortens into
    // plan the same way — 22.5 × cos(30), not a flat 22.5.
    expect(rows[0]).toBeCloseTo(22.5 * cos30, 9);
    expect(rows[rows.length - 1]).toBeCloseTo(6000 - 22.5 * cos30, 9);
    rows.slice(1, -1).forEach((r, i) => expect(r).toBeCloseTo((i + 1) * 1500 * cos30, 8));
  });

  it("blocking of a different depth is displaced along the run, since it hangs from the rafters' top face", () => {
    const same = rowPositions(arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr({ framingSize: "240x45", blockingSize: "240x45" }), MM_PER_PT, 30));
    const shallow = rowPositions(arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr({ framingSize: "240x45", blockingSize: "90x45" }), MM_PER_PT, 30));
    // (90 − 240)/2 × sin(30) = −37.5, applied uniformly to every row.
    const shift = ((90 - 240) / 2) * Math.sin((30 * Math.PI) / 180);
    expect(shallow).toHaveLength(same.length);
    shallow.forEach((s, i) => expect(s).toBeCloseTo(same[i] + shift, 9));
  });

  it("a piece's length is pitch-independent — blocking runs level across the slope", () => {
    const flat = arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), MM_PER_PT, 0)[0];
    const steep = arrayBlockingPieces(RUN_6M, ARRAY_5x600, jr(), MM_PER_PT, 45)[0];
    expect(steep.lengthM).toBeCloseTo(flat.lengthM, 12);
  });
});

describe("arrayBlockingPieces — trims", () => {
  // Cuts the run at 3000. keepX/keepY follow the canvas's screen-space sign convention
  // (see _clipSegmentToTrim in quantity.ts), under which this keeps the far half of the members.
  const cutAt3000: ArrayTrim = { x1: 3000, y1: -10000, x2: 3000, y2: 10000, keepX: 0, keepY: 100 };

  it("the cut becomes the new end of the joists, so the end row follows it in", () => {
    const meta: ArrayMeta = { ...ARRAY_5x600, trims: [cutAt3000] };
    const rows = rowPositions(arrayBlockingPieces(RUN_6M, meta, jr(), MM_PER_PT, 0));
    expect(rows).toEqual([3022.5, 4500, 5977.5]);
    expect(rows.every((r) => r > 3000)).toBe(true);
  });

  // A cut running lengthways at `y`, keeping the members beyond it. (Under the same screen-space
  // keep-side convention as above, a keep point at y = 0 selects the far side.)
  const lengthwaysAt = (y: number): ArrayTrim => ({ x1: -1000, y1: y, x2: 7000, y2: y, keepX: 0, keepY: 0 });

  it("blocking is only emitted where BOTH bounding members survive", () => {
    // Members sit at y = 0/600/1200/1800/2400; this leaves the last three, so 2 bays remain.
    const meta: ArrayMeta = { ...ARRAY_5x600, trims: [lengthwaysAt(900)] };
    const pieces = arrayBlockingPieces(RUN_6M, meta, jr(), MM_PER_PT, 0);
    expect(pieces).toHaveLength(2 * 5); // 2 surviving bays x 5 rows
    expect(pieces.every((p) => Math.min(p.a.y, p.b.y) >= 1200 && Math.max(p.a.y, p.b.y) <= 2400)).toBe(true);
  });

  it("a trim leaving a single member leaves no bay to block", () => {
    const meta: ArrayMeta = { ...ARRAY_5x600, trims: [lengthwaysAt(2100)] };
    expect(arrayBlockingPieces(RUN_6M, meta, jr(), MM_PER_PT, 0)).toHaveLength(0);
  });
});

describe("arrayBlockingPieces — off-axis trims", () => {
  // A trim at 45 degrees to the run, ending member i at 5000 − 600i: each joist in a bay stops at a
  // different arc-length, so the end row has to run corner to corner between them.
  const DIAGONAL: ArrayTrim = { x1: 5000, y1: 0, x2: 2000, y2: 3000, keepX: 6000, keepY: 3000 };
  const diagonalMeta: ArrayMeta = { ...ARRAY_5x600, trims: [DIAGONAL] };

  /** Groups pieces by bay index, read off the perpendicular offset of the piece's `a` end (which
   *  sits on the lower-offset member's face, half a thickness in). */
  function byBay(pieces: ReturnType<typeof arrayBlockingPieces>) {
    const bays = new Map<number, typeof pieces>();
    for (const p of pieces) {
      const bay = Math.round((Math.min(p.a.y, p.b.y) - STUD_THICKNESS_MM / 2) / 600);
      if (!bays.has(bay)) bays.set(bay, []);
      bays.get(bay)!.push(p);
    }
    return bays;
  }
  /** The one skewed (trim-following) row in a bay, if any. */
  const skewedIn = (pieces: ReturnType<typeof arrayBlockingPieces>) => pieces.filter((p) => Math.abs(p.runPtsA - p.runPtsB) > 1);

  it("gives each bay one skewed end row instead of a square stub pulled back to the short joist", () => {
    const bays = byBay(arrayBlockingPieces(RUN_6M, diagonalMeta, jr(), MM_PER_PT, 0));
    expect(bays.size).toBe(4);
    for (const pieces of bays.values()) expect(skewedIn(pieces)).toHaveLength(1);
  });

  it("consecutive bays' end rows meet at their shared joist, forming one continuous line along the cut", () => {
    const bays = byBay(arrayBlockingPieces(RUN_6M, diagonalMeta, jr(), MM_PER_PT, 0));
    // `a` is the lower-offset end, `b` the higher — so bay i's `b` end and bay i+1's `a` end both
    // sit on the same joist and must land at the same arc-length. That is what turns the old
    // staircase of stubs into a single run of blocking.
    for (let bay = 0; bay < 3; bay += 1) {
      const here = skewedIn(bays.get(bay)!)[0];
      const next = skewedIn(bays.get(bay + 1)!)[0];
      expect(next.runPtsA).toBeCloseTo(here.runPtsB, 9);
    }
  });

  it("each end row's ends follow the trim's own slope", () => {
    const bays = byBay(arrayBlockingPieces(RUN_6M, diagonalMeta, jr(), MM_PER_PT, 0));
    for (const [bay, pieces] of bays) {
      const row = skewedIn(pieces)[0];
      // The 45-degree cut moves the joist end 600 along the run for each 600 of spacing, and the
      // half-thickness inset applies at both ends, so the two ends differ by exactly one spacing.
      expect(Math.abs(row.runPtsB - row.runPtsA)).toBeCloseTo(600, 9);
      // Absolute positions: member i ends at 5000 − 600i, less the inset.
      const lo = Math.min(row.runPtsA, row.runPtsB);
      expect(lo).toBeCloseTo(5000 - 600 * (bay + 1) - STUD_THICKNESS_MM / 2, 9);
    }
  });

  it("a skewed row is longer than the clear bay width, and the extra shows up in the quantity", () => {
    const bays = byBay(arrayBlockingPieces(RUN_6M, diagonalMeta, jr(), MM_PER_PT, 0));
    const row = skewedIn(bays.get(0)!)[0];
    expect(row.lengthM).toBeCloseTo(Math.hypot(CLEAR_M, 0.6), 9);
    expect(row.lengthM).toBeGreaterThan(CLEAR_M);
    // And the square rows in the same bay are unaffected.
    for (const p of bays.get(0)!.filter((x) => Math.abs(x.runPtsA - x.runPtsB) <= 1)) {
      expect(p.lengthM).toBeCloseTo(CLEAR_M, 9);
    }
  });

  it("an axis-aligned trim still gives square end rows — nothing skews without a reason", () => {
    const square: ArrayTrim = { x1: 3000, y1: -10000, x2: 3000, y2: 10000, keepX: 0, keepY: 100 };
    const pieces = arrayBlockingPieces(RUN_6M, { ...ARRAY_5x600, trims: [square] }, jr(), MM_PER_PT, 0);
    expect(pieces.every((p) => p.runPtsA === p.runPtsB)).toBe(true);
  });
});

describe("aggregateArrayGroup — one quantity per timber size", () => {
  const array = { id: 1, points: RUN_6M, mmPerPoint: MM_PER_PT, meta: ARRAY_5x600, polarity: 1 };
  const opts = { pitchAngleDeg: 0, multiplier: 1 };
  const BLOCKING_20 = 20 * CLEAR_M;

  it("same-size blocking rolls into the group's own quantity", () => {
    const b = aggregateArrayGroup([array], jr({ framingSize: "90x45", blockingSize: "90x45" }), opts);
    expect(b.memberTotalM).toBeCloseTo(30, 9); // 5 members x 6 m
    expect(b.blockingTotalM).toBeCloseTo(BLOCKING_20, 9);
    expect(b.blockingMatchesSize).toBe(true);
    expect(b.matchingTotalM).toBeCloseTo(30 + BLOCKING_20, 9);
  });

  it("differently-sized blocking is excluded from the group quantity and kept as its own", () => {
    const b = aggregateArrayGroup([array], jr({ framingSize: "90x45", blockingSize: "140x45" }), opts);
    expect(b.blockingMatchesSize).toBe(false);
    expect(b.blockingSize).toBe("140x45");
    expect(b.matchingTotalM).toBeCloseTo(30, 9); // members only
    expect(b.blockingTotalM).toBeCloseTo(BLOCKING_20, 9);
    expect(b.totalM).toBeCloseTo(30 + BLOCKING_20, 9);
  });

  it("blocking off leaves the group quantity exactly the member run", () => {
    const b = aggregateArrayGroup([array], jr({ blockingOn: false }), opts);
    expect(b.blockingSize).toBeNull();
    expect(b.blockingTotalM).toBe(0);
    expect(b.matchingTotalM).toBeCloseTo(30, 9);
  });

  it("pitch stretches the members but not the blocking", () => {
    const b = aggregateArrayGroup([array], jr(), { pitchAngleDeg: 60, multiplier: 1 });
    expect(b.memberTotalM).toBeCloseTo(30 / Math.cos((60 * Math.PI) / 180), 9);
    // 60deg halves the plan centres so more rows fit, but every piece is still a clear bay long.
    expect(b.blockingTotalM / CLEAR_M).toBeCloseTo(Math.round(b.blockingTotalM / CLEAR_M), 9);
  });

  it("a negative-polarity array subtracts both its members and its blocking", () => {
    const s = jr();
    const pos = aggregateArrayGroup([array], s, opts);
    const netted = aggregateArrayGroup([array, { ...array, id: 2, polarity: -1 }], s, opts);
    expect(pos.matchingTotalM).toBeGreaterThan(0);
    expect(netted.matchingTotalM).toBeCloseTo(0, 9);
  });

  it("the multiplier scales members and blocking alike", () => {
    const one = aggregateArrayGroup([array], jr(), opts);
    const three = aggregateArrayGroup([array], jr(), { pitchAngleDeg: 0, multiplier: 3 });
    expect(three.matchingTotalM).toBeCloseTo(one.matchingTotalM * 3, 9);
  });
});

// ─── 3D placement ────────────────────────────────────────────────────────────────────────────
// Framing3DView composes the member transform as Ry(yaw) . Rz(pitch); replicated here so the
// assertions are about what actually gets rendered, not about the numbers fed into it.

function rotate(v: [number, number, number], yaw: number, pitch: number, roll = 0): [number, number, number] {
  let [x, y, z] = v;
  if (roll) {
    const rx = x * Math.cos(roll) + z * Math.sin(roll);
    z = -x * Math.sin(roll) + z * Math.cos(roll);
    x = rx;
  }
  const x1 = x * Math.cos(pitch) - y * Math.sin(pitch);
  const y1 = x * Math.sin(pitch) + y * Math.cos(pitch);
  return [x1 * Math.cos(yaw) + z * Math.sin(yaw), y1, -x1 * Math.sin(yaw) + z * Math.cos(yaw)];
}
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

type Box = { position: [number, number, number]; size: [number, number, number]; yaw: number; pitch: number; roll?: number };

/** Up-normal and top-face-centre of a member box, in world space. */
function topFace(m: Box) {
  const n = rotate([0, 1, 0], m.yaw, m.pitch, m.roll ?? 0);
  return { n, centre: m.position.map((c, i) => c + n[i] * (m.size[1] / 2)) as [number, number, number] };
}

function members3D(pitchDeg: number, settings: JoistRafterSettings) {
  const all = computeArrayMembers3D(RUN_6M, MM_PER_PT, ARRAY_5x600, settings, {
    offsetM: 0,
    color: "#fff",
    pitchAngleDeg: pitchDeg,
  });
  const blockingCount = arrayBlockingPieces(RUN_6M, ARRAY_5x600, settings, MM_PER_PT, pitchDeg).length;
  // Rafters are emitted first, then blocking.
  return { rafters: all.slice(0, all.length - blockingCount), blocking: all.slice(all.length - blockingCount) };
}

describe("computeArrayMembers3D — blocking placement", () => {
  it.each([
    ["flat, matching sizes", 0, "90x45", "90x45"],
    ["30deg, matching sizes", 30, "90x45", "90x45"],
    ["30deg, shallow blocking in deep rafters", 30, "240x45", "90x45"],
    ["22.5deg, deeper blocking", 22.5, "90x45", "140x45"],
  ] as const)("%s: blocking is rolled to the pitch and its top face is flush with the rafters'", (_label, pitchDeg, framingSize, blockingSize) => {
    const { rafters, blocking } = members3D(pitchDeg, jr({ framingSize, blockingSize }));
    expect(blocking.length).toBeGreaterThan(0);

    const rafterTop = topFace(rafters[0]);
    for (const piece of blocking) {
      const pieceTop = topFace(piece);
      // Parallel: identical up-normals, so the blocking is not left plumb against a pitched rafter.
      expect(dot(rafterTop.n, pieceTop.n)).toBeCloseTo(1, 12);
      // Coplanar and flush: the top face sits exactly on the rafters' top plane, whatever the
      // blocking's own depth — a shallower piece hangs from the top rather than sitting low.
      const offPlane = dot(
        [pieceTop.centre[0] - rafterTop.centre[0], pieceTop.centre[1] - rafterTop.centre[1], pieceTop.centre[2] - rafterTop.centre[2]],
        rafterTop.n,
      );
      expect(offPlane).toBeCloseTo(0, 12);
    }
  });

  it("a blocking box carries its span on local Z and its 45mm thickness on local X", () => {
    const { blocking } = members3D(30, jr());
    expect(blocking[0].size[0]).toBeCloseTo(STUD_THICKNESS_MM / 1000, 9);
    expect(blocking[0].size[2]).toBeCloseTo(CLEAR_M, 9);
  });

  it("blocking shares the rafters' yaw and pitch, which is what keeps the faces parallel", () => {
    const { rafters, blocking } = members3D(30, jr());
    expect(blocking[0].yaw).toBeCloseTo(rafters[0].yaw, 12);
    expect(blocking[0].pitch).toBeCloseTo(rafters[0].pitch, 12);
  });

  // Regression: the end rows drifted off the joist ends as the pitch rose, because the set-out was
  // done in plan rather than down the slope. Measured in the rafter's own frame, a piece's outer
  // face must land exactly on the rafter's end face — which is a square cut, so at pitch it is not
  // a vertical plane and neither the blocking's thickness nor its depth projects into plan 1:1.
  it.each([
    ["flat, matching sizes", 0, "90x45", "90x45"],
    ["30deg, matching sizes", 30, "90x45", "90x45"],
    ["45deg, matching sizes", 45, "90x45", "90x45"],
    ["60deg, matching sizes", 60, "140x45", "140x45"],
    ["30deg, shallow blocking in deep rafters", 30, "240x45", "90x45"],
    ["22.5deg, deeper blocking", 22.5, "90x45", "140x45"],
  ] as const)("%s: the end rows' outer faces are flush with the joist ends", (_label, pitchDeg, framingSize, blockingSize) => {
    const { rafters, blocking } = members3D(pitchDeg, jr({ framingSize, blockingSize }));
    const rafter = rafters[0];
    // Down-slope unit axis, shared by the rafters and (same yaw/pitch) the blocking.
    const axis = rotate([1, 0, 0], rafter.yaw, rafter.pitch);
    const along = (p: [number, number, number]) => dot(p, axis);
    // The rafter's two end faces, as offsets along that axis.
    const lowEnd = along(rafter.position) - rafter.size[0] / 2;
    const highEnd = along(rafter.position) + rafter.size[0] / 2;

    const faces = blocking.map((b) => ({
      outerLow: along(b.position) - b.size[0] / 2,
      outerHigh: along(b.position) + b.size[0] / 2,
    }));
    // The lowest piece butts the low end; the highest butts the high end.
    expect(Math.min(...faces.map((f) => f.outerLow))).toBeCloseTo(lowEnd, 12);
    expect(Math.max(...faces.map((f) => f.outerHigh))).toBeCloseTo(highEnd, 12);
    // And nothing overhangs either end.
    expect(faces.every((f) => f.outerLow >= lowEnd - 1e-12 && f.outerHigh <= highEnd + 1e-12)).toBe(true);
  });

  // An off-axis trim skews the end rows, which under pitch means their two ends sit at different
  // heights. The box model only has yaw + pitch, so this needs the `roll` swing within the pitched
  // plane — without it a skewed row would be laid level and both ends would miss the joists.
  it.each([0, 15, 30, 45] as const)("a skewed end row keeps BOTH ends on the roof plane at %s deg pitch", (pitchDeg) => {
    const settings = jr();
    const meta: ArrayMeta = {
      ...ARRAY_5x600,
      trims: [{ x1: 5000, y1: 0, x2: 2000, y2: 3000, keepX: 6000, keepY: 3000 }],
    };
    const all = computeArrayMembers3D(RUN_6M, MM_PER_PT, meta, settings, { offsetM: 0, color: "#fff", pitchAngleDeg: pitchDeg });
    const pieces = arrayBlockingPieces(RUN_6M, meta, settings, MM_PER_PT, pitchDeg);
    const blocking = all.slice(all.length - pieces.length);
    const rafter = all[0];
    const plane = topFace(rafter);

    const skewed = blocking.filter((_, i) => Math.abs(pieces[i].runPtsA - pieces[i].runPtsB) > 1);
    expect(skewed.length).toBeGreaterThan(0);
    // Level rows need no roll; skewed ones must have one as soon as there is a pitch to swing in.
    if (pitchDeg > 0) expect(skewed.every((m) => Math.abs(m.roll ?? 0) > 1e-6)).toBe(true);

    for (const m of blocking) {
      const face = topFace(m);
      // Length runs along local Z; walk to each end of the top face.
      const axis = rotate([0, 0, 1], m.yaw, m.pitch, m.roll ?? 0);
      for (const dir of [-1, 1]) {
        const end = face.centre.map((c, i) => c + axis[i] * dir * (m.size[2] / 2)) as [number, number, number];
        const offPlane = dot([end[0] - plane.centre[0], end[1] - plane.centre[1], end[2] - plane.centre[2]], plane.n);
        expect(offPlane).toBeCloseTo(0, 10);
      }
    }
  });

  it("no blocking members when the group has it switched off", () => {
    const all = computeArrayMembers3D(RUN_6M, MM_PER_PT, ARRAY_5x600, jr({ blockingOn: false }), {
      offsetM: 0,
      color: "#fff",
      pitchAngleDeg: 30,
    });
    expect(all).toHaveLength(5); // the five rafters only
  });
});
