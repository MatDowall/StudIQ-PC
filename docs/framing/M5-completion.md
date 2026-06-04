# M5 — Doors — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed. Post-gate tweak (user request): the plate section spanning a
door opening renders as a thin dashed line (replacing the daylight-rectangle outline) so the opening
reads clearly in plan.

## What was built

### Backend — `desktop/src/lib.rs`
- `measurements.framing_json TEXT` (nullable) — `CREATE TABLE` + idempotent migration; carried in
  `MeasurementDto`, both measurement SELECTs, the mapper, and `copy_dimension_group`.
- New command `update_measurement_framing(measurementId, framingJson)` (registered).

### Calc & geometry — `src/lib/framing.ts`
- Opening model: `Opening`, `WallFraming`, `OpeningTemplate`, `DEFAULT_DOOR`, parse/serialize.
- `studLayout` — per-segment anchors + regular studs, shared by geometry and calc so cut studs and
  jacks reconcile.
- `computeFramingGeometry(path, settings, mmPerPoint, framing?)` — removes regular studs inside an
  opening, adds jamb (king + trimmer) studs, returns the daylight rect for rendering.
- `computeFramingQuantities(…, framing?)` — parent stud/dwang cut-outs + door members
  (king/trimmer/lintel/jack), extended `FramingComponentKind`. `aggregateFramingGroup` now returns a
  generic ordered `components[]`.
- `projectOntoPath` (ghost placement) and `openingPreview` (ghost render geometry).

### Frontend
- Store: `MeasurementDto.framing_json`, `updateMeasurementFraming`, `openingPlacement` +
  `setOpeningPlacement` (cleared on mode switch / close).
- `OpeningDialog.tsx` — daylight height/width, lintel size + ply.
- `Viewer.tsx` — "Add Door" toolbar button (framing groups) → dialog → placement.
- `ViewerCanvas.tsx` — ghost on hover (`projectOntoPath`), commit on click, daylight outline render
  on committed walls, right-click **Delete / Door options / Move**, Esc to cancel.
- The four verification surfaces (sidebar child rows, Properties summary, breakdown panel, CSV) all
  iterate the generic component list, so king/trimmer/lintel/jack appear automatically.

## Verification done

- `cargo build --package desktop` → ok. `tsc --noEmit` → 0. `vitest run` → **28 passed** (7 new door
  tests reconciling the worked numbers).

## Gate (run the app — restart onto the new build)

1. Draw a framing wall on a scaled page; **Add Door** → set daylight 2100×910, lintel 90×45 2-ply →
   hover the wall (yellow ghost) → click to place.
2. Confirm in plan: the daylight gap with **king + trimmer** studs each side, regular studs inside
   the opening removed. (Matches `door makeup.png` jamb layout — lintel/jacks are elevation members
   shown in the breakdown.)
3. Open **Breakdown**: parent **Studs** and **Dwangs** drop over the opening; **King studs /
   Trimmers / Lintels / Jack studs** are itemised; totals reconcile (and in the sidebar child rows,
   Properties summary, and Copy-CSV).
4. Right-click the door → **Delete** (qty restored), **Door options** (edit), **Move** (re-ghost).

## Next

**M6 — Windows** (door makeup + sill height/head height interlock, sill trimmer, jacks under sill,
sill-support jacks). See [`HANDOFF.md`](./HANDOFF.md).
