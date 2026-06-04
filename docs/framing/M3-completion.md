# M3 — Quantity makeup + the four verification surfaces — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate passed (user confirmed all four surfaces reconcile).

## What was built

### Calc — `src/lib/framing.ts`
- `plateLayerCount`, `studHeightMm`, `dwangRowCount`, `PLATE_THICKNESS_MM` (= 45).
- `computeFramingQuantities(path, settings, mmPerPoint)` → per-wall `{ components[], totalM,
  studHeightMm, studCount, plateLayers, dwangRows }`. Each component carries `count`, `eachM`,
  `totalM`, and a `detail` string with the intermediate math (e.g. `2400 − 45×2 = 2310 mm × 8`).
- `aggregateFramingGroup(walls, settings)` → group totals (`plateTotalM`, `studTotalM`, `studCount`,
  `dwangTotalM`, `totalM`) + `perWall`.
- NZS 3604 formulae: plates `run × layers`; studs `studHeight × count`,
  `studHeight = wallHeight − 45×layers`; dwangs `⌊wallHeight/dwangCentres⌋ × run`.

### Unit tests — `src/lib/framing.test.ts` (vitest; `npm test`)
14 tests against the docs worked examples — stud height 2310, 8 studs, plates 8 m, studs 18.48 m,
**dwangs 12 m**, total **38.48 m**, plus guards (no scale → null, dwangs-off → no dwang line).
Added `vitest` devDependency + a `test` script. **First automated tests in the repo.**

### Four verification surfaces
1. **Sidebar group total** — framing groups roll up total lineal metres of timber
   (`DimensionGroupPane` `groupTotals` special-cases `timber_framing`).
2. **Itemised component child rows** — read-only `Plates` / `Studs (n)` / `Dwangs` rows with their
   lineal-m totals render beneath a loaded framing group in the tree.
3. **Summary table in Properties** — the Timber Framing dialog shows a live makeup summary
   (plate layers, stud-height math, dwang-row math) + a component totals table over the group's
   loaded walls, recomputed as the settings are edited.
4. **Breakdown Inspector panel** (`FramingBreakdownPanel.tsx`) — a "Breakdown" toolbar toggle (shown
   for framing groups) opens a floating panel: per-wall components with the intermediate math, group
   totals, and a **Copy CSV** button.

Bonus: framing hover + the live draw readout now show `N studs · X m`.

## Verification done

- `tsc --noEmit` → 0. `vitest run` → 14 passed.

## Gate (run the app)

Draw the worked-example wall — **90×45, single top & bottom plate, wall height 2400, ~4 m long** —
on a scaled page, then confirm all four surfaces agree:
- Breakdown panel: Studs `2400 − 45×2 = 2310 mm × 8`, Dwangs `⌊2400/800⌋ = 3 × 4.0 m = 12 m`,
  Plates `2 × 4.0 = 8 m`, **Total ≈ 38.48 m**.
- Sidebar group total ≈ **38.48 m**; child rows Plates 8 / Studs(8) 18.48 / Dwangs 12.
- Properties summary table matches.
- Copy CSV → paste into a spreadsheet → numbers reconcile.

## Next

**M4 — Corners (NZ 3-stud makeup).** See [`HANDOFF.md`](./HANDOFF.md).
