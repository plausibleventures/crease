// Fit test coupon: four square holes with 0.1 to 0.4 mm clearance for the 10 mm peg, and a row of
// round holes from 2.8 to 3.6 mm for an M3 screw. Each hole is labelled. Print it, then try the peg
// and a screw in each hole and tell Crease which fit best.

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 32 : 64;
pitch = 18;
w = 4 * pitch + 6;
d = 52;
font = "Liberation Sans:style=Bold";

module label(t, size = 4) linear_extrude(1.01) text(t, size = size, font = font, halign = "center", valign = "center");

difference() {
  linear_extrude(plate_t) hull() for (x = [3, w - 3], y = [3, d - 3]) translate([x, y]) circle(3);
  // square holes for the peg + their clearance labels
  for (i = [0 : 3]) {
    c = clearances[i];
    s = peg + 2 * c;
    translate([6 + pitch / 2 + i * pitch - s / 2 - 3, 30 - s / 2, -1]) cube([s, s, plate_t + 2]);
    translate([6 + pitch / 2 + i * pitch - 3, 44, plate_t - 1]) label(str(c));
  }
  // round holes for an M3 screw + their size labels
  for (i = [0 : len(m3_holes) - 1]) {
    x = 9 + i * (w - 18) / (len(m3_holes) - 1);
    translate([x, 14, -1]) cylinder(d = m3_holes[i], h = plate_t + 2);
    translate([x, 5.5, plate_t - 1]) label(str(m3_holes[i]), 3.2);
  }
}
