// Saucer for the plant pot: catches the water that drains through.

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 48 : 120;
d = pot_bottom_d + 2 * saucer_gap + 2 * 2;

difference() {
  cylinder(d1 = d, d2 = d + 6, h = saucer_h);
  translate([0, 0, 1.6]) cylinder(d1 = d - 4, d2 = d + 6 - 4, h = saucer_h);
}
