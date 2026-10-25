// Hinged lid, printed top-face down. Centre hinge knuckle, 2 magnet pockets, locating lip.
/* [Size] */
length = 64; // [40:1:150]
width = 44;  // [30:1:120]
thickness = 4; // [3:0.2:6]
wall = 2;
/* [Hardware] */
magnet_d = 6.2;
magnet_depth = 3.2;
pin_clearance = 3.4; // free-turning on the 3 mm pin
/* [Hinge] */
knuckle_r = 3.5;
knuckle_half = 17.6; // knuckle spans -17.6..17.6 (0.4 mm gap to the base knuckles)
/* [Hidden] */
$fn = $preview ? 32 : 64;
r = 3;
boss_inset = 6;
gap = 0.25;
hinge_off = 4;       // hinge axis distance behind the lid's back edge
module rbox(l, w, h, r) hull() for (x = [-l/2 + r, l/2 - r], y = [-w/2 + r, w/2 - r]) translate([x, y, 0]) cylinder(r = r, h = h);
// Print coordinates: top face on z = 0, the hinge edge is -Y.
module lid() {
  difference() {
    union() {
      rbox(length, width, thickness, r);
      il = length - 2*wall - 2*gap; iw = width - 2*wall - 2*gap;
      for (y = [-1, 1]) translate([-20, y > 0 ? iw/2 - 1.2 : -iw/2, thickness - 0.01]) cube([40, 1.2, 2.01]);
      for (x = [-1, 1]) translate([x > 0 ? il/2 - 1.2 : -il/2, -10, thickness - 0.01]) cube([1.2, 20, 2.01]);
      hull() {
        translate([-knuckle_half, -width/2 - hinge_off, knuckle_r]) rotate([0, 90, 0]) cylinder(r = knuckle_r, h = 2 * knuckle_half);
        translate([-knuckle_half, -width/2 + 0.01 - 1, 0]) cube([2 * knuckle_half, 1, thickness]);
      }
    }
    translate([-knuckle_half - 1, -width/2 - hinge_off, knuckle_r]) rotate([0, 90, 0]) cylinder(d = pin_clearance, h = 2 * knuckle_half + 2);
    // relief so the lid's corners clear the base knuckles while it swings
    for (x = [-1, 1]) translate([x > 0 ? knuckle_half + 0.01 : -length/2 - 1, -width/2 - 1, -1]) cube([length/2 - knuckle_half + 1, 2, thickness + 2]);
    for (x = [-1, 1])
      translate([x * (length/2 - boss_inset), width/2 - boss_inset, thickness - magnet_depth]) cylinder(d = magnet_d, h = magnet_depth + 1);
  }
}
lid();
