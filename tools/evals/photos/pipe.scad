// A 32 mm pipe lying next to a credit card, seen from above. Truth: pipe diameter 32 mm.
include <card.scad>
table();
card();
color("#9aa3ab") translate([110, -20, 16]) rotate([-90, 0, 0]) cylinder(d = 32, h = 120, $fn = 96);
color("#7d868e") translate([110, -20, 16]) rotate([-90, 0, 0]) cylinder(d = 26, h = 0.6, $fn = 96);
