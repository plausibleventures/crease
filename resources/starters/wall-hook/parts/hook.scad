// Wall hook: screws to the wall; the hook curls up at the tip so bags, keys or headphones stay on.
// Printed lying on its side for strength along the hook.

/* [Size] */
// Width (mm)
width = 18; // [10:1:40]
// Plate height (mm)
plate_height = 70; // [40:1:120]
// Reach (mm)
reach = 45; // [20:1:90]
// Tip height (mm)
tip = 14; // [6:1:30]

/* [Strength] */
// Thickness (mm)
thickness = 6; // [4:0.5:10]

/* [Screws] */
// Screw size (mm)
screw_d = 4; // [3:0.1:6]
// Screw head (mm)
head_d = 8; // [6:0.5:12]

/* [Hidden] */
$fn = $preview ? 32 : 64;
r = thickness / 2;

module profile() {
  // wall plate
  hull() {
    translate([r, r]) circle(r);
    translate([r, plate_height - r]) circle(r);
  }
  // arm out from the bottom
  hull() {
    translate([r, r]) circle(r);
    translate([reach - r, r]) circle(r);
  }
  // upturned tip
  hull() {
    translate([reach - r, r]) circle(r);
    translate([reach - r, tip]) circle(r);
  }
}

difference() {
  linear_extrude(width) profile();
  // two countersunk screw holes through the plate (wall side at x = 0)
  for (z = [plate_height * 0.45, plate_height * 0.82])
    translate([-1, z, width / 2]) rotate([0, 90, 0]) {
      cylinder(d = screw_d, h = thickness + 2);
      translate([0, 0, thickness + 1 - (head_d - screw_d) / 2]) cylinder(d1 = screw_d, d2 = head_d, h = (head_d - screw_d) / 2 + 0.01);
    }
}
