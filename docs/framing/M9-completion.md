# M9 — 3D view — Completion Report

**Date:** 2026-06-04
**Status:** code-complete; `tsc` clean, **41/41 tests pass**, **production `vite build` succeeds** (three
bundled); **awaiting visual gate**. No backend changes.

## What was built

### Dependencies
- `three` ^0.169, `@react-three/fiber` ^8, `@react-three/drei` ^9 added to `src-frontend`.

### `src/lib/framing3d.ts` — `computeWall3D(path, settings, mmPerPoint, framing)`
- Turns a wall into 3D box members. World = metres, **Y up**, the **PDF page is the floor**
  (`X = px·S`, `Z = py·S`, `S = mm-per-point ÷ 1000`); members extrude up in Y.
- **Reuses the 2D set-out** — `studLayout`, `openingJambs`, the dwang rule, layer counts (now
  exported from `framing.ts`) — so the 3D wall matches the takeoff exactly.
- Members: bottom/top plates (top plate **pitched** on a rake), studs (graduated height), dwangs
  (per-bay rows, fixed centres up from the bottom plate), opening **kings / trimmers / lintel /
  jacks**, window **sill + sill jacks**, and manual **extra studs**. Each is a box with `yaw`
  (about world-up) + `pitch` (raked top plate).

### `src/components/Framing3DView.tsx`
- r3f `<Canvas>` rendering the members as colour-coded boxes (`MEMBER_COLOURS`), a ground grid,
  ambient + directional lights, and **OrbitControls** (orbit / pan / zoom). Camera auto-framed to
  the members' bounding box.

### Wiring
- **Ribbon "Drawing" group** — **Plan View / View in 3D** toggle (`view3d` store flag).
- `Viewer` renders the full-page 3D scene (all framing walls on the page) when `view3d` is on, else
  the 2D canvas.
- `ViewerCanvas` right-click a framing wall → **View wall in 3D** → isolated modal (one wall, same
  3D component + navigation).

## Verification done

- `tsc --noEmit` → 0. `vitest run` → 41 passed. `vite build` → built (3D bundle OK).

## Gate (run the app — `cargo tauri dev`)

1. Draw framing on a scaled page → ribbon **Drawing → View in 3D**: the walls **stand up** in 3D
   (studs/plates/dwangs; openings show kings/trimmers/lintel/jacks; windows show sill + cripples;
   rakes slope). Orbit / pan / zoom. Compare to `docs/3d-1.png` / `3d-2.png`.
2. **Plan View** returns to 2D.
3. Right-click a wall → **View wall in 3D** → modal isolates that wall with the same navigation.

> This is the diagnostic surface for how the app assembles walls/openings. Expect tuning here:
> orientation/handedness sign, colours, member roll — feed back from what the 3D shows.

## Post first-look fixes (2026-06-04)

After the first 3D render, refactored to a **single shared member model** (`wallMembers`) feeding both
the takeoff and the 3D, and fixed: (1) kings/jacks now conform to the raked top plate; (2) dwangs
infill beside openings + below sills (per-row model); (3) window trimmers run full height with
separate sill-support jacks tight inside them. tsc + 41 tests + build all pass.

## Feature status

**M0–M9 complete.** The Timber Framing tool is feature-complete per `docs/Framing_tool.md`: type +
properties, draw walls (straight/corners), the full quantity makeup with four verification surfaces
(SketchUp-reconciled), doors, windows, raking frames, extra studs, and the 3D view.
