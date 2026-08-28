# CLAUDE.md

Guidance for Claude Code (and future me) when working in this repository.

## What this is

**StudIQ** — a Windows desktop **PDF takeoff / measurement** application for
construction estimating (measuring quantities off tender drawings). The driving real-world
test data is a set of architectural PDFs from Cook Brothers tenders (Dunedin).

- **Backend:** Rust, Tauri v2 workspace — `core` (PDF/render) + `desktop` (app, commands, DB).
- **Frontend:** React 18 + TypeScript + Vite + **Zustand** (`desktop/src-frontend`).
- **Persistence:** SQLite via `sqlx` (per-project `.tcop` file + a global `registry.db` of recent projects).
- **PDF engine:** PDFium via `pdfium-render`.

## Architecture — read this before changing rendering

PDFium runs **out-of-process**. The desktop app spawns a long-lived child process
`pdf_renderer.exe` (built from `core/src/bin/pdf_renderer.rs`) and talks to it over
**JSON-lines on stdin/stdout**. This is the live rendering path — NOT the in-process
worker pool described in the early Phase 1 docs.

```
React/Zustand UI ──Tauri invoke──► desktop/src/lib.rs ──JSON lines──► pdf_renderer.exe ──► PDFium
   (appStore.ts)                    (commands + AppState + SQLite)      (child process)
```

Renderer protocol commands: `meta`, `preview`, `tile`, `vectors`, `shutdown`
(see `dispatch()` in `core/src/bin/pdf_renderer.rs`).

Key backend pieces in `desktop/src/lib.rs`:
- `RendererService` — owns the child process; `request()` is synchronous and serialized
  behind a `Mutex`. There is currently **one** renderer process and **one** tile worker.
- `AppState` — pdfium path, tile cache dir, tile manager, active project (DB pool), recent
  projects, renderer handle.
- Tile rendering: `update_viewport` computes visible tiles (zoom buckets + generation
  counters for stale-tile invalidation), enqueues `TileRenderJob`s; `run_tile_render_worker`
  renders them via the renderer; `poll_tiles` drains completed tiles. Tiles are written as
  PNG files into the app cache dir and loaded in the frontend via `convertFileSrc`.

Frontend state lives in `desktop/src-frontend/src/store/appStore.ts` (Zustand). The snap
engine (endpoint → midpoint → intersection, with a bbox prefilter) is in `resolveSnap` there.
Canvas drawing + pan/zoom + snap UI is in `components/ViewerCanvas.tsx`.

## Coordinate convention — measurements are PDF points, Y-up

All on-page geometry uses **PDF points with a Y-up, bottom-left origin** (the convention
PDFium and the snap engine use). `ViewerCanvas` converts to screen with `pageToScreen`
(`pageHeightPts - ptY`). The snap engine (`resolveSnap` / `scheduleSnapResolution`) produces
snap points in this space, and `drawOverlays` renders stored measurements through that same
`pageToScreen` path — so snap indicators and saved geometry share one coordinate space.

**Measurement tools store `geometry_json` as `[{ "x": <pt>, "y": <pt> }, ...]` in PDF points,
Y-up**, so saved geometry round-trips through snap and overlay with no flip. Internal canonical
units are millimetres: page scale is stored as `mm_per_point` (`page_scales` table), and group
width/height/offset are metres (the unit the properties dialog edits). Quantities are derived
on the frontend (`src-frontend/src/lib/quantity.ts`), not persisted to `measurements.quantity`.

## Build & run

pdfium.dll must be present at `libs/pdfium/pdfium.dll` (developer-placed; gitignored).
The frontend `npm run build` also rebuilds the `pdf_renderer` binary (see package.json script).

```powershell
# Frontend build (also builds pdf_renderer in release)
cd C:\Users\Admin\Documents\StudIQ\desktop\src-frontend
cmd /c npm run build

# Backend build
cd C:\Users\Admin\Documents\StudIQ
cargo build --package desktop

# Full installer (MSI + NSIS) — outputs under target/release/bundle/
cd C:\Users\Admin\Documents\StudIQ\desktop
cargo tauri build

# Dev mode
cd C:\Users\Admin\Documents\StudIQ\desktop
cargo tauri dev
```

Gotchas observed historically:
- File-lock build errors (`os error 32`) mean a running `desktop.exe`/`pdf_renderer.exe` is
  holding the binary or `pdfium.dll` — stop those processes before rebuilding.
- A stale `pdf_renderer` binary silently serves old behavior (e.g. "vectors not implemented")
  — rebuild `core --bin pdf_renderer` after changing it.

## Project status (as of June 2026)

Complete through **Phase 3**. Working: project create/open (.tcop), drawing register tree,
dimension-group tree, multi-page PDF view with tiled pan/zoom + preview, vector extraction,
the endpoint/midpoint/intersection snap engine, and the full CostX-style measurement suite —
**count / length / area** tools owned by the dimension group, per-drawing-page scale
calibration, the dimension-group properties dialog with the measurement-type → display
derivation matrix (length/area/wall area/volume; weight stubbed), positive/negative polarity
netting, live per-group quantities, CostX styling (bold outlines, circular handles, filled
areas, ringed-cross count markers, per-polarity colour + line style), and full
create/select/move/add-vertex/delete-vertex/delete editing with multi-group concurrent
rendering. See `docs/phase3-completion-report.md`.

CostX interaction model (authoritative — see `docs/phase3-plan.md`): add-mode is active while a
group is selected (no tool button); draw is **click-to-place** (right-click/Enter/double-click
to finish, Ctrl+click resumes from the last point, **middle-drag pans**); Add/Select toggle and
Positive/Negative toggle live in the ribbon's **Takeoff Items** group (`Ribbon.tsx`), not a
separate viewer toolbar — there is no toolbar between the canvas and the ribbon any more. Page
scale calibration ("Set Scale"/"Rescale") is a **Drawing** group ribbon button; the page-scale
readout, page navigation, and render-status text live in the app-wide footer bar (`Footer.tsx`)
below the canvas instead.

