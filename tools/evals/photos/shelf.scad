// The front edge of an 18 mm shelf board next to a credit card, seen straight on. Truth: shelf thickness 18 mm.
include <card.scad>
table(260, 180);
card();
color("#e9e4da") translate([110, 0, 0]) cube([120, 18, 1]);          // shelf edge face (18 mm tall in the photo plane)
color("#d6cfc0") translate([110, 18, 0]) cube([120, 30, 0.5]);        // shelf top receding
color("#bdb5a5") translate([110, -2, 0]) cube([120, 2, 0.6]);          // shadow line under the edge
