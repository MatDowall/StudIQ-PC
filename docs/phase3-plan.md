# Phase 3 Plan — Measurement Tools (CostX-faithful)

Refined from `docs/phase3-kickoff.md` after a planning session. **North star: replicate
RIB CostX's measurement / dimension-group model and on-screen behaviour as closely as
practical.** Read `CLAUDE.md` for architecture, build, and the settled coordinate convention
(geometry is **PDF points, Y-up, bottom-left origin**).

## Scope (settled)

In scope: **linear** + **area** measurement tools, **per-drawing-page scale calibration**,
the **CostX dimension-group properties model** (measurement type → display derivation),
**positive/negative polarity netting**, and **quantity calculation**.

Deferred: count measurement tool, per-dimension parameter overrides, weight computation,
3D/offset use, snap settings UI, costing/reporting, Dimension Cutouts.

## The CostX model (what we're replicating)

A **dimension group** owns the measurement type and a set of derivation parameters; every
measurement ("dimension") drawn into it inherits them. Verified against RIB CostX docs
(sources at the bottom).

- **Measurement Type** (group-level, how geometry is drawn): `count` | `length` | `area`.
  Phase 3 builds the `length` and `area` tools; `count` is in the enum for forward-compat.
- **Default Display** (how the quantity is presented — may differ from how it was measured):
  `count` | `length` | `area` | `wall_area` | `volume` | `weight`.
- **Default Multiplier (M)** — factor applied to the quantity (waste %, repetition, etc.).
- **Default Width (W)** / **Default Height (H)** — feed the display derivations below.
- **Default Offset** — *height above datum (Z)* for CostX's 3D view. **No effect on 2D
  quantity.** Stored as metadata only; we have no 3D view.
- **Positive / Negative dimensions** — a group holds positive measures (main) and negative
  ones (cutouts/voids). **Net quantity = Σ(positive) − Σ(negative).** Each polarity has its
  own display colour + line style (hence two colour/style rows in the dialog).
- **Add to GFA** — flags the group's quantity for Gross Floor Area report totals (store the
  flag now; GFA aggregation/reporting is later).
- **Weight UOM** — unit for the weight display (kg/t). Stored; weight is **not computed** in
  Phase 3 (no density/rate model yet) — the Weight display option is greyed out.

### Display derivation matrix (M4 implements this)

Geometry yields a raw primitive — count **N**, length **L** (perimeter **P** for a closed
area), or area **A**. Default Display selects the formula. All × Multiplier **M**, signed by
polarity:

| Measure type | Valid Default Displays | Formula |
|---|---|---|
| Count  | Count      | N × M |
| Length | Length     | L × M |
| Length | Area       | L × W × M |
| Length | Wall Area  | L × H × M |
| Length | Volume     | L × W × H × M |
| Area   | Area       | A × M |
| Area   | Wall Area  | P × H × M  (perimeter × height) |
| Area   | Volume     | A × H × M |
| any    | Weight     | base × rate → Weight UOM  *(deferred)* |
| any    | Offset     | Z datum only — no quantity effect |

Net group quantity = Σ(positive) − Σ(negative).

## Settled decisions

| Decision | Choice |
|---|---|
| Measurement tools this phase | Linear + Area (count deferred) |
| Scale model | Per drawing-page; new `page_scales` table |
| Calibration UX | Draw a known dimension, type its real length (reuse snap engine) |
| Units | Canonical mm (linear) / m² (area); metric only |
| Attachment | Active dimension group + active drawing + active page; inherits group colour; blocked when any is null or the page has no scale |
| Per-dimension overrides | Deferred — group defaults apply to all measurements (leave schema room) |
| Weight display | Stored + greyed out (no rate model yet) |
| Line styles | Full set: solid, dashed, dotted, dash-dot |

## Data model changes

