# Phase 4 — Line Snap Drawing Type — Completion Report

Date: 2026-06-03
Phase: Phase 4 (UI polish) — Line snap drawing type feature
Status: Complete

---

## Summary

Added CostX's second measurement input mode — **Line** — alongside the existing **Point**
mode, toggled in the ribbon's **Type** group. In Point mode (unchanged) the user clicks to
place vertices that snap to vector endpoints/midpoints/intersections. In **Line mode**, hovering
near a wall auto-detects the wall surface, extends it along its run, and clips it to the
perpendicular walls on either side of the cursor; a single click commits that two-point
measurement. The driving requirement: an estimator points at a wall and the tool figures out
the wall run between junctions, instead of manually clicking each endpoint.

The hard part was not the toggle but the geometry: real architectural PDFs represent walls as
many tiny segments, two parallel faces, rounded column dots, hatching, and door-swing arcs. The
detection algorithm went through six iterations against live vector data captured from the DT345
drawing before it behaved correctly for both vertical and horizontal walls. All behaviour was
verified by the user in the running app and confirmed working.

---

## Files Created or Modified

**Modified:**
- `desktop/src-frontend/src/store/appStore.ts` — added `drawingType: "point" | "line"` and
  `lineSnapResult` state (+ resets across project/drawing/page changes), the `setDrawingType`
  action, and the `resolveLineSnap` action plus its geometry helpers (`mergeCollinearSegments`,
  `infiniteLineSegmentT`). This is where the whole wall-detection algorithm lives.
- `desktop/src-frontend/src/components/Ribbon.tsx` — wired the Type group's **Point**/**Line**
  buttons to `drawingType` (active highlight, Point default); removed the dead **Object** button.
- `desktop/src-frontend/src/components/ViewerCanvas.tsx` — `scheduleSnapResolution` dispatches to
  `resolveLineSnap` in line mode; added `drawLineSnapPreview` (bold segment + gold endpoint
  diamonds); single-click commit of `lineSnapResult` in line mode; suppressed the point-snap
  indicator and the rubber-band draft while in line mode; right-click no-op in line mode.
- `docs/phase4-ui-polish.md` — recorded the Line snap milestone (M6a–M6c) under remaining polish.

**Created:**
- `docs/phase4-line-snap-completion-report.md` — this report.

---

## Milestones

### Milestone 6a — Store state + ribbon toggle
**Implemented:** `drawingType` (default `"point"`) and `lineSnapResult` in the store; Point/Line
buttons in the Type ribbon group with active highlighting.
**Verification:** `npx tsc --noEmit` clean; user confirmed the toggle highlights correctly.
**Result:** Pass

### Milestone 6b — Line snap detection + preview
**Implemented:** `resolveLineSnap` (nearest-wall detection → extend → clip to junctions);
`drawLineSnapPreview` overlay; point-snap indicator suppressed in line mode.
**Verification:** User confirmed the detected wall segment highlights on hover (after the six
diagnostic iterations below).
**Result:** Pass

### Milestone 6c — Click to commit
**Implemented:** In line mode, a single click commits a two-point measurement from
`lineSnapResult`; no vertex accumulation; no-op if no wall is detected.
**Verification:** User: "working well" — the committed measurement renders in the group colour
with correct length, for both vertical and horizontal walls.
**Result:** Pass

---

## Issues Encountered and Resolutions

The algorithm was developed iteratively against real vector data captured live with a temporary
`window.__lineSnapDebug` console dump (since removed). Each fix exposed the next problem; the
captured data was essential because the failures were impossible to predict from the source
geometry alone.

**Issue 1 — Tiny segments on a continuous wall produced tiny measurements.**
- Symptom: hovering a wall built from many short collinear segments detected only one ~2pt piece.
- Diagnosis: the nearest segment was a single small piece; nothing coalesced the run.
- Resolution: `mergeCollinearSegments` floods from the seed across adjacent collinear segments
  (2° angle, 2pt perpendicular, 60pt gap to bridge door openings within a face).

