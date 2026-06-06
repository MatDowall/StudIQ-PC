# Timber Framing — Decisions & Tunables Log

Running log of resolved assumptions, NZS 3604 rulings, and tunable constants. Append a dated
entry whenever an assumption is confirmed/changed or a tunable is set. New chats: trust the
**Confirmed** entries; treat **Provisional** ones as needing sign-off before relying on them in
quantities.

## Confirmed

- **2026-06-04 — Stud thickness `T` = 45 mm.** The second dimension of the framing size; the
  face width of a stud/plate drawn along the wall. (From brief: "a 45mm gap … then the third
  stud", plates "45mm thick".)
- **2026-06-04 — Members derived, not persisted.** Studs/plates/dwangs/lintels are computed from
  the wall path + group props + per-wall extras; only path geometry and per-wall extras
  (`framing_json`) are stored. Mirrors how `quantity.ts` derives quantities.
- **2026-06-04 — 3D engine = react-three-fiber** (Three.js + `@react-three/drei`).
- **2026-06-04 — Defaults:** stud spacing 600 mm; dwang centres 800 mm; daylight opening height
  2100 mm; daylight opening width 910 mm; default lintel 90×45 2-ply.

## Provisional (confirm before trusting in quantities)

- **PLATE-THICKNESS — plate/wall thickness in plan = the *first* dimension of the framing size**
  (the `90` of `90×45`). Plate lines drawn `±D/2` either side of the centre path. Rationale:
  studs are laid flat-to-the-wall so depth `D` spans the wall thickness. _Confirm at M2._
- **DWANG-ROWS — dwang row count = `floor(wallHeight / dwangCentres)`.** Matches the brief's
  worked example (2.40 / 0.80 = 3 rows). Tunable constant in `framing.ts`. _Confirm at M3._
- **LINTEL-LENGTH — lintel length = `daylightWidth + 2×45`** (45 mm bearing onto each trimmer).
  _Confirm at M5._

## Implementation notes (M1)

- **2026-06-04 — `framing_props_json` is opaque to the backend.** `desktop/src/lib.rs` stores
  and round-trips the blob without interpreting it; the frontend (`lib/framing.ts`) owns the
  `FramingSettings` shape, defaults, and parse/serialise. Keeps backend churn minimal.
- **2026-06-04 — `lib/framing.ts` started in M1** (ahead of the plan's M2 note) holding only the
  settings type/defaults/parse + `STUD_THICKNESS_MM`/`framingDepthMm`. Geometry + calc are
  added to the same module in M2/M3.
- **2026-06-04 — framing groups force `default_display = "length"`** (lineal metres, uom `m`) so
  the existing validation/rollup path is reused without a new display type.
- **2026-06-04 — Plate on/off uses checkboxes, not radio buttons** (brief said "radio button for
  on/off"). A single On checkbox + a Double checkbox is functionally identical and cleaner;
  revisit if the radio styling is specifically wanted.
- **2026-06-04 (post-gate, user request) — No positive/negative colour selectors for framing.**
  Timber Framing has no polarity, so the Properties dialog hides the Positive/Negative Dimensions
  rows; the group colour is set via the tree's "Change Colour" menu (which syncs `tree_nodes.colour`
  → `pos_colour`, the colour framing renders in). `pos/neg` style/colour are preserved unchanged on
  save.
- **2026-06-04 (post-gate, user request) — Framing size appended to the tree-row name**, e.g.
  "Framing - 90 × 45", in `DimensionGroupPane`. **Persists for all groups (selected or not):**
  `TreeNodeDto` gained a `framing_size` field, populated in the tree queries via
  `LEFT JOIN dimension_group_props` + `CASE WHEN measurement_type='timber_framing' THEN
  json_extract(framing_props_json,'$.framingSize') END`. This couples the tree query to the
  `$.framingSize` JSON key (the one place the otherwise-opaque blob is read in SQL); acceptable
  for a display label. `json_extract` is available (sqlx 0.8 bundles a JSON1-capable SQLite) and
  returns NULL for non-framing rows. _(Superseded the initial loaded-groups-only approach.)_

## Implementation notes (M2)

- **2026-06-04 — Stud set-out rule (`studCentreArcLengths` in `framing.ts`):** one stud flush at
  the start face (centre at `STUD_THICKNESS/2`), regular studs at exactly `studSpacing` centres
  from that first centre, and one stud flush at the end face (centre at `length − STUD_THICKNESS/2`).
  Tunable; revisit if NZ set-out should measure 600 from a wall end to the *second* stud instead.
  _Sanity check: a 4000 mm wall at 600 cts, 90×45 → 8 studs._
- **2026-06-04 — Plate outlines via averaged-normal offset (`offsetPolyline`).** Exact for a
  straight wall; polyline corners are approximate (slight under/over-run) until M4 adds the proper
  corner makeup. The `PLATE-THICKNESS` provisional (depth = first framing dimension) is now in
  visual effect — confirm at the M2 gate.
- **2026-06-04 — Framing draws as an open polyline** (like Length), not a closed area. Centralised
  in `isAreaType()` in `ViewerCanvas.tsx`; all hit-test/hover/render paths use it.
- **2026-06-04 — No page scale ⇒ centre path fallback.** Members need mm; without a scale
  `drawFraming` draws the bare centre path so the wall is still visible/selectable.

## Implementation notes (M3)

- **2026-06-04 — Calc lives in `framing.ts`** (`computeFramingQuantities` per wall,
  `aggregateFramingGroup` per group) — pure, returns lineal-metre components with intermediate
  math strings. **Covered by `framing.test.ts` (vitest, 14 tests)** against the docs worked
  examples (stud ht 2310, plates 8 m, studs 18.48 m, dwangs 12 m, total 38.48 m). Added `vitest`
  devDep + `npm test` script. The DWANG-ROWS / stud-height assumptions are now test-locked.
- **2026-06-04 — Framing rollup is special-cased in `DimensionGroupPane`, not `quantity.ts`.**
  `groupTotals` branches on `measurement_type === "timber_framing"` → uses
  `aggregateFramingGroup(...).totalM`; everything else uses `groupNetQuantity`. Keeps `quantity.ts`
  framing-agnostic (avoids a `quantity ↔ framing` import cycle, since `framing` imports
  `PagePoint` from `quantity`).
- **2026-06-04 — Four verification surfaces:** (1) sidebar group total = lineal m; (2) read-only
  **component child rows** (Plates / Studs(n) / Dwangs) under a loaded framing group; (3) **summary
  table** in the Properties dialog (live against the in-dialog settings + the group's loaded
  walls); (4) **Breakdown inspector** panel (toolbar "Breakdown" toggle, per-wall makeup with the
  math) + **Copy CSV**. Framing hover + live draw readout also show `N studs · X m`.
- **2026-06-04 — Properties summary uses the group's *loaded* walls** (`framingWalls` passed from
  the pane). If Properties is opened on an unselected group its walls aren't loaded → the table
  shows the derivation only with a "draw walls" hint. Reconciles fully for the (normal) selected
  group.

## Implementation notes (M4)

- **2026-06-04 — 90° corners enforced via `orthogonalConstrain`.** First point + first segment are
  free (a wall can run at any angle); every subsequent segment is forced parallel or perpendicular
  to the previous one. Applied to both the click placement and the live preview in `ViewerCanvas`.
- **2026-06-04 — NZ 3-stud corner makeup (`generateStuds` in `framing.ts`).** Corner studs flow
  into `studCount` → the breakdown automatically. Straight-wall count unchanged (8 for the 4 m
  example). _Test-locked: L-wall (2 m + 2 m, 600 cts) = 11 studs._
- **2026-06-04 (corrected after the user's 4-corner screenshot) — exact corner stud arc-lengths.**
  The first pass placed the corner studs too far into the corner (overlap / mismatch vs
  `corner makeup.png`). Re-derived from the markup so the three studs sit **adjacent, not
  overlapping** (depth `D`, thickness `T`=45, gap `G`=45, all in PDF points):
  - **Stud 1** (lead-in, on wall A): centre at `segLenA − (D/2 + T/2)` — backed off so its face
    meets wall B's near face.
  - **Stud 2** (lead-out, on wall B): centre at `−D/2 + T/2` (just *before* the corner, in the
    corner square, outer face flush to the outer corner).
  - **Stud 3** (lead-out, on wall B): centre at `−D/2 + T + G + T/2` (after the 45 mm gap).
  Verified: for 90×45 these give stud1 face / stud2 face adjacent at the wall-B near face, gap
  between stud2 and stud3 = 45 mm. New test asserts **no two studs overlap** (AABB area < 1 mm²).
- **2026-06-04 (fix after the deeper-frame screenshot) — corner gap scales with wall depth.** The
  gap between corner studs 2 and 3 was hard-coded to 45 mm, so stud 3 didn't reach the internal
  corner for frames deeper than 90×45. Corrected: `cornerGapMm(size) = framingDepthMm(size) − 45`
  (45 for 90×45, 95 for 140×45, 145 for 190×45 …), so stud 3's outer face always lands on the
  lead-in wall's inner face (the internal nailing corner). Stud 3 centre = `D/2 + T/2`. Test-locked
  for 90×45 and 140×45 (gap values + no-overlap).
- **2026-06-04 — Mitred plate corners (`offsetPolyline`).** Offset now scales by `1/cos(halfAngle)`
  so each plate edge sits exactly `depth/2` from the centre line and the two meet at the miter
  point (fixes the M2 corner overrun/overlap). Sharp angles clamped.
- **Known minor:** the snap indicator still shows the raw (pre-constraint) snap point during a
  framing draw; the committed/previewed segment is the constrained one. Cosmetic; revisit if
  distracting.

## Implementation notes (M5 — doors)

- **2026-06-04 — Per-wall openings in `measurements.framing_json`** (new nullable column +
  idempotent migration; `update_measurement_framing` command). Shape: `{ openings: [{ kind:"door",
  segmentIndex, centreMm, daylightHeightMm, daylightWidthMm, lintelSize, lintelPly }] }`. Position
  is **segment-local arc-length** (`segmentIndex` + `centreMm`), set by projecting the cursor onto
  the wall (`projectOntoPath`).
- **2026-06-04 — Stud set-out shared between geometry & calc (`studLayout`).** Splits each segment
  into `anchors` (flush/corner studs, always kept) and `regular` infill. Both `computeFramingGeometry`
  and `computeFramingQuantities` consume it so the studs *removed* by an opening and the *jacks*
  added always reconcile.
- **2026-06-04 — Door members & cut-outs (NZS 3604).** Kings: 2 × stud height. Trimmers: 2 ×
  (daylightHeight − bottom-plate makeup). Lintel: (daylightWidth + 2×45) × ply. Jacks: nJacks ×
  (wallHeight − top-plate makeup − daylightHeight − lintelDepth), where **nJacks = regular studs
  falling within the daylight** (those become jacks). Parent **studs** drop by the regulars inside
  the opening footprint; parent **dwangs** = rows × (run − Σ daylight widths). **Plates are NOT cut**
  (brief: only studs & dwangs are omitted). _Test-locked: 4 m wall + 1 door → studs 6, kings 4.62,
  trimmers 4.11, lintel 2.0, jacks 0.33, dwangs 9.27, plates 8.0 m._
- **2026-06-04 — Plan rendering of a door = jamb studs (king + trimmer each side) + cut regulars +
  the plate section over the opening drawn as a thin dashed line** (user request, replacing the
  earlier daylight-rectangle outline). `drawFraming` breaks each plate edge per segment, stroking
  the opening's arc-length range thin+dashed and the rest solid. The lintel/jacks are elevation
  members (shown in the breakdown, not as distinct plan footprints); `door makeup.png` is an
  elevation, the canvas is plan.
- **2026-06-04 — Placement UX.** "Add Door" (toolbar, framing groups) opens the dialog → sets
  `openingPlacement`; hovering a wall shows a yellow ghost (daylight + jambs) that commits on click;
  Esc / button cancels. Right-click a committed door → Delete / Door options (edit in place) / Move
  (delete + re-ghost). Components extended to king/trimmer/lintel/jack; breakdown surfaces, sidebar
  child rows, Properties table, and CSV all iterate the component list (now generic).

## Implementation notes (M6 — windows)

- **2026-06-04 — A door is a window with no sill** — unified via `headHeightMm = (window ? sill : 0)
  + daylightHeightMm`. `Opening.daylightHeightMm` = FFL→lintel for a door, glass height (head−sill)
  for a window; `sillHeightMm` set for windows. Door calc unchanged (sill 0 → head = daylight).
- **2026-06-04 — Window members (per `window makeup.png`).** Trimmers sit **on the sill** (length =
  head − sill = glass), vs doors which sit on the bottom plate (head − bottomMakeup) — branched via
  `trimmerBase`. Added **Sill** (1 × daylight width, between trimmers) and **Sill jacks** = under-sill
  cripples (nJacks, aligned with the jacks above) **+ 2 sill-support jacks** (hard to the trimmers),
  each from the bottom plate to the sill underside (`sillHeight − 45 − bottomMakeup`). New component
  kinds `sill`, `sill_jack`. _Test-locked: 4 m wall + window (sill 900 / glass 1200 / width 1200) →
  trimmers 2.40, lintel 2.58, jacks 0.33, sill 1.20, sill-jacks 3.24 (×4), dwangs 8.40, studs 6._
- **2026-06-04 — Sill/head/daylight interlock in `OpeningDialog`** (window mode): head = sill +
  daylight. Each height has a **lock button** (default: head locked) — the locked value is held
  (its input disabled) while editing one of the other two recomputes the third. E.g. head locked,
  daylight 2100→? : change daylight to 1000 ⇒ sill recomputes to 1100, head stays 2100. Dialog also
  reused for the right-click "Window options" edit. (Width is independent — no lock.)
- **2026-06-04 — Plan rendering of a window = the door rendering + a glass centreline** through the
  opening (standard plan symbol), so windows are distinguishable from doors in plan. "Add Door" and
  "Add Window" are a segmented control in the viewer toolbar.
- **2026-06-04 (post-gate fix) — the dashed plate span now covers the whole opening assembly
  (king-to-king, = daylight + 2 stud thicknesses each side), not just the daylight.** Previously the
  solid plate ran *over* the king/trimmer studs (read as overshoot). Plate strokes also use a `butt`
  line cap so they end exactly at the break (no round-cap overshoot).
- **2026-06-04 — Dwang reduction over an opening is by daylight width for both doors and windows**
  (approximation: ignores dwangs that could run in the below-sill / above-head cripple zones). Keeps
  parity with the door treatment; revisit if a finer split is wanted.

## Implementation notes (M7 — raking frames)

- **2026-06-04 — A rake is per-segment**, stored in `framing_json.rakes[] = { segmentIndex, startMm,
  endMm }` (the top-plate wall heights at the segment's start/end). Set via select-mode right-click →
  "Set raking frame" (`RakingDialog`, defaults to the group's wall height). The base calc is now
  computed **per segment** so flat segments are unchanged (35 prior tests still pass).
- **2026-06-04 — Rake calc.** Top plate uses **slope length** `√(run² + (end−start)²)` (bottom plate
  stays flat run); **studs graduate** — each stud height = local wall height (linearly interpolated
  at its position) − plate makeup, summed; **dwangs are height-relative** via `dwangLengthMm` (each
  row at level k·centres spans the run where local height ≥ that level → reduces to `floor(H/c)×run`
  when flat). _Test-locked: 4 m wall raked 2400→3600 → plate 8.176, studs 23.5005, dwangs 13.333 m._
- **2026-06-04 — Openings on raked segments:** stud cuts use local positions and the dwang reduction
  uses the local row count at the opening, but the opening *members* (kings/jacks…) still size to the
  group's nominal wall height. Edge case; documented limitation.
- **2026-06-04 — Plan rendering** is unchanged by a rake (the rake is in Z/elevation); raked segments
  show a small `⟋ start→end` label at the segment midpoint so they're visible in plan.

## Dwang model correction (2026-06-04, post-M7 user feedback + docs/dwang theory.png)

Supersedes the brief's simplified `(H/centres) × run` dwang formula and the earlier continuous-row
model.

- **Dwangs sit at fixed `centres` (800) up from the bottom plate**, and a row is placed only where
  it **clears the (sloping) top plate** — so rows in a bay = `floor(studZone / centres)`,
  `studZone = localWallHeight − plateMakeup` (plate makeup = 45 × plate layers). A 2.4 m wall
  (single T&B → 2310 stud zone) at 800 → **2 rows** (the 3rd dwang can't fit — the omitted "yellow"
  dwang). `dwangRowsForStudHeight(studZone, centres)`; `dwangRowCount` uses `studHeightMm(settings)`.
- **Dwangs are individual pieces between studs**, not continuous rows. Per **bay** (gap between
  adjacent rendered studs): `rows × bayGap`, `bayGap = centre spacing − stud thickness`. Bays
  spanning an opening are skipped. `dwang` component `count` reports the **piece count**.
- **Raked**: a bay's row count uses its **lower-end** height (the dwang must clear the rake across
  the whole bay), so the extra dwang is omitted where the rake gets tight — exactly the SketchUp
  behaviour.
- **Exact SketchUp reconciliation (test-locked):** 3 m wall raked 2400→3400, 800 cts → **14 dwangs,
  7.635 m** (11 × 555 + 3 × 510); top plate 3162 mm. Flat 4 m / 2.4 wall → dwangs **7.28 m** (14
  pieces); opening bays skipped → **3.95 m**.
- **Hover fix:** `updateHover` now passes the wall's `framing_json` to `computeFramingQuantities`, so
  the hover readout factors openings **and** rakes (previously showed the flat total).

## Implementation notes (M8 — extra studs)

- **2026-06-04 — Manual extra studs in `framing_json.extraStuds[] = { segmentIndex, centreMm }`.**
  In **select** mode, **Ctrl+hover** a framing wall shows a yellow ghost stud (`extraStudRect`,
  aligned/perpendicular to the wall, free position along the path via `projectOntoPath`);
  **Ctrl+click** commits it. Rendered by `computeFramingGeometry` (added to `studs`) and counted by
  `computeFramingQuantities` (adds 1 to `studCount` + its graduated height to the stud total).
  Right-click an extra stud → **Delete**. Ghost clears on Ctrl-up / leaving select mode / pointer-leave.
- Extra studs do **not** re-split dwang bays (the brief only requires they add to the stud count);
  documented simplification.

## Implementation notes (M9 — 3D view)

- **2026-06-04 — react-three-fiber** (`three` ^0.169, `@react-three/fiber` ^8, `@react-three/drei`
  ^9) added to `src-frontend`. Production bundle builds (three adds ~1 MB; chunk-size warning only).
- **2026-06-04 — `lib/framing3d.ts` `computeWall3D`** turns a wall (path + settings + framing) into
  3D box members (world metres, **Y up**, the PDF page as the floor: `X = px·S`, `Z = py·S`,
  `S = mm-per-point ÷ 1000`). **Reuses the 2D set-out** (`studLayout`, `openingJambs`, the dwang
  rule…) — now exported from `framing.ts` — so 3D matches the takeoff. Members: plates (top plate
  pitched on a rake), studs (graduated), dwangs (per-bay rows up from the bottom plate), opening
  kings/trimmers/lintel/jacks, window sill + sill jacks, extra studs. Each member is a box with a
  `yaw` (about world-up) + `pitch` (raked top plate) composed into a quaternion in the view.
- **2026-06-04 — `Framing3DView.tsx`** renders the members + a ground grid + lights + OrbitControls
  (pan/zoom/orbit), camera framed to the members' bounds. Colour-coded by member kind
  (`MEMBER_COLOURS`, loosely matching the makeup PNGs).
- **2026-06-04 — Ribbon "Drawing" group** (Plan View / View in 3D) toggles `view3d` in the store;
  `Viewer` swaps the 2D canvas for the full-page 3D scene. Right-click a framing wall → **View wall
  in 3D** opens an isolated modal (same component/navigation).
- **Known v1 limitations (to refine with user feedback in 3D):** member cross-section *roll* is not
  individually oriented (boxes use yaw/pitch only — fine for legibility); lintel `ply` shows as one
  box; the floor-plane orientation/handedness may need a sign flip once viewed.
  _(Handedness flip + PDF page as the ground plane both resolved 2026-06-06 — see "3D fixes" below.)_

## Unified member model (2026-06-04, post-M9 first-look fixes)

The takeoff and the 3D view now both derive from **one** function, `wallMembers(path, settings,
mmPerPoint, framing)` in `framing.ts` — a flat list of members each with a 3D box (world metres) +
`lengthM`. `computeFramingQuantities` aggregates it by kind; `computeWall3D` maps it to boxes. They
can no longer disagree. (The 2D plan render still uses `computeFramingGeometry` for footprints; that's
unchanged and footprint-only.) Fixes from the first 3D look:

- **Kings & jacks-above conform to the rake** — each uses the local wall height at *its own* x, so
  on a raked wall they meet the sloping top plate (previously all used the opening-centre height).
- **Window trimmers run full height** (bottom plate → underside of lintel), same as doors — **not**
  sill→head. Window trimmer total accordingly (e.g. 2 × (2100 − 45) = 4.11 m, was 2.40 m).
- **Sill-support jacks sit tight *inside* the trimmers** (`centre ± (dwHalf − thickness/2)`), bottom
  plate → sill underside — separate members from the trimmers (they were wrongly merged onto the
  trimmer line before). Under-sill jacks remain at the jack positions. Count/length unchanged.
- **Dwangs infill every framed bay** via a per-row model: at each row height (fixed centres up from
  the bottom plate) connect adjacent members *present at that height*, skipping only a bay that spans
  an open daylight (door: full height; window: sill→head). This adds the previously-missing dwangs
  **beside** an opening (regular→king) and **below the sill** (between cripples). Reconciles with the
  earlier per-bay model for openingless walls (SketchUp wall still 14 / 7.635 m). New opening dwang
  totals: door 5.28 m, window 5.72 m (4 m wall, 800 cts).
- **Lintel** rendered as `ply` stacked beams in 3D (length still ×ply in the takeoff).

## 3D fixes — horizontal flip + PDF page as ground (2026-06-06, user feedback)

Resolves two of the M9 "known v1 limitations": the handedness/flip and the floor plane. Both the
full-building view (`Viewer.tsx`) **and** the single-wall modal (`ViewerCanvas.tsx`) host a
`Framing3DView`; fixes had to land in both call sites (see the "wrong component" trap below).

### 1. Horizontal flip — `wallMembers` Z mapping (`framing.ts`)

The scene was mirrored left-for-right. Cause: PDF Y was mapped straight to world **+Z** while the
camera sits on the +X/+Z side, so north pointed *toward* the camera and the plan read reversed.
Fix — map PDF Y to world **−Z** and drop the matching sign flip on the yaw:

- `fz(s) = -(seg.a.y + dir.y*s) * S` (was `+`). Same change applied to the extra-studs branch.
- `yaw = Math.atan2(dir.y, dir.x)` (was `atan2(-dir.y, dir.x)`).

Convention now: **PDF X → world +X, PDF Y → world −Z**, page footprint `X:[0,widthM] × Z:[−heightM,0]`.
The ground plane (below) uses the same mapping, so plan and 3D agree.

### 2. PDF page as ground — `PageGround` in `Framing3DView.tsx`

A textured plane at `y ≈ 0`, sized `pageWidthM × pageHeightM` (`= width_pts/height_pts × mm_per_point ÷ 1000`),
centred at `(widthM/2, -0.002, -heightM/2)`. The preview PNG comes from the existing `render_preview`
command (`$APPCACHE/tiles/preview_page_N.png`, already inside the asset-protocol scope). `Viewer.tsx`
fetches it on demand when `view3d` flips on and passes `pageWidthM/pageHeightM/previewUrl` to the view.

**Three traps cost several iterations — read before touching this:**

1. **Wrong component.** The full-building 3D view lives in **`Viewer.tsx`** (line ~225), not
   `ViewerCanvas.tsx` (which only hosts the right-click single-wall modal). Early prop wiring went to
   `ViewerCanvas` only, so the page never showed in the view the user was actually opening. *Both*
   call sites need the page props.
2. **Cross-origin taint (silent).** The app runs on `localhost` (dev) but the preview is served from
   `asset.localhost`. Pointing an `<img>` straight at the asset URL loads it for display but **taints
   the WebGL context**, so `texImage2D` is silently dropped and the plane renders the material's
   default **white** — *no console error*. Fix: `fetch(url)` → `blob` → same-origin `blob:` object URL,
   which can never taint. (`csp: null` in `tauri.conf.json` permits the fetch.)
3. **Material shader not recompiling (the white-rectangle killer).** Rendering one `<mesh>` with a
   placeholder `<meshBasicMaterial color>` and then swapping to `<meshBasicMaterial map>` on the *same*
   mesh does **not** work: react-three-fiber reuses the material instance and assigns `.map`, but a
   `MeshBasicMaterial` compiled without a map uses a shader with **no texture sampler** — so it keeps
   rendering white. Fix: render the mesh **only once the texture is ready** (return `null` before), so
   the material is created in one shot with `map` already set. Never swap null→texture on a live material.

Also set on the texture (NPOT 1200×849 PNG): `minFilter/magFilter = LinearFilter`,
`generateMipmaps = false` (mipmaps need POT or WebGL drops the texture), `colorSpace = SRGBColorSpace`
(correct brightness), and `toneMapped={false}` on the material. The ground grid is kept just *below*
the plane (`y = -0.004`) as spatial reference while the texture loads.

**Debugging lesson:** "image loads (1200×849) but plane is white, no errors" points at the *GPU upload*,
not the *image load*. White plane = material's default colour showing through = sampler has no data →
either a tainted upload (trap 2) or a map-less compiled shader (trap 3). Don't keep re-checking the
image fetch once `onload` has fired with valid dimensions.

## Tunables (in `framing.ts`)

- `STUD_THICKNESS_MM = 45`
- `cornerGapMm(size)` (corner sheet-fixing gap = wall depth − stud thickness, per `corner makeup.png`)
- Stud set-out rule (`generateStuds` — flush/corner studs + `studSpacing` centres)
- Dwang row-count rounding rule (`floor` — see DWANG-ROWS)

## Nomenclature (NZS 3604 — do not drift to US terms)

stud · dwang (nog/blocking) · top plate · bottom plate · lintel (not "header") ·
trimmer · king stud · jack stud (not "cripple") · sill trimmer. Wall height = bottom of bottom
plate to top of top plate.
