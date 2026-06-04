# M8 — Extra stud (Ctrl-hover) — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** (accepted — user proceeded to M9). `tsc` clean, **41/41 unit tests pass**.
No backend changes — extra studs live in the existing `framing_json`.

## What was built

### `src/lib/framing.ts`
- `ExtraStud { segmentIndex, centreMm }` added to `WallFraming` (+ parse).
- `extraStudRect(path, settings, mmPerPoint, segmentIndex, centreMm)` → the stud rectangle for a
  manual stud (perpendicular to the wall, like the set-out studs).
- `computeFramingGeometry` renders committed extra studs; `computeFramingQuantities` adds each to the
  stud count + its (rake-graduated) height to the stud total.

### `src/components/ViewerCanvas.tsx`
- **Select mode + Ctrl-hover** over a framing wall → a yellow **ghost stud** snaps onto the wall path
  (`projectOntoPath` + `resolveStudGhost`); **Ctrl+click** commits it (`commitExtraStud`).
- Right-click a committed extra stud → **Delete stud** (`hitTestExtraStud` + `deleteExtraStud`).
- Ghost clears on Ctrl release, leaving select mode, or pointer-leave. Opening/rake edits preserve
  extra studs (and vice-versa) via the `{ ...existing }` spread.

## Verification done

- `tsc --noEmit` → 0. `vitest run` → **41 passed** (1 new: an extra stud adds 1 to the count and its
  height to the total).

## Gate (run the app)

1. Draw a framing wall → **Select** mode → hold **Ctrl** and hover over the wall → a ghost stud
   tracks the cursor along the wall, aligned with the other studs.
2. **Ctrl+click** to place it → it renders as a stud and the **stud count + total** in the breakdown
   increase by one (and its length matches the local wall height, incl. on a raked wall).
3. Right-click the placed stud → **Delete stud** removes it and restores the count.

## Next

**M9 — 3D view** (react-three-fiber): a "Drawing" ribbon group (Plan View / View in 3D), walls
extruded to height with colour-coded members, OrbitControls; per-wall "View in 3D" modal. This is
also the surface the user will use to diagnose how walls/openings are built. See
[`HANDOFF.md`](./HANDOFF.md).