**Issue 2 — Merge appeared to do nothing; result snapped back to a sliver.**
- Symptom: with the merge in place, behaviour was unchanged.
- Diagnosis: the "extend to intersections" step tested the wall's *own* near-collinear pieces.
  They are collinear within 2° but not perfectly parallel, so each registered as an intersection
  scattered along the wall, immediately re-clipping the result to a sliver.
- Resolution: skip near-parallel segments when collecting crossings (only genuinely transverse
  segments are junctions); cluster crossings so a thick wall's two faces read as one junction.

**Issue 3 — Line ran past a perpendicular wall instead of stopping at it.**
- Symptom: at a T-junction the measurement overshot the crossing wall.
- Diagnosis (first, wrong): assumed the crossing wall touched only the wall's far face, so a
  synthesised "opposite face" test was added. This did not fix it.
- Diagnosis (real, from captured data): the cursor had snapped to a **0.6pt facet of a circle**
  (a column/node dot at the junction), not the wall. The "merged wall" was a 0.6pt diagonal stub
  and everything downstream was garbage.
- Resolution: **seed by longest merged run, not nearest segment.** Among candidates within the
  snap radius (and within an 8pt band of the nearest hit), pick the one whose merged collinear
  run is longest. Circle/symbol facets (run < 1pt) lose; the real wall (run 100pt+) wins.

**Issue 4 — Measurement overshot the wall's physical end.**
- Symptom: with the seed fixed, the bay extended ~7pt past the end of the wall.
- Diagnosis: distant segments crossing the wall's *infinite* extension produced boundaries
  beyond the wall (t outside (0,1)); one clustered with the wall end and pushed past it.
- Resolution: discard crossings with t ∉ (0,1) before clustering; clamp the final bay to [0,1].

**Issue 5 — Line stopped at a junction's centre, not its near face.**
- Symptom: a wall's top end and the crossing wall's faces chained into one cluster whose centroid
  sat *above* the crossing wall, so the line stopped early/in the wrong place.
- Diagnosis: representing a junction by its cluster centroid is wrong; the measurement should end
  at the face of the junction nearest the cursor.
- Resolution: keep each junction as a `[lo, hi]` range; bound the bay by the **near edge** of the
  nearest junction on each side of the cursor. A junction straddling the cursor is skipped (yields
  a full bay through it rather than a sliver).

**Issue 6 — On a horizontal wall the line ran through a pilaster.**
- Symptom: the measurement crossed a perpendicular wall instead of stopping.
- Diagnosis (from captured data): two problems. (a) The opposite-face search locked onto a
  **hatch line** ~20pt away (hatching is densely parallel), injecting phantom crossings from
  door-swing arcs and hatch ticks. (b) The 16pt cluster tolerance chained distinct walls (~10pt
  apart) into one over-wide junction that the cursor sat inside, so it was skipped.
