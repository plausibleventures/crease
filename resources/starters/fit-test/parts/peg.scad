// Fit test peg: a 10 mm square peg with a grip on top. Push it into each square hole of the coupon.

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 32 : 64;

// grip (printed on the bed), then the peg standing up from it; a small chamfer helps it start
cube([peg + 6, peg + 6, 3]);
translate([3, 3, 3]) hull() {
  cube([peg, peg, 12 - 0.6]);
  translate([0.4, 0.4, 0]) cube([peg - 0.8, peg - 0.8, 12]);
}
