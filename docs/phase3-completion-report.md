## Summary

Phase 3 turned the viewer from "look at the drawing + snap to geometry" into a CostX-style
measurement tool. It delivers the full **count / length / area** measurement type set, each
owned by its dimension group; **per-drawing-page scale calibration**; the **CostX
dimension-group properties dialog** with a **measurement-type → display derivation matrix**
(length, area, wall area, volume; weight stubbed); **positive/negative polarity netting**;
live **quantities** surfaced per group; CostX-faithful **on-screen styling** (bold outlines,
circular vertex handles, filled areas, count markers, per-polarity colours and line styles);
and full **create / select / move / add-vertex / delete-vertex / delete** editing. The
interaction model was reworked mid-phase to match CostX exactly after user feedback
(click-to-place drawing, Ctrl-resume, right-click finish, middle-drag pan, group-selection =
add-mode, multi-group concurrent rendering).

The planning artefact for this phase is `docs/phase3-plan.md`; this is the completion report.
All milestones were verified in the running app (`cargo tauri dev`) and confirmed by the user.

## Files Created or Modified

desktop/src/lib.rs - Added the `measurements.polarity` column (idempotent ALTER for existing
DBs), the `dimension_group_props` table, and the `page_scales` table. Added commands
`create_measurement`, `update_measurement_geometry`, `delete_measurement`, `set_page_scale`,
`get_page_scale`, `get_dimension_group_props`, `set_dimension_group_props`. Added
`PageScaleDto`, `DimensionGroupPropsDto`, the `GeometryPoint` validation struct, and the
shared `measurement_from_row` / `get_measurement` helpers. `get_dimension_group_props` always
sources the positive colour from `tree_nodes.colour` (single source of truth); both colour
paths keep it in sync.

desktop/src-frontend/src/lib/quantity.ts - New shared derivation module: geometry helpers
(polyline length, polygon area via shoelace, polygon perimeter), the `deriveQuantity`
display-derivation matrix, polarity-signed `groupNetQuantity`, and `formatQuantity` /
`quantityValueText`.

desktop/src-frontend/src/store/appStore.ts - Added measurement CRUD actions, per-page scale
state + cache + load/set actions, dimension-group props state + save action, multi-group
selection (`selectedGroupIds`, `groupColours`, `groupProps`), viewer mode (`add`/`select`),
selected-measurement state, draw polarity, and calibration state. `createMeasurement` now
takes the measurement type from the active group and the polarity from the toolbar.

desktop/src-frontend/src/components/ViewerCanvas.tsx - The bulk of the work: click-to-place
drawing for length/area, single-click markers for count, Ctrl+click path resume, right-click /
Enter / double-click finish, Esc cancel, Backspace undo; middle-drag pan; select mode with
vertex drag, Delete-key delete, and a right-click Add-point / Delete-point menu; scale
calibration capture + dialog; overlay rendering (bold paths, circular handles, filled areas,
count markers, per-polarity colour + line style, selection highlight, live draft preview);
live length/area readouts and hover-to-inspect tooltips in real units.

desktop/src-frontend/src/components/Viewer.tsx - Added the viewer toolbar controls: Add/Select
mode toggle, Positive/Negative polarity toggle, Set Scale button, and the page-scale status
indicator.

desktop/src-frontend/src/components/DimensionGroupPane.tsx - Ctrl+click multi-select of groups,
the "Properties" context-menu entry, live per-group net quantity in the tree and footer
(replacing the placeholder summary), and active-group-scoped "Clear measures".

desktop/src-frontend/src/components/DimensionGroupPropertiesDialog.tsx - New CostX properties
dialog: measurement type, default display (filtered by type), multiplier, width/height/offset,
Add To GFA, positive/negative colour + line style, weight UOM.

desktop/src-frontend/src/components/Ribbon.tsx - Briefly wired a measure toggle, then reverted
to the original static mock after the user clarified the ribbon's Add adds a *group*.

docs/phase3-plan.md - The Phase 3 plan (scope, decisions, derivation matrix, milestones).

docs/phase3-completion-report.md - This report.

## Milestones

Milestone 1 - Persist a measurement. Added the `dimension_group_props` table,
`measurements.polarity`, and the `create_measurement` / `delete_measurement` commands with a
temporary in-pane "Test measure" affordance. Verified create -> reload via
`get_measurements_for_group` -> render via `drawOverlays` -> delete, on the DT345 drawing.
User confirmation: "all working as per your steps. please proceed to m2". Pass.

