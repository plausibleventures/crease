// Cable clip: snaps one or more cables into a row of open rings. Stick it under a desk with
// double-sided tape, or screw it on.

/* [Cables] */
// Cable diameter (mm)
cable_d = 6; // [3:0.5:15]
// How many cables
count = 3; // [1:1:6]
// Opening (smaller grips tighter)
opening = 0.75; // [0.5:0.05:0.9]

/* [Clip] */
// Clip length (mm)
length = 12; // [6:1:30]
// Wall thickness (mm)
wall = 2; // [1.2:0.2:4]
// Screw hole
screw_hole = true;
// Screw size (mm)
screw_d = 3.5; // [2.5:0.1:5]

/* [Hidden] */
$fn = $preview ? 32 : 64;
pitch = cable_d + wall;
base_len = count * pitch + wall + (screw_hole ? screw_d * 3 : 0);
base_t = wall + 0.5;
x0 = (screw_hole ? screw_d * 3 : 0) + wall / 2 + pitch / 2;

module ring() {
  difference() {
    circle(d = cable_d + 2 * wall);
    circle(d = cable_d);
    translate([-cable_d * opening / 2, 0]) square([cable_d * opening, cable_d]);
  }
}

difference() {
  linear_extrude(length) {
    square([base_len, base_t]);
    for (i = [0 : count - 1]) translate([x0 + i * pitch, base_t + cable_d / 2]) ring();
  }
  if (screw_hole)
    translate([screw_d * 1.5, -1, length / 2]) rotate([-90, 0, 0]) {
      cylinder(d = screw_d, h = base_t + 2);
      translate([0, 0, base_t + 1 - screw_d * 0.6]) cylinder(d1 = screw_d, d2 = screw_d * 2.2, h = screw_d * 0.6 + 0.01);
    }
}
