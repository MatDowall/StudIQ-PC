# M4 — Corners (NZ 3-stud makeup) — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed. Two corrections during the gate (see `decisions.md`):
(1) corner stud arc-lengths re-derived from the markup so the three studs sit adjacent, not
overlapping; (2) the corner gap was made depth-dependent (`depth − thickness`) so stud 3 reaches
the internal corner on frames deeper than 90×45. Final: **21/21 tests pass.**

## What was built (all in `src/lib/framing.ts` + `ViewerCanvas.tsx`)

- **90° corner enforcement** — `orthogonalConstrain(draft, candidate)` forces each segment after
  the first to be parallel or perpendicular to the previous one (the first segment stays free, so
  walls can run at any angle). Applied to both the click placement and the live preview in
  `ViewerCanvas`.
- **NZ 3-stud corner makeup** — `generateStuds` rebuilds stud set-out per segment with the corner
  treatment from `docs/corner makeup.png`: lead-in segment ends with a stud at the corner (stud 1);
  lead-out segment starts with a stud at the corner (stud 2), a **45 mm gap**, then a third stud
  (stud 3). Free wall ends keep a flush stud; regular studs fill at `studSpacing`. Corner studs
  count into `studCount`, so the M3 breakdown picks them up with no extra wiring.
- **Mitred plate corners** — `offsetPolyline` now scales the vertex offset by `1/cos(halfAngle)`,
  so the two plate edges meet cleanly at the miter point (fixes the M2 corner overrun/overlap).

## Verification done

- `tsc --noEmit` → 0. `vitest run` → **18 passed** (4 new: L-wall = 11 studs; mitred plates yield
  finite, 3-vertex outlines; `orthogonalConstrain` snaps a 90° turn and leaves the first segment
  free). Straight-wall stud count unchanged (8).

## Gate (run the app)

1. Draw a framing wall, click to start a run, then click again around a corner — the segment should
   **snap square** (90°).
2. Confirm the corner shows the **3-stud makeup** (stud on the lead-in + two on the lead-out with a
   45 mm gap) like `docs/corner makeup.png`, and the **plates mitre cleanly** (no overrun/overlap
   like the M2 screenshot).
3. Open the Breakdown panel → the L-wall stud tally includes the corner studs and the totals
   reconcile.

## Next

**M5 — Doors.** See [`HANDOFF.md`](./HANDOFF.md).
