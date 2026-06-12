##Framing Measurement Tool##

an added measurement type to quantify framing materials

#Injection Point#

the tool will be a measurement tool, selected from the Measurement Type dropdown in Dimension Group Properties - called Timber Framing

#Dimension Group Properties#

as the tool differs mechanically from area, length & count, when Timber Framing is selected from the drop down, Default Display, Length, Default Multiplier & Default Width input boxes will be replaced with options speciific to timber framing:
	-Framing Size:
		- drop down with the following options to select from
			-45 x 45
			-90 x 45
			-140 x 45
			-190 x 45
			-240 x 45
			-290 x 45
	- Stud Spacing:
		text input to set stud spacing. default prepopulated to 600mm
	-Plates:
		- Top Plate: radio button for on / off which turns top plate on or off. check box for double top plate, which doubles up the top plate in quantity
		- Bottom Plate: radio button for on / off which turns bottom plate on or off. check box for double bottom plate, which doubles up the bottom plate in quantity	
	- Wall Height:
		- text input to set the overall height of the wall, from bottom of the bottom plate to top of the top plate
	- Dwang Centres
		- text input to set dwang centres 
		- radio button to turn on / off dwangs
		- default populates to 800mm
		
#Drawing Mechanics#

wall is drawn similar to a length Measurement, start point is placed and extruded along a path. see Corner Makeup.png in /docs - the yellow line denotes the drawn path, the wall is centre of this. this path line is only visible while the wall is being drawn. clicking again will invoke a corner. this can only be 90degrees. as the user draws the wall, studs are placed at the extreme start of the path and along the wall at the centres defined in the properties. pressing enter commits the wall, a stud is placed at the end as would be the case in a real world wall.

	Corner Mechanics:
	corners need to be include 3 studs as is standard in new zealand framing. when the user clicks to invoke a corner, a final stud on that lead in segment is placed, that is the first of three. two studs are then placed at the beginning of the next lead out wall. one at the extreme end of the wall - that is the second stud of three, then a 45mm gap (if we are placing a 90x45mm wall then the third stud. this creates an internal corner for sheet fixings. i have included a markup - Corner Makeup.png - in the same /docs directory.
	
#Appearance#

parallel lines indicate the outline of the plate, distance between is the scaled actual plate width as set in the properties. studs placed along the path are scaled to the correct dimensions i.e 90x45 as set in the properties. studs in architectural detailing are denoted with a cross from corner to corner - see corner markup.png in /docs for how this should look. provide a transparent fill for studs to make them clear on screen. same shade outline, non-trasparent. colour mechanics the same as other measure tools.

#Extra Stud#

when not in drawing mode, i.e when in select mode as selected in the top toolbar same as the other tools, the user can hover over a drawn wall while holding ctrl which shows a ghost stud aligned with the other studs in the wall, the user can place this at any point in the wall otherwise unoccupied by another stud, clicking commits this and adds to the stud count.

#Calculation Logic#

lineal metres of framing roll up into the Dimension group sidebar, and is made up of:
	- plates: total lineal metres factoring in bottom, top and the presence of double top / bottom Plates
	- studs: stud height x total number of studs. stud height is the wall height as defined in the properties less the thickness of plates, plates are 45mm thick and this needs to be multiplied by number of plates. worked example: 90 x 45 wall, single top & bottom plate, 2400mm high over frame: 2400-45-45=2310 stud height.
	- dwangs: (wall height divided by dwang centres) x total plate length. worked example wall 4m long: (2.40/0.80)*4.0=12m total of dwangs. 
new line items are added as children under the entry in the dimension group folder for lintels and other components. the parent dimension group remains and is the main source of quantity for lineal metres of timber as a built up quantity of all components, but we need a way to itemise other framing members, listed under the parent is the best layout.
in the Dimension group properties for a wall, put in a summary table of all the components making up that quantity. i.e studs number and total length, plate total length etc.
	
#Raking Frames#

in select mode, a single wall segment can be selected > right Click > set raking frame. this opens a dialog box with: text box for start height (default to the walls current height) and a text box for end height. this sets the wall with a raking top plate between the start and end. claculation logic should account for slope length of the top plate as well as stud length increasing as the wall increases in height and dwangs populating relative to the height of the wall at any given point. the raking frame is only applied to a single length of wall.
			
#Doors#

an option in the top bar along with add / select etc is Add Door. this brings up a dialog which allows the user to define:
daylight opening height: the height from the bottom of the bottom plate, i.e finished floor level, to the underside of the lintel. default to 2100mm
daylight opening width: width from trimmer to trimmer. default is 910mm.
lintel: type drop down (90x45, 140x45, 190x45, 240x45, 290x45), makeup: ie. how many ply, text input, the total lintel length is multiplied by this. default to 90x45 2 ply
	-an inserted door module contains (see door makeup.png in /docs.):
		-2 king studs (green, full height studs in markup, flanking trimmers.
		-2 trimmers either side of the daylight opening width, sits under the lintel. length of these is daylight opening height less bottom plate makeup height (as they sit on the bottom plate(s)
		- lintel, daylight width + 45 each side as they sit on the trimmers.
		- jack studs. these are above the lintel to the underside of the top plates(s) the set out of these is intended to keep the same spacing as the rest of the studs in the wall. esentailly any stud that was a full stud before the door was placed, is trimmed by the daylight height + lintel and become jack studs.
when the user places a door, as they hover over a wall, a ghost door makeup appears at the cursor and commits and trims itself into place on click. the studs and dwangs that are cut out with the door opening is omitted from the parent walls quantities.
when in select mode, the user can right click on a comitted door and has the following options:
	-Delete door: removes the door and restores the omitted quantites from the parent Wall
	- door options: opens the dialog box the user gets when they first insert the door, allowing the user to change those options. populates the fields with actuals and dynamcially adjusts quantites and the markup to suit.
	- move door: the user can move the door down the wall path. door components return to ghost mode and the door can be moved, quantites and markup dynamcially adjust to suit.

#Windows#

exaclty the same as doors but we have the addition of:
				- sill height to be entered in the settings dialog. 
				- head height - the top of the daylight opening from finished floor level
				- head height, sill height and daylight height dynamically adjust relative to what is being entered into them to keep the logic sound.
				- in addition to the jacks which mimic the door, we have jacks in the same position under the sill, aligned with the jacks above the lintel.
				- two jacks either side of the sill hard up to the trimmers each side - sill support jacks.
				- window makeup.png in /docs for your review.
				
#3D mode#

framing can be viewed in 3d. add a ribbon group called drawing. 2 buttons, 1 for 2d "Plan View" (the current configuration) and 1 for 3d "view in 3D" which renders the canvas and all wall frames in 3d.
example in /docs called 3d-1.png & 3d-2.png
the user pan and zoom around to view the 3d render.
within the right click menu on a wall in select mode, the user can click "View wall in 3D" which renders that wall in isolation within a popup modal. it inherits the same navigation (pan, zoom etc) as the full 3d view.

"View in 3D" is a dropdown (small caret on the button): "Current Page" (the behaviour above) or
"View Multiple Pages...", which opens a setup dialog. The dialog lists every page of the active
drawing that has timber-framing dimension groups, with a checkbox to include each page, a
checkbox per dimension group on that page (to choose which framing to pull in), and a per-page
Z-offset (metres) used to stack storeys vertically in the 3D scene. Rows can be dragged to set
draw order. On confirm, all included pages render together in one 3D scene, each offset along
world Y by its Z-offset; only pages at or below Z-0 show their PDF page as a ground plane (pages
above Z-0 render framing only, with the page render hidden).

#Implementation Plan#

- plan only at this stage, do not make any code changes until I approve milestones and plan
- framing must follow NZ framing principles as outlined in NZS:3604. DO NOT default or drift to international framing methods or nomeclature.
- review project documentation for feature Implementation guidelines.
- consider the best place to have milestones for this project and thier gates. 
- thouroughly document the process.
- we need to visually check that quantity makeup is correct, devise a way to report quantity makeup of walls durirg testing / development so i can verify that the logic is sound.

---

## Array Measurement Tool

A measurement type for evenly-spaced parallel elements — reinforcing bar layouts, floor joists, ceiling battens, stud arrays, fence pales, and similar repeating linear members.

### Injection Point

Selected from the Measurement Type dropdown in Dimension Group Properties — called **Array**. Icon: `data_array` (Material Symbols Outlined).

### Dimension Group Properties

When Array is selected the properties dialog changes as follows:

- **Default Display** is locked to **Length** — no dropdown is shown (array quantity is always expressed as total lineal metres of all members combined).
- **Default Width** field label changes to **Default Spacing** — sets the centre-to-centre spacing between members in metres (e.g. 0.600 for 600 mm joist spacing). This value is carried into each new measurement at draw time.
- **Default Height** field is hidden — not applicable.
- Default Multiplier, Default Offset, colours, and line styles behave identically to other measurement types.

### Drawing Mechanics

Drawing an array is a two-phase process:

**Phase 1 — Baseline**
The user clicks to place the first endpoint of the baseline, then clicks again to place the second. The baseline defines the direction and length of every member in the array. Snap follows the ribbon Geometry (snap) toggle; standard endpoint/midpoint/intersection snaps apply.

**Phase 2 — Extrusion**
After the second baseline click the tool enters extrusion mode. Moving the cursor perpendicular to the baseline shows a live ghost array: all members render as dashed lines evenly spaced at the group's Default Spacing. The number of members is derived from the perpendicular distance divided by the spacing, rounded to the nearest integer (minimum 1 member — the baseline itself). The direction of extrusion (which side of the baseline the array fans out toward) tracks the cursor side automatically.

Pressing **Enter** at any point during extrusion commits the array. If Enter is pressed before any perpendicular movement the array is committed as a single-member array (baseline only).

Pressing **Backspace** during extrusion cancels the extrusion and returns to Phase 1 so the baseline can be redrawn.

Pressing **Esc** or **right-click** during either phase cancels the entire draft.

Middle-drag pans the canvas during both phases (consistent with other tools).

### Live Readout

While drawing, the viewer status bar shows: `N members · X.XXX m` — the current member count and total committed length (all members combined).

### Appearance

Committed array members render as solid parallel lines in the group's positive/negative colour and line style, consistent with length measurements. Selected arrays highlight using the standard selection colour with circular endpoint handles on the baseline. Members clip to any applied trims (see Trim, below).

### Calculation Logic

**Quantity = (number of members) × (baseline length in metres) × default multiplier**

Number of members = 1 + extraMembers (extraMembers = 0 for a single-member array, determined at draw time by the extrusion drag).

The quantity is always expressed as total lineal metres (uom: `m`). Polarity (positive/negative) nets in the same way as other measurement types.

Array metadata — extraMembers, spacingPts (spacing in PDF points at the time of drawing), extrusion direction, and any trims — is stored in the measurement's `framing_json` column as a JSON object discriminated by `{ "type": "array", ... }`.

### Trim

When an Array dimension group is active, a **Trim** dropdown appears in the viewer toolbar (replacing the Positive/Negative toggle), with three options: **Trim** (off), **Trim: Line**, and **Trim: Box**. Selecting Line or Box activates trim mode with that trim type; selecting Trim turns trim mode off.

#### Line trim

The user draws a two-point cut line by clicking. A dashed preview line appears after the first click, following the cursor. While the second point is being placed, the array members ghost on the kept side (the side the cursor is currently on). Pressing **Enter** commits the trim; pressing **Esc** cancels the current trim draft without changing anything.

On commit the trim is applied to every array measurement on the current page that belongs to the active group and that the cut line actually affects. **Only individual members that the drawn trim *segment* actually crosses are clipped** — members that lie beyond either end of the trim line (i.e. the member crosses the trim line's infinite extension but not the drawn segment itself) are left untouched, even if the trim line's half-plane test would otherwise apply to them. Each affected member segment is clipped to the kept half-plane using a signed-distance half-plane test.

#### Box trim

The user draws a closed polygon by clicking to place vertices, the same way an Area measurement is drawn — a dashed outline rubber-bands to the cursor after each click, and the polygon edge closes back to the first vertex once at least three vertices are placed. Pressing **Enter** closes and commits the trim; pressing **Esc** cancels the draft. While drawing (3+ vertices placed), array members ghost to show what will be kept, based on whether the cursor is currently **inside** or **outside** the drawn polygon — everything on the same side as the cursor (inside or outside) is kept, the rest is removed.

A box trim can split a single member into multiple surviving pieces (e.g. a member passing through the box, with "outside" kept, survives as two separate segments either side of the box).

#### Common behaviour

Multiple trims accumulate — each successive trim (line or box, in any combination) is applied on top of existing trims. Trims are stored per-measurement in the `framing_json` metadata. A trim (of either type) is only attached to a measurement if it actually changes at least one of that measurement's member segments.

Trimmed measurements continue to contribute their post-trim length to the group quantity.

### Data Storage

| Field | Content |
|---|---|
| `geometry_json` | `[{x, y}, {x, y}]` — the two baseline endpoints in PDF points, Y-up |
| `framing_json` | `{ "type": "array", "extraMembers": N, "spacingPts": S, "direction": ±1, "trims": [...] }` |

Each trim entry is one of two shapes, distinguished by `kind`:

- **Line trim**: `{ "x1", "y1", "x2", "y2", "keepX", "keepY" }` (no `kind`, or `"kind": "line"` — the absent-`kind` form is for trims saved before box trim existed). `keepX`/`keepY` is the cursor position when the trim was committed, identifying the kept half-plane.
- **Box trim**: `{ "kind": "box", "points": [{x, y}, ...], "keepX", "keepY" }`. `points` is the closed polygon (vertices in drawing order); `keepX`/`keepY` is the cursor position when the trim was committed, identifying whether the *inside* or *outside* of the polygon is kept.

**All coordinates in every trim entry (including each `points` vertex) are stored relative to `pts[0]` (the baseline start point)**, not as absolute page coordinates — see "Trim coordinates are baseline-relative" below.

### Known Issues & Fixes (implementation notes)

A number of bugs were found and fixed while building the Array/Trim feature. These notes
exist so the same mistakes aren't repeated if the array tool is touched again.

- **"Unsupported measurement_type: array"**: there were two separate validation lists in
  `desktop/src/lib.rs` — the `MEASUREMENT_TYPES` const, and a second hardcoded `matches!`
  guard inside the `create_measurement` command. Both must include `"array"`. If a new
  measurement type is ever added, grep `lib.rs` for `matches!` and `MEASUREMENT_TYPES` to
  find every gate.

- **Trim ghost preview wasn't visible**: the committed array was still drawn at full opacity
  by the normal `drawOverlays` pass, so the dimmed/highlighted ghost preview drawn on top was
  imperceptible. Fix: while a trim is being drafted (two points placed, second point following
  the cursor), the active group's array measurements are filtered OUT of the `drawOverlays`
  call, and `drawArrayTrimPreview` takes exclusive control of rendering them (a 20%-alpha pass
  for the whole shape, then a 90%-alpha pass for the kept portion only).

- **Trim didn't affect the group quantity**: `deriveQuantity`'s array branch originally
  computed `(1 + extraMembers) * baselineLength`, ignoring `meta.trims` entirely. Fixed by
  `arrayTrimmedLengthPts()` in `quantity.ts`, which clips every member segment against all
  accumulated trims and sums only the surviving lengths.

- **Trim applied to the wrong side relative to the cursor**: the half-plane "keep" side is
  derived from a 2D cross-product sign test (`sideOfLine`/`_sideOfLine`). Because the canvas
  renders in screen space (Y-down) while measurement geometry is Y-up, the naive sign came out
  inverted from what the user saw on screen. Fixed by negating the keep-side sign
  (`-Math.sign(...)`) in both `clipSegmentToSide` (`ViewerCanvas.tsx`) and `_clipSegmentToTrim`
  (`quantity.ts`). **Both copies must stay in sync** — the trim math is duplicated between the
  canvas (for rendering) and quantity.ts (for the derived total).

- **Trim coordinates are baseline-relative (critical for move/edit safety)**: trims were
  initially stored as absolute page coordinates, with `commitMove` shifting them by the same
  (dx, dy) as the geometry. This only covered one move path — using the Select tool to drag the
  array could still separate it from its trim. Fixed by storing each `ArrayTrim`'s six fields
  relative to `pts[0]` at commit time (`commitArrayTrim` subtracts `pts[0]`), and converting
  back to absolute coordinates on the fly via `absTrims()` (`ViewerCanvas.tsx`) /
  `_absTrims()` (`quantity.ts`) wherever trims are used for hit-testing, drawing, or quantity.
  Because the offset is relative, **any** future code path that moves the baseline keeps the
  trim aligned automatically — no per-path bookkeeping required. Do not reintroduce
  absolute-coordinate trim storage or per-move trim-shifting code.

- **Resizing a trimmed array's baseline desyncs the trim**: even with relative trim storage,
  changing the *length/angle* of the baseline (not just translating it) moves the trim line's
  effective position relative to the members in a way that no longer matches what the user cut.
  Per the user's explicit instruction, this is **disallowed**: in `handlePointerDown`, vertex-drag
  (`vertexDragRef`) setup is blocked when the selected measurement is an array
  (`measurement_type === "array"`) with `parseArrayMeta(framing_json).trims.length > 0`. The
  array can still be selected and translated as a whole, just not resized, once it has any trim.

- **"Add point" context menu broke arrays**: adding a vertex to an array's baseline via the
  right-click "Add point" item produced a 3-point baseline, which the array drawing/quantity
  code doesn't support (it always reads `points[0]`/`points[1]`). Fixed by excluding
  `measurement_type === "array"` from the branch of the right-click menu builder that pushes
  "Add point". "Delete point" / whole-measurement delete are unaffected.