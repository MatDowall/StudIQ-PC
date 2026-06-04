# Timber Framing Measurement Tool — Master Plan

> **Repo-resident master plan.** This is the canonical specification for the Timber Framing
> feature. A new chat resuming this work should read [`HANDOFF.md`](./HANDOFF.md) **first**
> (current state + next step), then this document (full design), then
> [`decisions.md`](./decisions.md) (resolved rulings & tunables). Original feature brief:
> [`../Framing_tool.md`](../Framing_tool.md). Reference markups: `../corner makeup.png`,
> `../door makeup.png`, `../window makeup.png`, `../3d-1.png`, `../3d-2.png`.

## Context

A new **Timber Framing** measurement type for Take-it-Off: the estimator selects it from the
Measurement Type dropdown in Dimension Group Properties, then draws walls (like a Length
measure) that auto-populate NZ light-timber framing — studs, top/bottom plates, dwangs (nogs),
corner makeups, door/window openings, raking frames — and rolls the lineal metres of timber up
into the dimension-group sidebar. Framing can also be viewed in 3D.

This is a large, multi-subsystem feature. It must follow **NZS 3604** framing principles and
NZ nomenclature throughout (studs, dwangs, top/bottom plates, lintels, trimmers, king studs,
jack studs, sill trimmer — **not** US terms like headers/cripples/blocking). Two hard
requirements from the brief: (a) milestone gating with visible/testable proof at each gate
(matches this project's established discipline — `CLAUDE.md`, `docs/phase3-completion-report.md`,
`take-it-off-workflow` memory); (b) a way to **report a wall's quantity makeup during testing**
so the calculation logic can be verified.

**Confirmed decisions** (from the planning conversation):
- **3D** via **react-three-fiber** (Three.js + `@react-three/drei`).
- **Four** quantity-verification surfaces: breakdown inspector panel, summary table in the
  Properties dialog, itemised child nodes in the sidebar tree, and CSV/clipboard export.
- Sequence as a **thin vertical slice first**: one straight wall fully working
  (draw → members → verified makeup) before corners, openings, raking, and 3D.

---

## Architecture fit

The existing CostX-style measurement system is the foundation; Timber Framing is a new
`measurement_type` on top of it, **not** a parallel system.

- **Group owns the type.** `dimension_group_props.measurement_type` already drives draw/derive
  behaviour (`count | length | area`). We add `timber_framing`. Group-level framing settings
  don't fit the fixed columns → stored as a JSON blob (see Data model).
