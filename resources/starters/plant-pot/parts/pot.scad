// Plant pot: gently tapered, with drainage holes and small feet so water can run out into the saucer.

/* [Pot] */
// Drainage holes
holes = 5; // [0:1:9]
// Hole size (mm)
hole_d = 6; // [3:0.5:10]
// Ribs
ribs = true;
// Rib count
rib_count = 24; // [8:1:48]

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 48 : 120;
feet_h = 2;

difference() {
  union() {
    translate([0, 0, feet_h]) cylinder(d1 = pot_bottom_d, d2 = pot_top_d, h = pot_h - feet_h);
    // three feet keep the holes off the saucer floor
    for (a = [0 : 120 : 359]) rotate(a) translate([pot_bottom_d * 0.3, 0, 0]) cylinder(d = 10, h = feet_h + 0.01);
    if (ribs)
      for (i = [0 : rib_count - 1]) rotate(i * 360 / rib_count)
        hull() {
          translate([pot_bottom_d / 2 - 0.6, 0, feet_h + 4]) cylinder(d = 2.4, h = 0.01, $fn = 12);
          translate([pot_top_d / 2 - 0.6, 0, pot_h - 6]) cylinder(d = 2.4, h = 0.01, $fn = 12);
        }
  }
  // hollow
  translate([0, 0, feet_h + 2.4]) cylinder(d1 = pot_bottom_d - 2 * pot_wall, d2 = pot_top_d - 2 * pot_wall, h = pot_h);
  // drainage holes
  if (holes > 0) {
    cylinder(d = hole_d, h = 20, center = true);
    for (i = [1 : holes - 1]) rotate(i * 360 / max(1, holes - 1)) translate([pot_bottom_d * 0.22, 0, 0]) cylinder(d = hole_d, h = 20, center = true);
  }
}
