# M7 — Raking frames — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed. Major post-gate correction to the **dwang model** (user feedback
+ SketchUp reconciliation, see `decisions.md`): dwangs now sit at fixed centres up from the bottom
plate as **individual pieces between studs**, a row placed only where it clears the (sloping) top
plate → `rows = floor(studZone / centres)` at the bay's lower end. Test-locked against the user's
SketchUp wall (3 m raked 2400→3400 → **14 dwangs / 7.635 m**). Hover now factors openings + rakes.

## What was built

### `src/lib/framing.ts`
- `Rake { segmentIndex, startMm, endMm }` added to `WallFraming` (+ parse). `dwangLengthMm(start, end,
  run, centres)` — height-relative dwang length (reduces to `floor(H/c)×run` when flat).
- `computeFramingQuantities` refactored to accumulate **per segment** with rake awareness:
  - **Top plate** uses slope length `√(run² + (end−start)²)`; bottom plate stays flat run.
  - **Studs** graduate — each stud's height = local wall height (interpolated at its position) −
    plate makeup, summed.
  - **Dwangs** are height-relative via `dwangLengthMm`; the per-opening reduction uses the local row
    count at the opening.
  - Flat segments reproduce the previous numbers exactly (all 35 prior tests still pass).

### Frontend
- `RakingDialog.tsx` — start/end height (defaults to the group wall height).
- `ViewerCanvas.tsx` — select-mode right-click on a framing segment → **Set / Edit / Clear raking
  frame**; `setRake`/`clearRake` persist to `framing_json` (preserving openings + other rakes). A
  `⟋ start→end` plan label marks raked segments. Opening edits now preserve rakes too.

## Verification done

- `tsc --noEmit` → 0. `vitest run` → **40 passed** (5 new: `dwangLengthMm` flat + raked; a 4 m wall
  raked 2400→3600 → plate 8.176 m, studs 23.5005 m, dwangs 13.333 m).

## Gate (run the app)

1. Draw a wall on a scaled page → **Select** mode → right-click a segment → **Set raking frame** →
   set start 2400, end 3600.
2. The segment shows a `⟋ 2400→3600` label. Open **Breakdown**:
   - Plate total grew (top plate now follows the slope length).
   - Studs total grew (graduated heights up the rake).
   - Dwangs grew (more rows in the taller part).
3. Right-click again → **Edit / Clear raking frame**; clearing returns the segment to flat numbers.

## Next

**M8 — Extra stud (Ctrl-hover):** in select mode, Ctrl+hover a wall shows a ghost stud aligned to the
set-out; click places it at any unoccupied point, adding to the count. See [`HANDOFF.md`](./HANDOFF.md).