**Later (not yet built):** weight computation (needs a density/rate model), project-wide GFA
roll-up, persisting quantities, per-dimension overrides ("Use Default"), costing/reporting,
snap settings UI, perpendicular/nearest-edge/arc snap, dimension cutouts.

## Design decisions

### Timber framing: one quantity per framing size

A framing dimension group has a single `framingSize` (e.g. 90×45). Its **canonical quantity is
`matchingTotalM`** — the sum of all non-lintel components (plates, studs, dwangs, kings,
trimmers, jacks, sills, sill jacks). This is what the group header displays.

**Lintels are always their own separate quantity**, regardless of whether their size matches
the group's `framingSize`. They are excluded from `matchingTotalM` and shown as **virtual
sub-quantity rows** below the component breakdown — visually distinct, with their own total per
lintel size.

**Worksheet implication:** when a framing group is dragged onto a takeoff worksheet it emits:
- One row for non-lintel components → quantity = `matchingTotalM`, size = group's `framingSize`
- One row per distinct lintel size present → quantity = sum of that size's lintel `totalM`

Never use `FramingGroupBreakdown.totalM` as the worksheet quantity — it combines all sizes.

The `sizeOverride` field on `FramingComponent` / `FramingComponentTotal` is **always set on
lintel members** (to the lintel's own `FramingSize`) and absent on all other member kinds. This
is the key that excludes lintels from `matchingTotalM` and marks them for separate worksheet rows.

### Joist / Rafter blocking follows the same one-quantity-per-size rule

A Joist/Rafter (`array`) group can carry **blocking** (dwanging between joists/rafters) — a
checkbox, a centres value, and its own timber size in the group properties dialog
(`JoistRafterSettings.blockingOn` / `blockingCentresMm` / `blockingSize`, persisted in the same
`framing_props_json` blob as `framingSize`).

Blocking obeys the framing multi-size rule above: when `blockingSize === framingSize` it rolls
into the group's own quantity; when it differs it becomes a **separate child quantity** shown as
an accent-styled sub-row under the group, exactly like a framing lintel of a different size.
`aggregateArrayGroup` (lib/framing.ts) produces both, and `ArrayGroupBreakdown.matchingTotalM` is
the canonical group quantity — never use `totalM`, which combines both sizes.

Unlike the framing build-up, `deriveQuantity` (quantity.ts) deliberately does **not** know about
blocking — it stays the pure member-run length. Blocking is added at the group level only
(`aggregateArrayGroup`, consumed by `DimensionGroupPane`'s totals and `groupImport.ts`'s
`deriveDisplayQuantity`), because `quantity.ts` must not import `lib/framing.ts`: framing.ts
runtime-imports quantity.ts (for `applyArrayTrims`/`absArrayTrims`/`arrayTrimmedLengthPts`), and
the reverse direction would make that a cycle.

Geometry lives in `arrayBlockingPieces` (lib/framing.ts) and is the single source for the plan
overlay (`drawArray`/`drawArrayDraft`), the 3D view (`computeArrayMembers3D`) and the quantity, so
the three can't disagree. **Set-out is done in the rafter's own frame — distances down the slope —
then resolved into the plan arc-length the function returns.** Interior rows sit at
`blockingCentresMm`, so under a pitch they close up in plan by cos θ; each bay is additionally
blocked hard against **both ends** of its joists, and a grid row landing within a thickness of an
end row is dropped in favour of it. Each piece is one timber thickness (45) shorter than the member
spacing. A row is only emitted where **both** bounding members survive the array's trims at that
arc-length — and since a trim makes the cut the new end of the joists, the end rows follow it in.

**Off-axis trims skew the end rows.** A diagonal cut ends each joist in a bay at a different
arc-length, so an end row runs corner to corner between those two ends rather than square across the
shorter of them. Consecutive bays' end rows then meet at their shared joist and line up into one
continuous run of blocking along the cut, instead of a staircase of square stubs pulled back to the
short side. Hence `BlockingPiece` carries `runPtsA`/`runPtsB` (per-end arc-lengths, equal only for a
square row) and `lengthM` is measured in the roof plane, so a skewed row is genuinely longer and the
quantity reflects it. Interior grid rows stay square; one overlapping a skewed row's arc-length range
is dropped in its favour.

A skewed row under pitch has its two ends at **different heights**, which the `yaw` + `pitch` box
model cannot express — so `Member3D` has an optional **`roll`**, applied innermost about the member's
already-tilted local up-axis (`quaternionFor` in `Framing3DView` composes `Ry(yaw)·Rz(pitch)·Ry(roll)`).
That swings the member *within* its pitched plane and leaves the plane's normal alone, so a skewed
block stays flush in the roof plane at both ends. Only blocking uses it; everything else omits it.

Resolving that set-out into plan takes **two pitch terms, and getting them wrong is what made end
rows drift off the joist ends** (a QA finding — the error grew with pitch):
- the blocking's own 45 thickness lies *down the slope* (it's rolled square to the rafters, not
  plumb), so it foreshortens into plan by cos θ — an end row's inset is `22.5 × cos θ`, not 22.5.
  Getting this wrong costs `22.5 × (sec θ − 1)` mm: ~3.5 at 30°, ~9 at 45°, ~22.5 at 60°.
- hanging the blocking off the rafters' **top** face rather than centring it displaces its centre
  along the run by `(blockingDepth − framingDepth)/2 × sin θ`, applied to every row. Zero for
  same-size blocking; ~44 mm for 90×45 blocking in 240×45 rafters at 30°.

