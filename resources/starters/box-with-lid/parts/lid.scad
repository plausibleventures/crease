// Box with a hinged lid: the lid. Printed flat; its two outer hinge loops line up with the box's
// middle loop. A small lip on the underside keeps it closed and centred.

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 32 : 64;

difference() {
  union() {
    linear_extrude(lid_t) rounded_rect(box_w, box_d, corner);
    // two outer hinge loops
    for (x0 = [corner, corner + 2 * k_len + gap])
      translate([x0, 0, 0]) hull() {
        translate([0, box_d - 2, 0]) cube([k_len - gap, 2, lid_t]);
        translate([0, hinge_y, knuckle_r]) rotate([0, 90, 0]) cylinder(r = knuckle_r, h = k_len - gap);
        translate([0, hinge_y - knuckle_r, 0]) cube([k_len - gap, 2 * knuckle_r, 0.01]);
      }
    // finger tab at the front
    translate([box_w / 2 - 10, -5, 0]) cube([20, 6, lid_t]);
  }
  translate([-1, hinge_y, knuckle_r]) rotate([0, 90, 0]) cylinder(d = pin_d, h = box_w + 2);
  // notch behind the box's middle hinge loop so the lid can swing open past it
  translate([corner + k_len - gap, box_d - 5, -1]) cube([k_len + 2 * gap, 20, 20]);
}