Milestone 2 - Linear draw tool + CostX styling. Click-to-place vertices with live snap, bold
lines, filled circular vertex handles, hover tooltip. Reworked after user feedback to the true
CostX model: click-to-place (not press-drag), Ctrl+click resumes from the last point even after
commit, right-click/Enter/double-click finish, middle-drag pan, add-mode driven by group
selection (no ribbon button), and multi-group concurrent rendering. Select/edit was pulled
forward at user request: `update_measurement_geometry`, vertex drag, Delete-key delete, and a
right-click Add-point / Delete-point menu. User confirmation: "that is working, move on to m3".
Pass.

Milestone 3 - Scale calibration. Added the `page_scales` table with `set_page_scale` /
`get_page_scale`, a draw-a-known-dimension calibration capture + length dialog, a toolbar Set
Scale button and status, and real-unit readouts/tooltips. Verified a known dimension reads back
correctly. User confirmation: "working correctly, move on to M4". Pass.

Milestone 4 - Quantity calculation + dimension-group dialog. Added the CostX properties dialog
and `get`/`set_dimension_group_props`, the `deriveQuantity` matrix (length, area, wall area,
volume; weight stubbed), positive/negative netting, per-group live totals in the pane, and
per-polarity colours and line styles. User confirmation: confirmed quantities and netting after
the colour-persistence fix, then "move on to m5". Pass.

Milestone 5 - Area + count types. Area: live closing/filling draft preview and a 3-vertex
minimum (committed areas already filled and computed m2 from M4). Count: single-click ringed-
cross markers, count quantity (= multiplier per marker), point hit-testing for hover/select,
and the "no" count UOM. User confirmation: "area tool is great" and approval of the count
marker behaviour. Pass.

## Issues Encountered and Resolutions

Issue 1: The Milestone 2 draw tool was first built as press-drag-release. Diagnosis: CostX uses
click-to-place (click, move with rubber-band, click). Resolution: reworked the pointer state
machine to click-to-place with right-click/Enter/double-click finish and Ctrl-resume. Code
changed: `desktop/src-frontend/src/components/ViewerCanvas.tsx`.

Issue 2: A measure tool toggle was added to the ribbon. Diagnosis: in CostX the ribbon's Add
adds a dimension *group*, and add-mode is implicitly active whenever a group is selected.
Resolution: reverted the ribbon and drove add-mode from `activeDimensionGroupId`; added
multi-group Ctrl+click selection with concurrent per-colour rendering. Code changed:
`Ribbon.tsx`, `appStore.ts`, `ViewerCanvas.tsx`, `DimensionGroupPane.tsx`.

Issue 3: Hover-to-inspect never fired. Diagnosis: it was gated behind "not measuring", but
add-mode is always on while a group is selected. Resolution: run hover detection regardless of
mode, suppressed only mid-path where the live readout takes over. Code changed:
`ViewerCanvas.tsx`.

Issue 4: Releasing a dragged vertex showed a one-frame snap-back-and-forward flash. Diagnosis:
the edit preview was cleared before the async store update landed, briefly falling back to the
old stored geometry. Resolution: keep the preview on screen until `updateMeasurementGeometry`
resolves, then clear it. Code changed: `ViewerCanvas.tsx`.

Issue 5: Changing a group colour via the right-click menu reverted on reselect while the tree
swatch persisted. Diagnosis: the positive colour lived in both `tree_nodes.colour` and
`dimension_group_props.pos_colour`, and "Change Colour" updated only the former while reselect
reloaded the latter. Resolution: made `tree_nodes.colour` the single source of truth, with
`get_dimension_group_props` always sourcing the positive colour from it. Code changed:
`desktop/src/lib.rs`, `appStore.ts`.

Issue 6: The right-click Add-point / Delete-point menu items did not fire and clicks appeared
"hijacked by panning". Diagnosis: `ContextMenu` portals to `document.body` in the DOM, but it
was rendered as a child of the viewport div in JSX, so React synthetic pointer events bubbled
through the React tree into the viewport's `handlePointerDown` and started a pan. Resolution:
rendered the menu as a sibling of the viewport div (wrapped the return in a fragment); also made
Add/Delete mutually exclusive (vertex -> Delete, segment -> Add) and used closest-vertex
detection. Code changed: `ViewerCanvas.tsx`.

Issue 7: A stale Vite dev server held port 5173 (`Error: Port 5173 is already in use`), and
desktop rebuilds intermittently hit the file lock `os error 32`. Diagnosis: orphaned `node` /
running `desktop.exe` / `pdf_renderer.exe` processes. Resolution: stop those processes before
relaunching/rebuilding. No code change.

## Spec Deviations and Addenda

Addendum 1: Quantities are computed live on the frontend (`quantity.ts`) for display rather
than persisted to the `measurements.quantity` column. This keeps totals always consistent with
the current scale and group properties without recompute triggers. The column remains available
for a future reporting phase that needs server-side quantity queries.