The joists' end faces are **square cuts**, so at pitch they are not vertical planes — "flush" means
the blocking's outer face lands on that same sloped plane, which is exactly what rafter-frame
set-out gives. `blocking.test.ts` asserts it to 1e-12 across 0–60° and mismatched depths.

In 3D each piece is **rolled to the pitch** and hung so its **top face is coplanar and flush with
the rafters'** (shallower blocking hangs from the top rather than sitting on the bottom). It reuses
the members' own `yaw`/`pitch` — `Framing3DView`'s `quaternionFor` composes `Ry(yaw)·Rz(pitch)`, so
an identical pair yields an identical local-Y axis — which requires the box's length on local Z and
the 45 mm thickness on local X, the mirror of the members' `[length, depth, width]` layout.

**Worksheet:** dragging a Joist/Rafter group in imports the joists + same-size blocking as the
row's quantity and, when the blocking is a *different* size, inserts a plain `"<size> Blocking"`
line item directly below — the exact analogue of the framing group's `"<size> Lintel to last"`
rows. `populateArrayRollup` writes it, `reconcileArrayBlocking` keeps it live on every display
(both in `WorkbookView.tsx`), and the row's `CellLink` carries `blockingSize` the way a lintel
row's carries `lintelSize`. `insertSubQuantityRowsBelow` is the shared inserter for both. The row
appears whichever display the group itself is imported as — it is a separate quantity of a
separate timber, not another reading of the same geometry. Blocking that is later switched off or
changed to the group's own size drives its row to 0; a newly-differing size needs a re-drop (same
rule as lintels, so the estimator gets to price it).

Unlike a framing group, an array group's row gets **no Quantity Build-up sub-sheet** — its
quantity is a flat member-run + blocking total with nothing to itemise into Description/Length
rows.

### Wall Surface from Framing reads other groups' framing, read-only

The `wall_surface` measurement type turns walls that have **already** been measured as Timber
Framing into lining / insulation surfaces, so linings never have to be re-measured. It owns no
geometry of its own: while a wall_surface group is active, every timber-framing wall on the page —
including walls belonging to **other** dimension groups, which `get_measurements_for_group` never
loads — is fetched by the `get_framing_walls_for_page` command into `framingSourceWalls` and drawn
**read-only**, in a neutral grey (`READONLY_FRAMING_COLOUR`, dashed, 45% alpha) that belongs to no
dimension group. That styling is the cue that the estimator is *not* in the framing group that owns
these walls: they can't be moved, resized, or given openings/rakes here, and right-clicking one
offers nothing (they aren't in `overlayMeasurements`, so `hitTestMeasurementId` never sees them).
Hovering the left or right face highlights that face's strip; a click commits it.

**The measurement is geometry + a self-contained snapshot.** `geometry_json` holds the source
wall's centre line (so the surface lives on the page and hit-tests like anything else — though it
is picked and drawn by its *face* strip, `wallFaceQuads`, never by that centre line), and
`framing_json` holds a `WallSurfaceMeta`: which wall/group/side it came off, the wall's plan depth,
and per segment the **face** length plus its top-plate height profile, plus each opening's daylight
hole. Face lengths come from the mitred offset line (`wallFacePath`), so the inside and outside of a
corner correctly differ by half the wall depth per mitred end. The snapshot is deliberately pure
numbers, which is why `wallSurfaceAreaM2` lives in `quantity.ts` alongside `deriveQuantity`:
quantities derive with no page scale and nothing else loaded (sidebar, workbook, Excel bridge all
agree), and `quantity.ts` still doesn't import `lib/framing.ts` — the cycle rule the Joist/Rafter
blocking note above explains. The *builders* (`buildWallSurfaceMeta`, `wallFacePath`,
`wallFaceQuads`, `pointInWallFace`) need real wall geometry, so they live in `framing.ts`.

**The Z datum is inherited from the framing.** A surface stands at the offset of the *framing*
group that owns its source wall (`WallSurfaceMeta.sourceOffsetM`, snapshotted from that group's
`default_offset` and carried on `FramingSourceWallDto.group_offset_m`), not at its own group's
`default_offset` — so a lining on a first-floor wall sits at that floor without the estimator
having to set the datum twice. It is part of the snapshot, so moving the framing group re-cuts
every surface taken off it via the usual drift check.

**Raking frames are respected**: a plain rake contributes its mean height over the segment, a gable
is two runs meeting at the apex (`apexFrac`), which is why a segment carries a height profile rather
than a single wall height. An opening's snapshotted `headMm` is the **framed** head, not the door
schedule's nominal one: `wallMembers` caps a lintel to the underside of the lowest top plate over
the opening's king studs, and under a rake that cap can sit well below the nominal daylight height.
`wallRooflineContext` (framing.ts) owns that computation and `wallOpeningHeads` exposes it, so the
frame, the snapshot and the pocket sweep all read one head; and an opening is cut on the WALL's
arc-length, into one piece per segment it covers, rather than clipped to the segment it is set out
from — but only along its own **straight run** (`collinearRun`), since `wallMembers` extrapolates an
overhanging jamb along its own segment's direction, straight past a corner rather than around it. Both matter for the same shape — a straight wall split at a vertex so part of its run can
rake, with a door straddling the split. `segments` is index-aligned with the path's segments (a
degenerate one is pushed, not skipped) because openings, pockets and face ratios are all keyed by
that index — a snapshot deriving it independently
punched a lining hole taller than the wall had and fed the sweep an inverted pocket, which dropped
the batts above the opening entirely.

