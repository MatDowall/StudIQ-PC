# M6 — Windows — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed. Post-gate tweaks (user requests): (1) the dashed plate now
spans the whole opening assembly king-to-king (no solid overshoot over the jamb studs; `butt` caps);
(2) each window height (sill / daylight / head) has a **lock button** so the interlock holds the
locked value and recomputes the third.

## What was built

### `src/lib/framing.ts`
- `DEFAULT_WINDOW`, `headHeightMm()` — a door is a window with no sill (`head = sill + daylight`).
- Window members in `computeFramingQuantities`: trimmers sit on the sill (`head − sill`), a **Sill**
  (daylight width), and **Sill jacks** (under-sill cripples aligned with the jacks above + 2
  sill-support jacks, from bottom plate to sill underside). New `FramingComponentKind`s `sill`,
  `sill_jack`. Door numbers unchanged.
- `FramingGeometry.openings` carries `kind` so the canvas can mark windows.

### Frontend
- `OpeningDialog` — window mode adds **Sill height** + **Head height** rows that interlock with the
  **Daylight (glass) height** (`head = sill + daylight`); reused for the right-click "Window options".
- `Viewer.tsx` — **Add Door / Add Window** segmented control (framing groups).
- `ViewerCanvas.tsx` — windows render like doors (jamb studs + thin-dashed plate over the opening)
  **plus a glass centreline**; right-click menu + edit title are kind-aware ("door"/"window").
- All four verification surfaces pick up `Sills` and `Sill jacks` automatically (generic component
  list).

## Verification done

- `tsc --noEmit` → 0. `vitest run` → **35 passed** (7 new window tests reconciling the worked numbers).

## Gate (run the app)

1. Draw a wall on a scaled page → **Add Window** → set sill 900 / glass 1200 / head 2100 / width 1200
   → confirm the **head/sill/daylight interlock** in the dialog → hover the wall → click to place.
2. Plan: jamb studs + dashed plate over the opening **+ a glass centreline** (distinguishes it from a
   door).
3. **Breakdown**: King studs, Trimmers (on sill), Lintels, Jack studs (above), **Sills**, **Sill
   jacks** itemised; parent studs/dwangs drop; totals reconcile across the four surfaces.
4. Right-click the window → Window options / Move / Delete.

## Next

**M7 — Raking frames** (select a segment → set raking; sloped top plate slope length, graduated stud
lengths, height-relative dwangs). See [`HANDOFF.md`](./HANDOFF.md).
