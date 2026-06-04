# M2 — Draw a straight wall; render plates & studs — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed (user confirmed: 4 m wall, 8 studs, plate gap + stud size + cross/fill all correct).

> Note: multi-segment (corner) walls currently overrun/overlap at the bend — expected, as corners
> are handled in **M4** (90°-enforced + NZ 3-stud makeup). M2 covers straight walls only.

## What was built

A timber-framing group can now draw walls that render as scaled plates + studs.

### Geometry — `src/lib/framing.ts`
- `computeFramingGeometry(path, settings, mmPerPoint)` → `{ plateLeft, plateRight, studs, studCount }`,
  all in PDF points (Y-up). Internals:
  - `offsetPolyline` — the two plate outlines, offset `±framingDepthMm/2` from the centre path via
    averaged per-vertex normals (exact for straight walls).
  - `studCentreArcLengths` — stud set-out: flush stud at each end + regular studs at `studSpacing`
    centres (see `decisions.md` for the rule).
  - `sampleAt` — point + local direction at an arc-length, used to orient each stud rectangle
    (`framingDepth` across the wall × `STUD_THICKNESS_MM` (45) along it).

### Rendering & draw flow — `src/components/ViewerCanvas.tsx`
- `drawFraming(...)` — draws the two plate outlines + each stud as a rectangle with a
  corner-to-corner cross (architectural stud symbol), transparent fill (`colour+"22"`), solid
  same-colour outline. Falls back to the bare centre path when there's no page scale.
- `drawOverlays` gained an `mmPerPoint` param and a `timber_framing` branch that calls
  `drawFraming` (committed walls). New `isAreaType()` helper makes framing an **open** polyline
  for all hit-test/hover/render paths (added `pageScale` → `drawOverlays` at the call site).
- Live preview: while drawing a framing group (`drawingFraming`), the draft (placed points +
  rubber-band point) previews as plates + studs in real time, instead of the plain rubber-band.
- Draw/commit reuses the existing click-to-place + snap pipeline unchanged — committing stores a
  measurement with `measurement_type = "timber_framing"` and the centre-path geometry; members
  are always derived, never persisted.

## Verification done

- `node_modules/.bin/tsc --noEmit` (frontend) → exit 0.
- Logic sanity check (documented): a 4000 mm wall at 600 cts, 90×45 ⇒ **8 studs**.

## Gate (run the app — restart onto the new build first)

1. Open a PDF, **calibrate the page scale**.
2. Select a Timber Framing group → **Add** mode → click a start point, click an end point, **Enter**
   (or right-click / double-click) to commit a straight wall.
3. Confirm: two parallel plate lines a real **90 mm** apart (for 90×45), studs **90 × 45** each with
   the corner-to-corner cross + transparent fill, studs at **600 mm centres** with a stud flush at
   each end. Verify against the scale (e.g. the plate gap measures 90 mm with the calibrated ruler).

## Next

**M3 — Quantity makeup + the four verification surfaces.** See [`HANDOFF.md`](./HANDOFF.md).