- Resolution: **drop the opposite-face test entirely** (unreliable on hatched drawings; a real
  perpendicular wall crosses the near face directly anyway), and **tighten the cluster tolerance
  to 8pt** (merges a single wall's faces, ~2–6pt apart, but not distinct walls, ~10pt+ apart).

**Issue 7 — Zustand store served stale code across edits.**
- Symptom: repeated "nothing changed" reports after fixes that were verified to compile.
- Diagnosis: Vite HMR swaps the module but keeps the already-constructed Zustand store, so the old
  `resolveLineSnap` kept running after a hot reload.
- Resolution: full dev-server restart (not Ctrl+R) picks up store changes. A temporary
  `LINE_SNAP_VERSION` stamp logged on load was used to confirm the running build; since removed.

---

## Spec Deviations and Addenda

The feature was specified conversationally, not in a phase prompt. Decisions made and confirmed
with the user:

- **Stop at every transverse junction, including openings.** A transverse line crossing the wall
  (incl. a door/window break) is treated as a junction. The user explicitly chose this over a
  "run through small openings" rule. Impact: a future refinement could add an opening-width
  threshold if requested.
- **One bay per click.** A click measures the wall run between the two nearest junctions around
  the cursor, not the whole wall end-to-end. Confirmed with the user.
- **Opposite-face detection removed.** Initially added to catch perpendicular walls touching the
  far face; removed because hatching makes it unreliable and it is unnecessary in practice.
- **Line preview, not rubber-band.** In line mode the live overlay is the *detected* segment
  (gold endpoint diamonds), not a point-snap indicator or a draft polyline.

---

## Permanent Constraints Established This Phase

- **`drawingType` (`point` | `line`) is global app state owned by `appStore.ts`**, toggled from
  the ribbon Type group; `point` is the default. Snap dispatch in `ViewerCanvas`
  (`scheduleSnapResolution`) branches on it.
- **Line-mode detection lives entirely in `resolveLineSnap`** and operates on the existing
  `vectorIndex` segments in PDF points, Y-up — no backend/renderer change.
- **Seed selection is by longest merged collinear run, not nearest segment** — required so the
  cursor doesn't lock onto circle/symbol facets.
- **Junctions are transverse crossings of the detected face only** (no opposite-face synthesis),
  clustered at `LINE_JUNCTION_CLUSTER_PTS = 8`, bounded by the near edge facing the cursor.
- Tunable constants in `appStore.ts`: `COLLINEAR_ANGLE_SIN` (2°), `COLLINEAR_PERP_TOL` (2pt),
  `COLLINEAR_GAP_TOL` (60pt), `LINE_JUNCTION_CLUSTER_PTS` (8pt), line-mode snap radius (20px).

---

## Known Issues or Warnings Not Resolved This Phase

- **Per-hover merge cost.** Seed selection runs `mergeCollinearSegments` for each nearby candidate
  every frame. Acceptable at hover rates on the test drawing; if lag appears on very dense pages,
  precompute collinear runs once per page. Deferred — not observed in use.
- **Cluster tolerance is a fixed 8pt**, not derived from detected wall thickness. Walls thicker
  than ~8pt face-to-face could split into two junctions; not seen on the test data. Revisit if a
  drawing with thicker on-sheet walls misbehaves.
- **Openings always break the wall** (by design this phase). If an estimator wants to measure
  through doorways, an opening-width threshold would be a follow-up.

---

## Definition of Done

- [Pass] Type ribbon group toggles Point/Line; Point is default; active state highlighted
- [Pass] Dead "Object" ribbon button removed
- [Pass] Line mode auto-detects a wall on hover and previews it
- [Pass] Detection coalesces walls built from many small segments
- [Pass] Detection ignores circle/symbol facets (seeds the real wall)
- [Pass] Measurement stops at perpendicular walls (vertical and horizontal cases)
- [Pass] Measurement does not overshoot the wall's physical ends
- [Pass] Single click commits a two-point measurement in the group's colour/quantity
- [Pass] Debug scaffolding removed; `npx tsc --noEmit` clean
- [Pass] Verified in the running app and confirmed by the user

---

## State for Next Phase

Working: both measurement input modes — **Point** (click-to-place, snap engine) and **Line**
(hover wall auto-detect → clip to junctions → click to commit). Line mode handles tiny-segment
walls, two-face walls, circle/column-dot facets, hatching, and door-swing arcs on the DT345
architectural PDF, stopping at perpendicular walls on both axes. All built on the existing
out-of-process `pdf_renderer` vector extraction and `vectorIndex` — no backend change.

Not yet implemented / deferred: run-through for narrow openings; thickness-derived cluster
tolerance; per-page precomputed collinear runs (perf); the broader Phase 4 UI polish backlog.

Confirmed working commands at handover:

```powershell
cd C:\Users\Admin\Documents\Take-it-Off\desktop\src-frontend
npx tsc --noEmit

cd C:\Users\Admin\Documents\Take-it-Off
cargo check --package desktop

cd C:\Users\Admin\Documents\Take-it-Off\desktop
cargo tauri dev
```

Note: after editing `appStore.ts`, fully restart `cargo tauri dev` (not Ctrl+R) — Vite HMR keeps
the old Zustand store and serves stale store logic otherwise.