**Openings are deducted by default.** The group-wide default lives in the group's
`framing_props_json` (`WallSurfaceSettings.deductOpenings`, edited in the properties dialog); each
surface may override it from its right-click menu (`WallSurfaceMeta.deductOpenings`, `null` =
follow the group). `wallSurfaceDeducts` is the single place that resolves the two.

**The snapshot stays live — but the re-sync must not feed itself.** `loadFramingSourceWalls`
re-derives every surface's snapshot from the wall it came off each time the group is opened on that
page, and rewrites it (and the centre line) when the framing has moved, gained an opening, or been
re-raked — that follow-through is the point
of the type. `wallSurfaceMetaMatches` is the drift test, and it ignores `deductOpenings`, which is
the estimator's choice and never follows the wall. The persisted snapshot remains the source of
truth everywhere else.

Three things keep that re-sync from melting a page carrying a lot of insulation, all learned the
hard way when `sourceOffsetM` was added and every existing snapshot went stale at once:
- **It coalesces.** Its writes land in `overlayMeasurements`, which is what the effect calling it
  watches, so without the `framingSyncInFlight`/`framingSyncPending` guard every write re-enters it
  and redoes the whole derivation. One run at a time; one more at the end if anything asked while
  busy.
- **It writes once.** All rebuilt snapshots are persisted in parallel and folded into a single
  `set`. Per-surface writes re-rendered per surface, and mid-storm the 3D view showed the
  not-yet-rewritten measures at the old datum.
- **It hoists the pocket sweep.** `wallInsulationPockets` runs `wallMembers` over a whole wall and
  depends only on the wall, so it is cached per source wall and handed to `buildWallSurfaceMeta`
  via `precomputedPockets` — several runs on one wall, or a lining and its insulation, would
  otherwise repeat it.

It re-syncs **every loaded surface, not just the active group's** — the 3D view and the sidebar
render all selected groups, so re-syncing only the active one leaves the rest on a stale snapshot.
A schema addition to the snapshot should come with a SQL backfill in the startup migration (as
`sourceOffsetM` did), so existing projects do not pay for it as a frontend write storm on open.

**Lining and insulation are two distinct measurement types**, `wall_surface` and `wall_insulation`,
sharing this entire model — the same snapshot, the same read-only framing interaction, the same
`buildWallSurfaceMeta`. `isWallSurfaceType` matches either; `isWallInsulationType` only the second,
and it is what every fork keys off. (Insulation began as a radio inside `wall_surface`; a startup
migration promotes any group still carrying `framing_props_json.measureType === "insulation"`, and
its measurements with it, since the frontend dispatches on `measurement_type`.)

A lining is applied *to* the surface, so it covers the
whole face. Insulation goes *into* the frame, so it only occupies the voids between studs, dwangs,
plates, lintels, sills and jacks. Rather than subtracting a framing area from the face,
`wallInsulationPockets` derives **the voids themselves** off `wallMembers` — the same member list
the framing takeoff and 3D already share — and those pockets drive both the quantity
(`wallInsulationAreaM2`) and the batts drawn in 3D (`computeWallBatts3D`), so the two can't
disagree. `wallSurfaceMeasureM2` is the single place the types diverge.

The pocket sweep works per wall segment in its along/height plane: every member is projected to a
blocker with *linear* top and bottom edges (which covers plain rectangles and rake-cut wedges
alike), the segment is split at every blocker edge so the covering set is constant within a slab,
and each gap up the slab becomes a pocket capped by the roofline. A member set out from a
*neighbouring* segment counts too, but only across a **collinear** join (`COLLINEAR_DOT`, ~5°) and
within the wall's footprint band: an opening near a segment end puts its kings, trimmers and lintel
past the join, and a straight wall split so part of its run can rake is exactly that shape — without
this the batts are drawn straight through them. A segment that turns a corner fails the direction
test (its wedge's local along-axis is not this segment's either), so corner cavities keep the
approximate treatment described above.

Daylight openings are injected into the sweep as blockers, so `meta.pockets` is always the
openings-deducted set. **Deduct Openings stays the estimator's choice in insulation mode too**: with
it off, `wallInsulationPocketsFor` adds each opening back as a pocket of its own
(`wallOpeningAsPocket`). That add-back is exact rather than approximate, because the daylight is
clear of framing by construction — trimmers each side, lintel over, sill under — so it is precisely
the piece the sweep held back. The same list feeds the quantity and the 3D batts, so a surface that
isn't deducting draws a batt in the daylight rather than showing less than it charges for.

An opening therefore carries **two** positions: `centreMm` along the mitred face line (a lining's
set-out) and `frameCentreMm` along the centre line (the frame's, and so the pockets'). They differ
only on a segment mitred at a corner.

**Click takes the whole face; click-and-hold draws a partial run.** Holding the pointer on a
hovered wall and dragging along it sets a run, which commits on release; a plain click (movement
under `WALL_RUN_DRAG_THRESHOLD_MM`, measured in wall mm so it is zoom-independent) still takes the
whole face. The run is stored as `spanStartMm`/`spanEndMm` — cumulative CENTRE-line arc-length from
the wall's first vertex, `null`/`null` meaning the whole wall — and `buildWallSurfaceMeta` **clips
the snapshot at build time**: segment lengths and rake heights are resampled at the cut, openings
the run only partly covers are clipped to the measured part, and pockets are trimmed with their
sloped edges interpolated. Because the clipping happens in the snapshot, the area maths, the 3D
builders and the plan fill need no notion of partial runs at all.

Each segment therefore carries where the run starts as well as how long it is, on both set-outs:
`faceStartMm`/`faceLengthMm` (mitred face line, for a lining) and `frameStartMm`/`frameLengthMm`
(centre line, for pockets and the plan footprint). `wallSurfaceSpanQuads` is the one footprint used
for both the plan fill and hit-testing.

