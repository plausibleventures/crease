// Box with a hinged lid: the box. The lid's two hinge loops sit either side of this middle loop;
// a 1.75 mm filament offcut is the hinge pin.

/* [Hidden] */
include <../lib/params.scad>
$fn = $preview ? 32 : 64;

difference() {
  union() {
    linear_extrude(box_h) rounded_rect(box_w, box_d, corner);
    // middle hinge loop on a bracket behind the back wall
    translate([corner + k_len + gap, 0, 0]) {
      // bracket: below the rim it joins the back wall; above the rim it stays clear of the lid (gap)
      translate([0, box_d - 1, box_h - knuckle_r]) cube([k_len - 2 * gap, hinge_y - box_d + 1, knuckle_r]);
      translate([0, box_d + gap, box_h - 0.01]) cube([k_len - 2 * gap, hinge_y - box_d - gap, knuckle_r + 0.01]);
      translate([0, hinge_y, hinge_z]) rotate([0, 90, 0]) cylinder(r = knuckle_r, h = k_len - 2 * gap);
      // gusset under the loop so it prints without supports
      hull() {
        translate([0, box_d - 1, box_h - knuckle_r - 8]) cube([k_len - 2 * gap, 1, 1]);
        translate([0, box_d - 1, box_h - knuckle_r]) cube([k_len - 2 * gap, hinge_y - box_d + 1, 0.01]);
      }
    }
  }
  // hollow inside
  translate([0, 0, wall]) linear_extrude(box_h) offset(-wall) rounded_rect(box_w, box_d, corner);
  // pin hole
  translate([-1, hinge_y, hinge_z]) rotate([0, 90, 0]) cylinder(d = pin_d, h = box_w + 2);
}
