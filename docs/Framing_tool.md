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

#Implementation Plan#

- plan only at this stage, do not make any code changes until I approve milestones and plan
- framing must follow NZ framing principles as outlined in NZS:3604. DO NOT default or drift to international framing methods or nomeclature.
- review project documentation for feature Implementation guidelines.
- consider the best place to have milestones for this project and thier gates. 
- thouroughly document the process.
- we need to visually check that quantity makeup is correct, devise a way to report quantity makeup of walls durirg testing / development so i can verify that the logic is sound.