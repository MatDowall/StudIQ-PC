# Timber Framing — HANDOFF (start here)

> **This is the single source of truth for resuming the Timber Framing feature in a fresh
> chat.** Read this top-to-bottom, then [`00-plan.md`](./00-plan.md) for the full design and
> [`decisions.md`](./decisions.md) for resolved rulings. It is updated at the end of **every**
> milestone.

**Last updated:** 2026-06-04 — M9 code-complete (tsc + 41 tests + vite build), awaiting visual gate. **Feature M0–M9 done.**

## Status

| ID | Milestone | Status |
|----|-----------|--------|
| **M0** | Docs scaffold & process setup | ✅ done |
| **M1** | Type plumbing & framing properties | ✅ done (gate passed) |
| **M2** | Draw straight wall; render plates & studs | ✅ done (gate passed) |
| **M3** | Quantity makeup + 4 verification surfaces | ✅ done (gate passed) |
| **M4** | Corners (NZ 3-stud makeup) | ✅ done (gate passed) |
| **M5** | Doors | ✅ done (gate passed) |
| **M6** | Windows | ✅ done (gate passed) |
| **M7** | Raking frames | ✅ done (gate passed; dwang model SketchUp-reconciled) |
| **M8** | Extra stud (Ctrl-hover) | ✅ done (accepted) |
| **M9** | 3D view | 🔧 code-complete; tsc + 41 tests + vite build pass; **awaiting visual gate** |
| M3 | Quantity makeup + 4 verification surfaces | ⬜ not started |
| M4 | Corners (NZ 3-stud makeup) | ⬜ not started |
| M5 | Doors | ⬜ not started |
| M6 | Windows | ⬜ not started |
| M7 | Raking frames | ⬜ not started |
| M8 | Extra stud (Ctrl-hover) | ⬜ not started |
| M9 | 3D view | ⬜ not started |

## What's done

- **M0:** Created `docs/framing/` with `00-plan.md`, `HANDOFF.md`, `decisions.md`. No code.
- **M1 (done):** `timber_framing` type wired end to end; `framing_props_json` column; settings
  module; Properties dialog framing controls (no pos/neg); tree row shows "Name - 90 × 45". See
  `M1-completion.md`.
- **M2 (done):** `computeFramingGeometry` (plate outlines + stud set-out); `drawFraming` +
  `timber_framing` branch + live preview. Straight walls; corners deferred to M4. See
  `M2-completion.md`.
- **M3 (done):** `computeFramingQuantities` / `aggregateFramingGroup` + `framing.test.ts`. Four
  surfaces: sidebar rollup, itemised child rows, Properties summary table, `FramingBreakdownPanel`
  + Copy CSV. Gate passed. See `M3-completion.md`.
- **M4 (done):** 90° corners + NZ 3-stud corner makeup (depth-scaled gap) + mitred plates. See
  `M4-completion.md`.
- **M5 (done):** `measurements.framing_json` + opening model + door members/cut-outs + Add-Door
  placement (ghost/commit) + right-click Delete/Options/Move; dashed plate over the opening. See
  `M5-completion.md`.
- **M6 (done):** windows = door makeup + sill/head interlock (with per-height lock), Sill + Sill-jack
  members, glass centreline; king-to-king dashed plate. See `M6-completion.md`.
- **M7 (done):** per-segment `Rake`; slope-length top plate + graduated studs; **dwang model
  reworked** to per-piece-between-studs at fixed centres (SketchUp-reconciled, `dwangRowsForStudHeight`).
  `RakingDialog` + right-click Set/Edit/Clear + plan label. See `M7-completion.md`.
- **M8 (done):** `framing_json.extraStuds`; `extraStudRect`; Ctrl-hover ghost + Ctrl-click commit +
  right-click Delete. See `M8-completion.md`.
- **M9 (code-complete):** `three`/r3f/drei added; `lib/framing3d.ts` `computeWall3D` (reuses the 2D
  set-out); `Framing3DView.tsx` (OrbitControls scene); Ribbon **Drawing** Plan/3D toggle; full-page
  3D in `Viewer` + per-wall **View wall in 3D** modal in `ViewerCanvas`. tsc + 41 tests + vite build
  pass. **Visual gate pending.** See `M9-completion.md`.

## Immediate next step

1. **Finish the M9 gate** (run `cargo tauri dev` → draw framing on a scaled page → ribbon **Drawing →
   View in 3D** → walls stand up; orbit/pan/zoom; openings/rakes visible; right-click a wall → View
   wall in 3D modal). If good, flip M9 ✅ — **the feature is then complete (M0–M9).**
2. **Expected M9 tuning (use the 3D as the diagnostic surface):** floor-plane orientation/handedness
   (a sign flip in `computeWall3D` `fx/fz` or `yaw` if mirrored/rotated), member colours, raked
   top-plate pitch direction, lintel ply representation. These are quick `framing3d.ts` tweaks.

## After M9 (later — not in scope of this plan)

Per `00-plan.md` the feature is complete at M9. Possible follow-ups the user may raise: stud setout
matching a specific tool, openings on raked segments sizing members to local height, dwangs splitting
around extra studs, weight/cost rollup. Capture any in `decisions.md` before acting.

## How to run / verify

```powershell
# Frontend build (also rebuilds pdf_renderer.exe in release)
cd C:\Users\Admin\Documents\Take-it-Off\desktop\src-frontend ; cmd /c npm run build
# Backend build
cd C:\Users\Admin\Documents\Take-it-Off ; cargo build --package desktop
# Dev run (use this to verify gates, per project memory)
cd C:\Users\Admin\Documents\Take-it-Off\desktop ; cargo tauri dev
```
Stop any running `desktop.exe` / `pdf_renderer.exe` before rebuilding (file-lock `os error 32`).

## Key decisions so far

- New type lives **inside** the existing measurement system (new `measurement_type`), not a
  parallel one. Group settings → `framing_props_json`; per-wall extras → `measurements.framing_json`.
- Members (studs/plates/dwangs/…) are **derived on the frontend**, never persisted.
- See [`decisions.md`](./decisions.md) for the three flagged calc assumptions.

## Open questions / assumptions outstanding

- The three flagged assumptions in `decisions.md` (plate thickness = first framing dimension;
  dwang rows = `floor(height/centres)`; lintel length = daylight + 2×45) are **provisional** —
  confirm against NZS 3604 / the user when building M3/M5.

## Deviations from 00-plan.md

- `lib/framing.ts` was started in M1 (plan noted it as M2) holding just the settings type. Minor,
  natural home. See `decisions.md` "Implementation notes (M1)".
- Plate On/Off rendered as checkboxes rather than radio buttons (functionally identical).