- **A wall is a measurement.** `measurements.geometry_json` already stores the path as
  `[{x,y}…]` in **PDF points, Y-up** (the project's coordinate convention — `CLAUDE.md`). A
  timber-framing wall reuses this for its centre-line path. Per-wall extras go in a new JSON
  blob on the measurement.
- **Members are derived, not stored.** Studs/plates/dwangs/lintels are *computed* from the path
  + group props + per-wall extras (like quantities are derived in `quantity.ts`, never
  persisted). One source of truth; auditable calc.
- **Rendering reuses the overlay canvas.** `ViewerCanvas.tsx` already draws overlays through
  `pageToScreen` and supports click-to-place drawing, snap, select/edit. The framing renderer
  is a new branch in `drawOverlays` + a new draw flow, reusing the scale (`mm_per_point`) to
  size members in real mm.

### Data model (backend — `desktop/src/lib.rs`)

1. **Allow the new type.** Add `"timber_framing"` to `MEASUREMENT_TYPES` (used by
   `create_measurement` ~L1204 and `set_dimension_group_props` ~L1451).
2. **`dimension_group_props.framing_props_json TEXT` (nullable).** Idempotent `ALTER TABLE`
   migration mirroring the existing `measurements.polarity` migration (~L1751, the
   `duplicate column name` guard). Holds: `framingSize` (`"90x45"`…), `studSpacingMm` (600),
   `topPlate {on, double}`, `bottomPlate {on, double}`, `wallHeightMm`, `dwangCentresMm` (800),
   `dwangsOn`.
3. **`measurements.framing_json TEXT` (nullable).** Same migration pattern. Per-wall extras:
   `openings[]` (doors/windows), `raking {startMm,endMm}` per segment, `extraStuds[]`,
   `removedStuds[]`. Null for non-framing measurements.
4. **DTOs.** Extend `DimensionGroupPropsDto` and `MeasurementDto` (and the `set_`/`get_`/`copy_`
   SQL column lists). `copy_dimension_group` (~L941, L960) must carry the new columns.

No new tables — one row already exists per group and per wall; JSON columns extend them without
changing the relational shape.

### Framing geometry & NZS 3604 calc rules (frontend — new `src/lib/framing.ts`)

All framing math/geometry lives in one pure, unit-testable module (good candidate for the
repo's first unit tests per `CLAUDE.md`). Canonical units **mm**; scale via `mm_per_point`;
member rectangles drawn through `pageToScreen`.

- **Framing size `D x T`** (e.g. `90 x 45`): `D` = stud depth = **plate/wall thickness in plan**
  (gap between the two parallel plate lines); `T` = stud thickness = **45 mm**, the face width
  drawn along the wall. Plate lines offset `±D/2` from the centre path.
- **Stud rectangle (plan):** `D` across the wall × `T` (45) along it, drawn with a
  corner-to-corner cross (architectural stud symbol), **transparent fill**, solid same-colour
  outline. Colour mechanics identical to other tools (pos/neg colour + line style from props).
- **Stud set-out:** first stud at path start; subsequent at `studSpacingMm` centres; a stud at
  the end on commit (Enter).
- **Plates lineal m** = `pathLength × plateLayerCount`, where
  `plateLayerCount = (topOn?1:0)+(topDouble?1:0)+(bottomOn?1:0)+(bottomDouble?1:0)`.
- **Stud height** = `wallHeightMm − 45 × plateLayerCount`.
  Worked: 90×45, single T&B, 2400 → `2400−45−45 = 2310`.
- **Studs lineal m** = `studHeight × studCount`.
- **Dwangs lineal m** = `floor(wallHeight / dwangCentres) × totalPlateRunLength`.
  Worked: 4 m wall, 2.40/0.80 = 3 rows × 4.0 = **12 m**. (Row-count rule `floor`; tunable.)
- **NZ 3-stud corner** (`corner makeup.png`): on a 90° corner click, place the final stud on the
  lead-in segment (stud 1), then on the lead-out segment a stud at the corner (stud 2), a `T`
  (45 mm) gap, then stud 3 — the internal sheet-fixing corner. Corners enforced to 90°.
- **Door** (`door makeup.png`): 2 king studs (full height) flanking; 2 trimmers under the lintel,
  length = `daylightHeight − 45×bottomPlateLayers`; lintel length = `daylightWidth + 2×45`,
  × `ply`; jack studs above the lintel to the underside of the top plate(s) — any full stud
  landing in the opening becomes a jack, keeping wall set-out. Studs/dwangs cut by the opening
  are **omitted** from the parent wall. Defaults: daylight height 2100, width 910, lintel
  90×45 2-ply.
- **Window** (`window makeup.png`): door makeup **plus** sill height + head height (head = sill +
  daylight; the three interlock dynamically), a sill trimmer, jacks under the sill aligned with
  the jacks above, and 2 sill-support jacks hard up to the trimmers.
- **Raking frame:** single segment; sloped top plate (use **slope length** for plate lineal m);
  stud length grows with local height; dwang rows computed against local height along the run.

---

## Milestones (gated)

Each milestone: implement → **verify by running the app** (`cargo tauri dev`, not just a compile
check) → write `Mx-completion.md` **and update `HANDOFF.md`** → stop at the gate for sign-off.
The completion report + handoff update is part of the gate — it makes the next milestone
resumable in a fresh chat.

| ID | Milestone | Gate |
|----|-----------|------|
| **M0** | Docs scaffold & process setup | `docs/framing/` + `00-plan.md` + `HANDOFF.md` approved |
| **M1** | Type plumbing & framing properties | Group set to Timber Framing; framing settings persist (dialog + DB) |
| **M2** | Draw straight wall; render plates & studs | Plate thickness/stud size match scale; studs at 600 centres; symbol/fill correct |
| **M3** | Quantity makeup + 4 verification surfaces | Worked-example wall reconciles across all four surfaces (stud ht 2310, dwangs 12 m) |
| **M4** | Corners (NZ 3-stud makeup) | L-wall matches `corner makeup.png`; corner studs in tally |
| **M5** | Doors | Matches `door makeup.png`; parent qty drops over opening; members itemised |
| **M6** | Windows | Matches `window makeup.png`; head/sill/daylight interlock |
| **M7** | Raking frames | Sloped-plate slope length + graduated studs; reconciles |
| **M8** | Extra stud (Ctrl-hover) | Ghost stud aligns to set-out; click increments count |
| **M9** | 3D view | Walls stand up matching `3d-1/3d-2`; orbit/pan/zoom; per-wall modal |

Detailed per-milestone scope is in the brief and expanded in each `Mx-completion.md` as reached.

---

## Key files

- `desktop/src/lib.rs` — `MEASUREMENT_TYPES`, schema migrations (~L1731–1794), DTOs (~L201–242),
  `create_measurement`, `get/set_dimension_group_props`, `copy_dimension_group`.
- `desktop/src-frontend/src/store/appStore.ts` — DTO types, `groupProps`, `saveGroupProps`,
  `createMeasurement`, draw/select state.
- `desktop/src-frontend/src/components/DimensionGroupPropertiesDialog.tsx` — framing controls +
  summary table.
- `desktop/src-frontend/src/components/ViewerCanvas.tsx` — framing draw flow, `drawOverlays`
  branch, ghost door/window/extra-stud, right-click menus.
- `desktop/src-frontend/src/components/Viewer.tsx` — toolbar Add Door/Window mode.
- `desktop/src-frontend/src/components/DimensionGroupPane.tsx` — itemised child rows, rolled-up
  total.
- `desktop/src-frontend/src/components/Ribbon.tsx` — Drawing ribbon group (M9).
- **New:** `src/lib/framing.ts` (geometry + NZS 3604 calc, pure/testable);
  `FramingBreakdownPanel.tsx`; door/window/raking dialogs; `Framing3DView.tsx` (M9).

## Reuse (don't reinvent)

- `pageToScreen` / `clientToPagePoint` and the click-to-place + snap pipeline in `ViewerCanvas`.
- `polylineLengthPts` + derive/format helpers in `lib/quantity.ts`; net-rollup via
  `groupNetQuantity` + `DimensionGroupPane` `groupTotals`.
- The idempotent `ALTER TABLE … duplicate column name` migration pattern in `lib.rs` (~L1751).
- The ribbon→pane command bridge (`dgPaneCommand`) and existing dialog/portal conventions.

## Verification

- Run the real app: `cd desktop && cargo tauri dev`. Rebuild `pdf_renderer` if its behaviour
  changed (`cmd /c npm run build` in `src-frontend` also rebuilds it; stale binary = old
  behaviour, per `CLAUDE.md`). Open a Cook Brothers tender PDF, calibrate scale, exercise the
  milestone's gate.
- The **Breakdown Inspector** (M3+) is the primary audit tool — every member tally shows its
  intermediate math, so quantity correctness is visually checkable. CSV export reconciles
  numbers offline.
- Add unit tests for `framing.ts` pure math (stud height, plate/dwang lineal m, corner set-out,
  opening trims) — first automated tests in the repo; recommended at M3.