Anything that **re-derives** a snapshot must round-trip the run through `wallSurfaceSpanOf` — the
drift re-sync in `loadFramingSourceWalls` rebuilds every surface from its source wall on each visit,
and rebuilding without the run silently widens a partial surface back out to its whole wall.

Two surfaces in a group may not **overlap** on the same wall face (lining) or the same wall
(insulation) — `wallSpansOverlap` is the interval test, treating a `null` span as the whole wall.
Non-overlapping runs on one face are fine and expected; that is the point of the gesture. The
preview turns red while a run would clash. In `computeWallSurface3D`, whether a surface is partial
must be read from `meta.spanStartMm`/`spanEndMm` and **never** by comparing `faceLengthMm` against
the mitred panel length — those differ by design at a corner, and confusing the two reopens the
corner gap the mitred panel path exists to close.

**Insulation is picked by the wall, not by a face.** A lining is taken off one side, so its two
faces are separately hoverable and each can carry its own measure. Insulation sits in the cavity, so
the whole wall body (`wallBodyQuads` — both face strips together) is one hover target, one click,
and `existingSurfaceFor` ignores the side when checking for an existing measure: a second take-off
from the other face would be the same batts counted twice, not a separate quantity. `meta.side` is
still stored (fixed to `"left"`) so the snapshot has a definite value, but nothing reads it in
insulation mode. A group switched from Lining to Insulation *can* still be holding two surfaces for
one wall from before the switch; that double-counts, so `ViewerCanvas` warns in the footer rather
than silently dropping one — which of the pair to keep is the estimator's call.

Two deliberate asymmetries with the lining measure: insulation is set out along the wall's **centre
line** (a batt is cut to the frame, and the frame is set out on the centre line) where a lining uses
the mitred **face** line; and pockets at a corner are approximate, because the corner cavity is
filled by the adjoining wall's corner makeup, which belongs to that wall's own segments. Pockets are
snapshotted **unconditionally**, whichever type the group is, so the two types share one snapshot
and nothing needs re-cutting if a surface is rebuilt under the other.

**3D** (`computeWallSurface3D`) stands a thin upright panel on the face line per segment, following
the rake and split around each opening when the surface deducts them — so what's drawn is exactly
the area that was measured. A `wall_insulation` group instead draws one full-depth batt per pocket, in the
cavity rather than on the face; `meta.side` is ignored there, since both faces of a wall look into
the same cavity. The lining panel is placed on `wallFacePath(depth + panel thickness)` rather than
being pushed out along each segment's own normal — offsetting per-segment leaves a gap of the panel
thickness at every corner, because the two segments' normals differ there. A gable segment is split at its apex so each half stays a straight-topped
`wedge` quad.

### Pitch: a group-wide slope, or one measurement's own hinged plane

A dimension group's `pitch_angle_deg`/`pitch_direction_deg` describe a single mono-pitch for every
measurement in the group, and direction there is only ever 0 (along page X) or 90 (along page Y) —
what the properties dialog's Along X / Along Y toggle and its "Pick on Drawing" gesture produce.
That is enough for the quantity (a mono-pitch's area is `plan / cos θ` no matter where it is
hinged) but not for a roof: two planes in one group fall different ways, and which way a plane tips
only reads correctly in 3D once you say what it pivots about.