1. **`dimension_group_props`** — new side table keyed on `tree_nodes.id` (the group):
   `measurement_type, default_display, default_multiplier, default_width, default_height,
   default_offset, add_to_gfa, pos_colour, pos_style, neg_colour, neg_style, weight_uom`.
   Supersedes the single `tree_nodes.colour` for groups.
2. **`measurements.polarity`** — new column, `+1` / `-1`. `measurement_type` (already NOT NULL)
   is set from the group at create time; the group is the source of truth.
3. **`page_scales`** — new table `(drawing_id, page_index, units_per_point REAL, unit TEXT)`,
   unique on `(drawing_id, page_index)`.

## On-screen styling (CostX-faithful)

- Bold coloured outlines; **filled circular vertex handles**; semi-transparent fill for areas.
- Positive vs negative rendered with the group's per-polarity colour + line style.
- **Floating hover tooltip** on a committed measurement showing its quantity (the "2.578 m"
  chip). All rendering stays in `drawOverlays` / `ViewerCanvas.tsx`, in PDF-points/Y-up.

## Linear draw interaction (CostX-faithful)

- **Click-drag-release** = one segment.
- **Ctrl+click** continues a polyline/path from the last placed point.
- **Backspace** removes the last vertex; **Esc** cancels; live snap throughout.
- Finish on release (single segment) or Enter/double-click (polyline).

## Milestone sequence (verify-before-proceed — keep the discipline)

1. **Persist round-trip.** Schema: `dimension_group_props`, `measurements.polarity`. Commands:
   `create_measurement`, `delete_measurement`. Hard-code trivial geometry from a click →
   confirm it appears in `get_measurements_for_group` → renders via `drawOverlays`.
   *Verify on the DT345 drawing.*
2. **Linear draw tool + styling.** Click-drag-release; Ctrl+click polyline; Backspace/Esc;
   live snap. Bold line + circular vertices + basic hover tooltip. Save `measurement_type =
   "length"`. *Verify geometry lands exactly on snapped points.*
3. **Scale calibration.** `page_scales` + draw-known-dimension UX + set/read commands; block
   measuring until the page has a scale. *Verify a known dimension reads back correctly.*
4. **Quantity calc + dimension-group dialog.** Expand the group dialog to the CostX fields;
   implement the derivation matrix + positive/negative netting; store `quantity` + `uom`;
   surface in `DimensionGroupPane`. *Verify against a hand-measured value.*
5. **Area tool + polish.** Polygon draw (shoelace area + perimeter), area fill styling,
   delete/edit, "Add to GFA" flag wired. *Verify area + a negative cutout net correctly.*

## Key files

- `desktop/src/lib.rs` — commands, schema (`run_migrations`), `get_measurements_for_group`.
  New: `create_measurement`, `delete_measurement`, `dimension_group_props` + scale commands.
- `desktop/src-frontend/src/store/appStore.ts` — state, snap engine, measurement loading.
- `desktop/src-frontend/src/components/ViewerCanvas.tsx` — draw interaction, `drawOverlays`,
  vertex/line/fill styling, hover tooltip.
- `desktop/src-frontend/src/components/DimensionGroupPane.tsx` — measurement list / quantities.
- `desktop/src-frontend/src/components/Ribbon.tsx` — measure tool/mode + positive/negative.
- The dimension-group properties dialog (extend to the CostX field set).

## Test data

`W:\Shared\CookBrothers\Dunedin\01 Active Tenders\DT345 - 8 Pitt Street\2. RFT - Tender Docs\Drawings & Specs\3 - ARCHI PLANS REV A.pdf`

## Sources (CostX behaviour)

- RIB — Setting Up Standard Dimension Groups: https://www.rib-software.com/en/blogs/rib-costx-standard-dimension-group
- RIB — Dimension Cutouts (positive/negative, deductions): https://www.rib-software.com/en/blogs/rib-costx-dimension-cutouts
- RIB — Dimension Expressions (multiplier/width/height/offset, GFA, wall area = perimeter×height, volume = area×height): https://www.rib-software.com/en/blogs/rib-costx-dimension-expressions
