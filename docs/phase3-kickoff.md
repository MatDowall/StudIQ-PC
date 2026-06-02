# Phase 3 Kickoff — Measurement Tools

Starting point for the Phase 3 planning session. Read `CLAUDE.md` first for architecture,
build commands, and conventions. This doc is scope + state + a suggested milestone breakdown;
treat the milestones as a draft to refine with the user, not a fixed spec.

## Goal of Phase 3

Turn the viewer from "look at the drawing + snap to geometry" into "measure quantities off
the drawing." The core loop: the user picks an active dimension group, draws a measurement on
a drawing page (using the existing snap engine), and gets a real-world quantity back.

In scope (proposed): **scale calibration**, **measurement creation/persistence**, and
**quantity calculation** for at least linear and area measurements.

Out of scope for Phase 3 (later): perpendicular / nearest-edge / arc snap, snap settings UI,
costing/reporting. Confirm the exact cut with the user before building.

## What already exists (don't rebuild)

- **`measurements` table** (see `run_migrations` in `desktop/src/lib.rs`): columns
  `id, dimension_group_id, drawing_id, page_index, measurement_type, geometry_json,
  quantity, uom, created_at`.
- **`get_measurements_for_group`** command reads measurements for a dimension group.
- **Overlay rendering**: `overlayMeasurements` in the store are drawn by `drawOverlays` in
  `ViewerCanvas.tsx`. As of the pre-Phase-3 fix, overlays render in **PDF points, Y-up**.
- **Snap engine**: `resolveSnap` / `scheduleSnapResolution` in `appStore.ts` produce snap
  points in **PDF points, Y-up** (endpoint → midpoint → intersection). A drawing tool should
  consume these directly.
- **Active-context state** in the store: `activeDimensionGroupId`, `activeDrawingId`,
  `activePageIndex`, `currentDocument`, `overlayColour`.

## The gap

There is **no `create_measurement` command** (and no update/delete). Nothing writes
`geometry_json` today, so persistence + the draw interaction are the heart of Phase 3.

## Coordinate convention (settled — do not relitigate)

`geometry_json` stores `[{ "x": <pt>, "y": <pt> }, ...]` in **PDF points, Y-up, bottom-left
origin**. Snap output and overlay rendering already agree on this. Any new draw/edit code must
produce and consume geometry in this space.

## Open decisions to confirm with the user before coding

1. **Measurement types for Phase 3?** Likely `linear` (polyline length), `area` (polygon),
   `count` (points). Which ship in Phase 3 vs later?
2. **Scale model.** Where does the points→real-world scale live, and at what granularity —
   per drawing-page, per drawing, or per project? Different sheets often have different scales,
   so per drawing-page is the safe default. It needs storage (a new column/table; `tree_nodes`
   has `uom` but no scale value).
3. **Calibration UX.** Draw a line over a known dimension and type its real length? Pick from a
   standard scale (1:100 etc.)? Both?
4. **Units.** `mm` is the existing default `uom`. Confirm the unit set (mm / m / m² / count).
5. **Where measurements attach.** Presumably created under the *active* dimension group on the
   *active* drawing page. Confirm.

## Suggested milestone breakdown (draft — keep the verify-before-proceed discipline)

1. **Persist a measurement.** Add `create_measurement` (and likely `delete_measurement`).
   Hard-code a trivial geometry from a click to prove the round trip: create → it appears in
   `get_measurements_for_group` → it renders via `drawOverlays`. Verify on a real drawing.
2. **Linear draw tool.** Click-to-place vertices with live snapping, Enter/double-click to
   finish, Esc to cancel; save as `measurement_type = "linear"`. Verify geometry lands exactly
   on snapped points.
3. **Scale calibration.** Implement the chosen scale model + calibration UX; store the scale.
   Verify a known dimension reads back correctly.
4. **Quantity calculation.** Compute length (and area, if in scope) from geometry + scale,
   store `quantity` + `uom`, surface it in `DimensionGroupPane`. Verify against a hand-measured
   value on the test drawing.
5. **Area + count types** (if in scope), then edit/delete polish.

## Key files

- `desktop/src/lib.rs` — Tauri commands, `measurements` schema, `get_measurements_for_group`.
  New: `create_measurement`, scale storage/commands.
- `desktop/src-frontend/src/store/appStore.ts` — state, snap engine, measurement loading.
- `desktop/src-frontend/src/components/ViewerCanvas.tsx` — canvas, snap UI, `drawOverlays`;
  the draw interaction goes here.
- `desktop/src-frontend/src/components/DimensionGroupPane.tsx` — measurement list / quantities.
- `desktop/src-frontend/src/components/Ribbon.tsx` — where a "measure" tool/mode would live.

## Test data

Real drawing used throughout verification:
`W:\Shared\CookBrothers\Dunedin\01 Active Tenders\DT345 - 8 Pitt Street\2. RFT - Tender Docs\Drawings & Specs\3 - ARCHI PLANS REV A.pdf`