So an **area** measurement may carry its own `PitchAxis` (quantity.ts) — a signed `angleDeg`, a free
`directionDeg` in [-360, 360], and the `originX`/`originY` it rotates about — which supersedes the
group's angle *and* direction for that measure alone. `resolvePitch` is the single place that
override rule lives; every consumer (quantities, the hover card's pitch indicator, the 3D mesh)
goes through it, so they cannot drift apart. Clearing the axis drops the measure back to the
group's pitch.

`directionDeg` is the **uphill** bearing (CCW from page +X, in the same Y-up page space as
`geometry_json`), which is the convention `pitch_direction_deg` already used — so a group default
reads straight across into it. A **negative angle falls** along that bearing instead of rising,
so a plane can be tipped either way about one pivot without spinning the direction 180°.

**It rides in `framing_json` under the `pitch` key**, not in a column of its own. That blob is
already the frontend-owned per-measurement extras bag (wall framing, array meta, wall-surface
snapshots), every backend command and copy/paste/export path carries it unchanged, and
`deriveQuantity` is handed it at every call site — so the override reaches the quantities, the
workbook and the Excel bridge with no plumbing and no migration. `withPitchAxis` merges rather than
replaces (an array's meta and its axis coexist), and returns `null` once nothing else is left, so a
measure that never had framing extras goes back to a null column.

**The pivot changes nothing about the quantity** — only where the plane sits in 3D.
`computeAreaMesh3D` displaces each vertex by its distance along the uphill direction × tan θ,
measured *from the pivot*, so the surface rises on one side of it and drops **below the group's Z
datum** on the other. That is what makes a picked ridge or eaves line behave like a real hinge. With
no axis (a group-wide pitch, which has no pivot to give) the shape's own lowest vertex is used
instead, so the slab hinges up off its low edge and never sinks below the datum.

**Picking is done on the measure**: right-click an area measurement → *Set pitch axis…*, then click
a **corner** (pivot there, keeping whatever direction the measure or its group already had — a
corner says nothing about which way the slope runs) or an **edge** (pivot on its midpoint, with the
direction set to that edge's inward normal, so the surface tips up and away from it — an eaves line
with the ridge on the far side). The dialog (`PitchAxisDialog`) then settles the angle and direction
numerically over a plan preview of the shape.

**The pivot is an absolute page point, so it must be transported with the geometry.** Unlike an
array's trims (stored relative to `points[0]`, so they follow the shape for free), an axis left
behind turns a translation into height: a plane pitched 45° moved 3 m away from its pivot now
floats 3 m up, which swamps whatever Z offset its group is set to — copies of a ceiling group,
moved onto their own units, scattered vertically instead of stacking at their offsets.
`transformPitchAxisJson` is the one primitive for this, and **anything that moves, copies, flips or
rotates a measurement must put `framing_json` through it**: `shiftMeasurements`,
`flipMeasurements`, `rotateMeasurements` (the ghosts) and `commitMove`, `commitPaste`,
`rotateOrFlipSelected` (the persists). A flip mirrors the bearing (`180 - d` about Y, `-d` about X)
and a quarter turn rotates it (`d ± 90`); results wrap into (-180, 180].

**The axis is never drawn on the page.** Pinning a hinge line, arrow and angle to every pitched
measure cluttered the drawing, and a negative angle or direction swung the arrow outside the shape
altogether. The dialog's preview is the only place it is drawn; on the page, the existing green
on-hover pitch indicator (`computePitchIndicator`, which reads through `resolvePitch` and so shows
the measure's own angle) is what says a measure is pitched. `PITCH_AXIS_COLOUR` is now only the
pick-time corner/edge highlight.

Length and array groups still take their pitch from the group. The data model is type-agnostic (a
stored axis is honoured wherever `resolvePitch` runs), but only area exposes the pick UI.

### Workbook → Excel export is built in Rust, not JS

`WorkbookView.tsx`'s `exportExcel` flattens the workbook (unchanged, in the frontend) and hands
the row data to the Tauri command `export_workbook_excel` (`desktop/src/excel_export.rs`), which
builds the `.xlsx` with `rust_xlsxwriter` and writes it straight to disk. This replaced an
ExcelJS-based writer specifically because the optional "Include cost code columns?" checkbox adds
a group-by-cost-code summary block that relies on Excel 365 dynamic-array formulas
(`LET`/`FILTER`/`UNIQUE`/`BYROW`/`VSTACK`/`EXPAND`) — these only spill correctly if the file
carries the `XLDAPR` dynamic-array cell metadata (`xl/metadata.xml` + `cm="1"` on the formula
cell), which no JS `.xlsx` writer produces but `Worksheet::write_dynamic_formula` does natively.
When writing formulas that use these functions, function names (`LET`, `FILTER`, `LAMBDA`, …) are
auto-prefixed with `_xlfn.`/`_xlfn._xlws.` by the crate — but `LET`/`LAMBDA`-bound variable names
must be prefixed with `_xlpm.` by hand in the formula string, or Excel won't recognize them.

### Rate library is a supplier price book, shared across every project

The sidebar's **Rate Library** tab (`DimensionGroupPane.tsx`'s pane-level tab bar, beside
"Dimension Groups") browses supplier price books — one per merchant (Carters seeded by default;
more can be added, see below) — uploaded via the "Manage" console (`PriceBookManagerDialog.tsx`)
and shared across every project. It lives in `registry.db` (`price_book_imports` +
`price_book_items` + `price_book_merchants`), **not** the per-project `.tcop` database — the same
registry DB that already holds `recent_projects` — because a price book is company-wide reference
data, not project data. This is a different table from the older, per-project `rate_library` table
(`RateConstantsDialog.tsx` / `STUDIQ.RATE()`), which holds hand-entered project-specific rates; the
two are unrelated despite the similar name.

**Every merchant keeps its own independent rate library.** `price_book_imports.is_current` is
scoped per `merchant_id`, not app-wide — uploading a revised price book for one merchant only
resets *that* merchant's `is_current` flag and purges *that* merchant's old item rows
(`import_price_book`'s `UPDATE ... WHERE merchant_id = ?` / `DELETE ... WHERE import_id IN (SELECT
... WHERE merchant_id = ? AND id != ?)`), leaving every other merchant's current book untouched.
`list_current_price_books` returns one row per merchant with an active book — this drives
`RateLibraryPane.tsx`'s per-merchant tab strip, and every browse/search command
(`list_price_book_categories`/`_groups`/`_subgroups`/`_items`/`search_price_book_items`) takes a
`merchant_id` to scope to whichever tab is active. This is safe to replace freely because dragging
a rate into the workbook (`WorkbookView.tsx`'s `applyRateImport`, MIME type
`application/x-studiq-rate-item`) copies the code/description/unit/price values into the cell at
drop time — there is no live link back to the source row, so replacing a merchant's price book can
never retroactively change a rate a workbook has already borrowed. Contrast this with the
dimension-group → Quantity-column drag (`application/x-studiq-dimension-group`,
`handleGroupDrop`), which does keep a live link (`setCellLink`) back to the group.

Deleting a merchant (`delete_price_book_merchant`) deletes its *entire* rate library — every
import it ever had, current or historical, with item rows cascading away via their `import_id`
FK — rather than being blocked while it has ingest history, since every merchant permanently
owns its own library now; the frontend's confirm dialog spells this out before calling it. A
one-time startup migration (`init_registry_database`) clears `is_current` on any leftover
pre-merchant import (`merchant_id IS NULL`) from before this per-merchant model existed — nothing
else would ever reset that flag, since every reset path scopes to a real `merchant_id`.

The CSV's `Group`/`Sub Group` columns drive the Rate Library tree (Category → Group → Sub Group →
items), lazy-loaded per level the same way `DrawingRegisterPane`/`DimensionGroupPane` lazy-load
their trees. Only `description` and `unit_price` are actually required of a merchant format —
`category`/`group_name`/`sub_group` are optional, since some suppliers don't organize their price
list into a category hierarchy at all. `RateLibraryPane.tsx`'s `TreeBranch` renders the tree
generically off whatever the data actually contains: at each level it asks the backend for the
distinct values (`list_price_book_categories`/`_groups`/`_subgroups`, each accepting the parent
filters as `Option<String>` — `None` means "not filtered", `Some("")` means the deliberate
"(Uncategorised)"/"(Ungrouped)"/"(No Sub Group)" bucket for items that do have sibling values at
that level but are blank there). If a level's values are *all* blank — the field isn't mapped for
this merchant, or every item under the current filters leaves it blank — `TreeBranch` skips
rendering that level entirely and passes straight through to the next one, so the same component
handles a full Carters-style hierarchy, a flat description+price-only catalog, and anything in
between. `list_price_book_items` (and `search_price_book_items`) cap browse/search results at
`PRICE_BOOK_BROWSE_LIMIT`/200 rows respectively — only reachable in practice for a merchant with
no meaningful grouping, where "browse" would otherwise mean "list everything".

#### Merchants: pluggable per-supplier CSV formats

Every supplier names/orders its export columns differently (Carters' first header cell is
literally `# Download Date`; another merchant's file might not carry a `Sub Group` column at
all, or any category hierarchy whatsoever), so the parser doesn't hardcode one CSV layout.
`price_book_merchants` stores, per merchant, a `column_map_json` — a JSON object mapping each
canonical field to that merchant's literal CSV header text. The full field list is
`REQUIRED_PRICE_BOOK_FIELDS` (`description`, `unit_price` — nothing else) /
`OPTIONAL_PRICE_BOOK_FIELDS` (`category`, `group_name`, `sub_group`, `product_code`,
`unit_of_sale`, plus metadata fields) in `desktop/src/lib.rs`, mirrored in `PRICE_BOOK_FIELDS` in
`RateLibraryPane.tsx`. A "Carters" merchant is seeded on registry init with the mapping this
feature originally shipped with (including the literal `# Download Date` header — the leading
`#` is just part of the stored mapping now, not a special-cased strip).

`MerchantManagerDialog.tsx` (opened from the management console) is where formats are
authored, and it's data-driven rather than schema-first: a brand-new merchant starts with *no*
canonical field list shown at all — only "Load Sample CSV" (calling `preview_price_book_headers`
to read just the header row of a real file). Once loaded, the editor renders one row **per
column that file actually has** and asks what each one represents (a `<select>` of the
canonical fields, defaulting to "Not used"), rather than the old approach of listing every
canonical field up front and asking the estimator to match one of their columns to it — the
latter implicitly pigeonholed every merchant into Carters' own shape. Saving a merchant
(`create_price_book_merchant`/`update_price_book_merchant`) only requires Description and Unit
Price to have been assigned to some column; everything else can be left "Not used".

The management console's upload flow requires picking a merchant first (`import_price_book`
now takes a `merchant_id`). At import time, every column that merchant's format maps to must
actually exist in the uploaded CSV (case-insensitive, trimmed match) — a required field whose
mapped header is missing fails the whole ingest with a message naming the expected column and
suggesting the estimator either picked the wrong merchant or the merchant's export layout
changed; nothing is written to `price_book_imports`/`price_book_items` when this happens
(the mapping is validated before the transaction opens). Optional metadata fields degrade
gracefully instead — if mapped but not found in a given upload, the value is just left blank
rather than failing the ingest. A merchant can't be deleted once it has ingest history
(`delete_price_book_merchant` checks `price_book_imports.merchant_id` first); the ingest
history table shows "Unknown" for `merchant_name` on imports predating the merchant column or
whose merchant has since been deleted.

