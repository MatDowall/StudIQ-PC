###Milestone M3 - Wookbook Spreadsheet Specifacation

complete all milestones in order one by one, do not move on until gate pass verified by user.
do not attempt auto verifacation of app, request user to verify and report back.

#Milestone 3.1: Spreadsheet
- must be a pre built library which can be incorporated into the application.
- must support the standard excel columns and rows workflow
- columns and rows can be resized with the same mechanics as Excel
- navigation with arrow keys, scroll wheel vertical & horizontal
- columns A, B, C, D etc
- rows 1, 2, 3, 4 etc
- Special labelling on the following columns:
	-A:Code
	-B:Description
	-C:Quantity
	-D:Unit
	-E:Rate
	-F:Subtotal
	-G:Factor
	-H:Total
	-I:lab
	-J:Lab - Total
	-K:Mat
	-L:Mat - Total
	-M:Sub
	-N:Sub - Total 
	-O:Sum
	-P:Sum - Total
- for the overall layout, please see docs/workbook - level 1 layout.png *do not place any of the cell values in the spreadsheet - this is for reference only*
	
milestone gate: spreadsheet library sucessfully loads on the workbook tab, cells can be scrolled, navigated, resized and text can be entered and persists - all without any bugs or performance issues.

#Milestone 3.2: page layout

in the reference image docs/workbook - level 1 layout.png i have highlighted 3 key areas:
	- red - the main workbook area, this will be the full size of the area currently stubbed in the wrokbook tab
	- green - the spreadsheet area made up of cells / rows / columns. has vertical & horizontal scroll.
	- blue - top toolbar. different layout her per level.
		- docs/level 1 layout.png notes the layout for the first workbook level:
			-from left to right: first box has the current active cell, next is what would be the equivelent in excel to the formula bar, next is the total. this will eventually populate with a named cell which is the project total (future milestone)
		- docs/level 2 layout.png notes the layout for the second workbook level:
			-left to right on the first row is the same as the level 1 toolbar
			-left to right on the row below that: arrow is button to return back up 1 level. code is the value from A:Code on level 1 relative to the takeoff the user is in, description is the current takeoff sheet inherited from the B:description of the same row the user clicked F:Subtotal to get to the current takeoff sheet, Quantity, Unit & rate boxes, leave these as blank until future milestone. sub-total is the total of all values in H:Total of the current sheet, factor is the margin, which will be the value of a named cell (future milestone, place 1.1000 for now as dummy. Total is Sub-Total multiplied by Factor
		- docs/level 3 layout.png notes the layout for the third workbook level
			-left to right on the first row is the same as the level 1&2 toolbar
			-left to right on the second row is the same as the level 1&2 toolbar
			-left to right on the third row is the summary of the row which was drilled down into, first the arrow button which returns back 1 level. Description, quantity, unit, rate, sub-total, factor & total are pulled from the parent row currently drilled down into. 

Milestone gate: user verifies layout follows reference photos, cells in toolbar populate as described		
	
#Milestone 3.3: drill down mechanics
-Costx has the ability to create nested subsheets which can be drilled down into.
	level 1: the trade summary sheet (see docs/level 1 layout.png for reference screenshot of CostX)
		- top level of the worksheet, this has the summary of all the takeoff sheets in behind
		- column F:Subtotal can be double clicked which enters the next level down, this is the Takeoff of the trade as labelled in column B:Description
			level 2: this is the takeoff sheet for the trade. (see docs/level 2 layout.png for reference screenshot of CostX)
				- special column labelling from columns A-P is the same as level 1.
				- column E:Rate can be double clicked, this drills down to level 3, the rate breakdown sheet for that row of the takeoff.
					level 3: (see docs/level 3 layout.png for reference screenshot of CostX)
						- rate buildup sheet where labour consstant, material rate, sub rate are built up
				

milestone gate: navigation down into a subsheet and back out with arrows works as described. 