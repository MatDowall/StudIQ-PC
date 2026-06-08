###workbook milestone 3.4 (carries on from workbook.md & milestones 3.1 - 3.3

##Formulae

-we will now implement formulae which can be used in cells to invoke mathmatical functions in the same way excel does.
-formula listed below match the excel counterpart in functionality. use the excel counterpart to inform what the formula does
-Formulas may be simple containing only operators or more complex containing functions or a combination of functions and operators. When a formula is complete, press ENTER to calculate a value for the cell and all dependent cells.
-accuracy of these formula is crccial, ensure thorough testing to ensure data quality

##supported operators

=
 
equals
 
Used as first character in a cell, denotes a formula
 

(  )
 
open bracket and close bracket
 
1.Changes the order in which statements in a formula are executed or override natural precedence of operators, e.g., the normal result of =3*5+4 is 19 whereas the result of =3*(5+4) is 27.

2.Identifies the parameters of a function call. e.g., IF(A1=0,0,1)
 

+
 
plus

Addition (e.g., 2+4 or G1+10)
 

-
 
minus

1.Subtraction (e.g., 4-2 or G12-33)

2.Also denotes negative numbers/cells
 

*
 
multiply
 
Multiplication (e.g., 4*6 or C1*F1)
 

/
 
divide

Division (e.g., 9/3 or G11/F11)
 

^
 
power

Exponential (e.g., 2^5 or B2^B3)
 

%
 
percent

Percentage (e.g., A1*10%)
 

=
 
equals

Is equal to (e.g., B1=B2 )
 

>
 
greater than

Is greater than (e.g., B1>B2 )
 

<
 
less than

Is less than (e.g., G1<F2 )
 

>=
 
greater than or equal to

Is greater than or equal to (e.g., B1>=B2 )
 

<=
 
less than or equal to

Is less than or equal to (e.g., G1<=F2 )
 

<>
 
not equal to

Is not equal to (e.g., B1<>C2 )
 

&
 
and

Concatenation (joining strings) (e.g., "$"&B2)
 

"
 
double quotes
 
Denotes the bounds of a string in a formula or function (e.g., "Yes")
 

:
 
colon

Denotes a cell range (e.g., from A1 to B5 would be A1:B5)
 


##basic mathmatic arithmetic
examples:
=5+5
=(4*4)+18
=-3+7

##references to other cells
examples:
=B5

##formulae to be used

Sum
product
ceiling
floor
pi
roundup
rounddown
cos
countif
average
count
min
max


##error values

If an invalid number of parameters are given to a function, or the result is too big to be displayed, the result in the cell becomes #VALUE!. If the formula is evaluated and found to contain a division by zero, the cell becomes #DIV/0!. If a formula would be referencing a non existent cell, the cell becomes #REF!.

##document

provide tooltip helpers fro functions as excel does, if the user starts to type a known function, provide autocomplete and a syntax hint.

##future expanion. 
more formulae maay be added in the future, ensure hanover document provides details on how this can be done.