Addendum 2: Per-group net totals are shown for the currently loaded (selected) groups only.
Computing totals for every group in the tree requires loading all groups' measurements, props,
and page scales, which is a costing/reporting concern and is deferred.

Addendum 3: "Add To GFA" is stored and editable in the properties dialog, but a project-wide GFA
roll-up is not computed. Per the Phase 3 plan, costing/reporting is post-Phase-3.

Addendum 4: The Weight display type is selectable and `weight_uom` is stored, but weight is not
computed (no density/rate model exists yet); the field is greyed when weight is not the display.

Addendum 5: `Default Offset` is stored but has no effect on 2D quantities (it is a height-above-
datum for CostX's 3D view, which this app does not have).

Addendum 6: Select/move/delete and vertex add/delete editing — listed under Milestone 5 in the
plan — were pulled forward into Milestone 2 at user request. This required a new
`update_measurement_geometry` command not in the original plan.

Addendum 7: Per-dimension parameter overrides (CostX "Use Default") remain deferred; Phase 3
applies group defaults to all measurements, per the M1 scope decision. The schema leaves room
for overrides later.

Addendum 8: Panning while measuring uses the middle mouse button (left-click places vertices);
wheel zoom is unchanged. This was a design decision to keep left-click for placement, matching
CostX's scroll-wheel pan.

## Permanent Constraints Established This Phase

Geometry continues to be stored as `geometry_json` arrays of `{ "x", "y" }` in PDF points,
Y-up, bottom-left origin. Internal canonical units are millimetres (scale is stored as
`mm_per_point`); group width/height/offset are in metres (the unit the dialog edits).

The dimension group owns the measurement type and all derivation parameters; measurements
inherit them. `tree_nodes.colour` is the single source of truth for a group's positive colour.

React portals that overlap pointer-handling elements must be rendered as siblings (not
children) of those elements, because React synthetic events bubble through the React tree, not
the DOM tree.

## Known Issues or Warnings Not Resolved

No production installer was built this phase; all verification was done via `cargo tauri dev`.
A `cargo tauri build` (MSI/NSIS) was not part of the Phase 3 gates.

The temporary "Clear measures" affordance in the dimension-group pane (active-group scoped)
remains as a convenience until a richer dimension-list management UI exists.

## Definition of Done

- [Pass] Milestone 1: create/delete a measurement; round-trips through DB and overlay
- [Pass] Milestone 2: CostX click-to-place linear tool; Ctrl-resume; styling; select/move/edit/delete
- [Pass] Milestone 3: per-page scale calibration; readouts in real units
- [Pass] Milestone 4: CostX properties dialog; derivation matrix; polarity netting; surfaced quantities
- [Pass] Milestone 5: area polygon tool (fill preview, min 3 pts) and count point-marker tool
- [Pass] Positive/negative colours and line styles render and net correctly
- [Pass] Multi-group Ctrl+click selection renders concurrently, each in its own colour
- [Pass] All milestones verified in the running app and confirmed by the user

## State for Next Phase

Working: count/length/area measurement tools driven by the group's measurement type; per-page
scale calibration; the CostX properties dialog with the measurement-type -> display derivation
matrix (length, area, wall area, volume); positive/negative polarity netting; live per-group
quantities; CostX styling (bold outlines, circular handles, filled areas, ringed-cross count
markers, per-polarity colour + line style); create / select / move / add-vertex / delete-vertex
/ delete editing; multi-group concurrent rendering; hover-to-inspect tooltips. All built on the
existing out-of-process `pdf_renderer` IPC and the endpoint/midpoint/intersection snap engine
from Phase 2.

Not yet implemented: weight computation (needs a density/rate model); project-wide GFA roll-up;
persisting computed quantities to the DB; per-group totals for unloaded groups; per-dimension
parameter overrides ("Use Default"); costing and reporting; snap settings UI; perpendicular /
nearest-edge / arc snap; dimension cutouts; a production installer build for this phase.

Environmental setup is unchanged from Phase 2: PDFium is loaded by `pdf_renderer`, not desktop;
the app expects `libs/pdfium/pdfium.dll` and the renderer executable. The real drawing used for
verification was `W:\Shared\CookBrothers\Dunedin\01 Active Tenders\DT345 - 8 Pitt Street\2. RFT
- Tender Docs\Drawings & Specs\3 - ARCHI PLANS REV A.pdf`.

Confirmed working commands this phase:

```powershell
cd C:\Users\Admin\Documents\Take-it-Off\desktop\src-frontend
npx tsc --noEmit
```

```powershell
cd C:\Users\Admin\Documents\Take-it-Off
cargo check --package desktop
```

```powershell
cd C:\Users\Admin\Documents\Take-it-Off\desktop
cargo tauri dev
```