Two CSV-hygiene quirks the parser (`import_price_book`) applies regardless of merchant: the
file may end with a few single-field disclaimer lines (Carters' export does) that a
strict-width CSV reader would error on (`flexible(true)`, then rows shorter than the header are
skipped), and multi-line quoted description fields are flattened to single-line (`\n`/`\r`
replaced with a space).

## Docs & process

`docs/` holds the phase **prompts** (specs), **handovers** (architecture/state between
phases), and **completion reports**. The most recent state is
`docs/phase3-completion-report.md` (plan in `docs/phase3-plan.md`). This project was developed
milestone-by-milestone with
explicit verification gates — keep that discipline: implement a milestone, verify it produces
visible/testable proof, then move on.

## UI styling rules

### Theme
All colours, spacing, and sizing constants live in `desktop/src-frontend/src/theme.ts`. Never
hardcode a colour or size that already exists in the theme — always reference `theme.*`.
Current key values:
- `theme.ribbonHeight` = 76 px — ribbon row in the App grid is driven by this value; changing it
  resizes both the CSS grid row (`App.tsx`) and the ribbon container together.
- `theme.rowHeight` = 22 px — used for tree rows throughout both sidebar panes.
- `theme.treeIndent` = 16 px — per-depth indent for tree rows.

### Icons — Google Material Symbols
The app uses **Google Material Symbols Outlined** loaded from the Google Fonts CDN in
`desktop/src-frontend/index.html`. Render icons as:

```tsx
<span className="material-symbols-outlined" style={{ fontSize: <px>, lineHeight: 1 }}>
  icon_name_here
</span>
```

Icon names use **snake_case** exactly as listed on fonts.google.com/icons (e.g. `save_as`,
`view_in_ar`, `calendar_view_week`). Do not use the older Material Icons font — always use
Material Symbols Outlined.

**Established icon assignments** (do not reassign without a design reason):

| UI element | Icon name |
|---|---|
| Add dimension group | `add` |
| Properties | `tune` |
| Copy | `copy_all` |
| Point drawing type | `polyline` |
| Line drawing type | `show_chart` |
| Plan View | `architecture` |
| View in 3D | `view_in_ar` |
| Dim (drawing dimmer) | `contrast` |
| Geometry (snap toggle) | `my_location` |
| Export project | `save_as` |
| Edit / Project Info | `edit` |
| Timber Framing group | `calendar_view_week` |
| Area group | `activity_zone` |
| Count group | `tag` |
| Length group | `diagonal_line` |
| Joist / Rafter group | `texture` |
| Wall Surface from Framing group | `add_column_left` |
| Wall Insulation from Framing group | `heat` |
| Recalculate workbook | `calculate` |
| Rotate Left (Page / Takeoff Item) | `rotate_90_degrees_ccw` |
| Rotate Right (Page / Takeoff Item) | `rotate_90_degrees_cw` |
| Flip Horizontal (Page / Takeoff Item) | `flip` |
| Flip Vertical (Page / Takeoff Item) | `flip` (rotated 90° via `Icon`'s `rotate` prop) |
| Set Scale / Rescale (Drawing group) | `straighten` |
| Add mode (Takeoff Items group) | `edit` |
| Select mode (Takeoff Items group) | `select` |
| Positive polarity (Takeoff Items group) | `rectangle_add` |
| Negative polarity (Takeoff Items group) | `low_density` |
| Add Door (Takeoff Items group) | `door_front` |
| Add Window (Takeoff Items group) | `window_closed` |
| Trim array (Takeoff Items group) | `content_cut` |

### Ribbon layout rules
- The ribbon uses `display: flex; align-items: stretch` — group divs fill the full ribbon height.
  The ribbon scrolls horizontally (`overflow-x: auto; overflow-y: hidden`) once its groups exceed
  the window width — expected now that the Takeoff Items group holds ~11 buttons — but vertical
  overflow within a group is still clipped, so the next two rules still matter.
- Each group div uses `flex-direction: column` with **no** `justify-content: space-between`.
  The group label sits at the bottom via `margin-top: auto` on the label element. Using
  `space-between` when content height ≥ container height causes flex items to overlap and get
  clipped vertically — avoid it.
- Ribbon buttons stack the icon **above** the label text (`flex-direction: column`). Icon size is
  30 px; label font-size is 9 px with an explicit 13 px line-height (not the default/`1`, which
  clips descenders on labels like "Copy" or "Rotate Right"). Button height is 50 px.
- Buttons default to flat/borderless (`.ribbon-btn` class in `index.css`) and only pick up a
  background + border on hover, press, or when toggled on (`is-active` class) — this is the
  Office/native look; don't go back to a permanently-filled background.
- Icon glyphs render in `theme.iconAccent` (the logo's blue, `#283891` light / `#7986CB` dark),
  set via the `disabled` prop on each group's local `Icon` component — not the button's `color`,
  which still governs the label text.
- Only add a group to `groups` in `Ribbon.tsx` if it has real wired behaviour. Static
  decorative-only groups were removed.
- A control that's only meaningful some of the time (e.g. Add Door/Window only for a timber-
  framing group, Trim only for an array group) stays visible and greys out (`enabled={false}` on
  `RibbonToolButton`) rather than being hidden — consistent with how Rotate/Flip already behaved
  before a takeoff item was selected. Use `RibbonToolButton` for any new one-off Takeoff Items
  button rather than hand-rolling the button markup again.

### Snap group
The Snap group contains only the **Geometry** button, which toggles `snapEnabled` in the store.
The Angle and Rebar buttons were removed as they had no wired behaviour. Do not re-add
dummy buttons to the ribbon.

### Sidebar trees — default expanded
Both `TreeNode` (`DrawingRegisterPane`) and `DimensionTreeRow` (`DimensionGroupPane`) initialise
`expanded` to `true` for folder nodes so all folders are open when a project loads. This is
intentional — do not change the default back to `false`.

### Dimension group icons
`measurement_type` is included on every `TreeNodeDto` via a `LEFT JOIN dimension_group_props`
in `query_tree_nodes` and `get_tree_node`. This means the icon for a dimension group is always
known from the node itself — no need to load full props first, and no glyph fallback.
When adding new measurement types, add an entry to `MEASUREMENT_TYPE_ICONS` in
`DimensionGroupPane.tsx` and a row to the table above.

### Project status
Projects have a `status` field (`TEXT NOT NULL DEFAULT 'Tendering'`) in `project_meta` and
in `recent_projects` (registry DB). Valid values are **"Tendering"** and **"Closed"** —
enforced by the dropdown in `ProjectInfoDialog`. The status is shown in the Recent Projects
list on the splash screen. If new status values are added, update both `STATUS_OPTIONS` in
`ProjectInfoDialog.tsx` and the docs here.

### Additive DB migrations
New columns are added with bare `ALTER TABLE … ADD COLUMN` executed at startup and the error
silently ignored (`.await` result discarded with `let _ = …`). This keeps existing project
files working without a versioned migration system. Follow this pattern for any new nullable or
`DEFAULT`-valued columns — never drop or rename columns.

## Conventions

- No build/CI yet. Vitest covers the pure geometry/quantity logic — `npm test` (`vitest run`) in
  `desktop/src-frontend`; see `src/lib/framing.test.ts` (wall framing), `src/lib/blocking.test.ts`
  (joist/rafter blocking + its 3D placement), `src/lib/wallSurface.test.ts` (wall-face geometry,
  rakes, opening deductions, snapshot drift) and `src/lib/area3d.test.ts` (the area group's
  mono-pitch 3D tilt and the per-measurement pitch axis). Add to these rather than hand-rolling a throwaway
  script when changing that math.
- SQL is always parameterized. Node mutations verify `expected_node_type` before acting — keep this.
- British spelling is used in identifiers in places (`colour`). Match surrounding code.
