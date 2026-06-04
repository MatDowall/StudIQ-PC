# M1 — Type plumbing & framing properties — Completion Report

**Date:** 2026-06-04
**Status:** ✅ **DONE** — gate signed off by user.

## Post-gate refinements (user request)

- Removed the Positive/Negative Dimensions colour/style selectors from the Properties dialog for
  Timber Framing (no polarity for this type); colour is set via the "Change Colour" menu.
- The dimension-group tree row now appends the framing size to the name, e.g. "Framing - 90 × 45",
  **persisting whether or not the group is selected**: `TreeNodeDto` gained a `framing_size` field
  populated by the tree queries (`LEFT JOIN dimension_group_props` + `json_extract`), read directly
  in the row. (Replaced an initial selected-groups-only approach.)

Both compile + type-check clean (`node_modules/.bin/tsc --noEmit` → exit 0).

## What was built

End-to-end plumbing for a new `timber_framing` measurement type plus the group-level framing
settings. No drawing yet.

### Backend — `desktop/src/lib.rs`
- `MEASUREMENT_TYPES` now `["count","length","area","timber_framing"]`; `create_measurement`'s
  inline type guard also accepts `timber_framing`.
- New nullable column `dimension_group_props.framing_props_json TEXT` — added to the
  `CREATE TABLE` **and** via an idempotent `ALTER TABLE … duplicate column name` migration
  (same pattern as `measurements.polarity`), so existing project DBs upgrade in place.
- `DimensionGroupPropsDto` gains `framing_props_json: Option<String>` (opaque blob, backend
  doesn't interpret it).
- SQL wiring updated to carry the column: `get_dimension_group_props` (SELECT + both mapping
  branches), `set_dimension_group_props` (INSERT cols, `ON CONFLICT` UPDATE, bind), and
  `copy_dimension_group` (INSERT…SELECT column lists).

### Frontend
- **New `src/lib/framing.ts`** — `FramingSettings` type, `DEFAULT_FRAMING_SETTINGS`,
  `parseFramingSettings`/`serializeFramingSettings`, `FRAMING_SIZES`, `STUD_THICKNESS_MM`,
  `framingDepthMm`. (Geometry/calc land here in M2/M3.)
- `src/lib/quantity.ts` `GroupProps` gains `framing_props_json: string | null` (flows through
  `DimensionGroupPropsDto` in `appStore.ts`).
- `DimensionGroupPropertiesDialog.tsx` — "Timber Framing" added to the Measurement Type
  dropdown; when selected, the Default Display / Multiplier / Width / Height fields are replaced
  by the framing controls: **Framing Size** (45×45…290×45), **Stud Spacing** (600),
  **Top Plate** On + Double, **Bottom Plate** On + Double, **Wall Height**, **Dwang Centres**
  (800) + On. On save, framing groups serialise these into `framing_props_json` and fix
  `default_display = "length"`.

## Verification done

- `cargo build --package desktop` → compiles clean.
- `npx tsc --noEmit` (frontend) → exit 0, no diagnostics.

## Gate (needs running the app — restart onto the new build first)

A `desktop.exe`/`pdf_renderer.exe` from the **pre-change** build is still running; restart it to
load M1 (`cd desktop ; cargo tauri dev`, or stop those processes and relaunch).

1. Create/select a dimension group → open **Properties**.
2. Set **Measurement Type = Timber Framing** → the framing controls appear in place of
   Display/Multiplier/Width/Height.
3. Set e.g. Framing Size 90×45, Wall Height 2400, Stud Spacing 600, Top+Bottom plates on,
   Dwang Centres 800 → **Save**.
4. Reopen Properties → **every value persists** (and `dimension_group_props.framing_props_json`
   holds the JSON in the `.tcop` DB).

## Next

**M2 — Draw a straight wall; render plates & studs.** See [`HANDOFF.md`](./HANDOFF.md).
