// Parts bin base: 2 magnet pockets in the front corner posts, divider ribs, 2 hinge knuckles at the back.
/* [Size] */
length = 64; // [40:1:150]
width = 44;  // [30:1:120]
height = 32; // [15:1:80]
wall = 2;    // [1.2:0.1:4]
/* [Hardware] */
magnet_d = 6.2;      // 6 x 3 mm disc magnet + 0.2 press fit
magnet_depth = 3.2;
pin_hole = 3.0;      // 3 mm steel pin: printed hole shrinks to a press fit
/* [Hinge] */
knuckle_r = 3.5;
hinge_y = 26;        // hinge axis, behind the back wall
hinge_z = 32.5;
/* [Hidden] */
$fn = $preview ? 32 : 64;
r = 3;
boss_inset = 6;
boss_d = 8.5;

module rbox(l, w, h, r) hull() for (x = [-l/2 + r, l/2 - r], y = [-w/2 + r, w/2 - r]) translate([x, y, 0]) cylinder(r = r, h = h);

module knuckle(x0, x1) {
  difference() {
    hull() {
      translate([x0, hinge_y, hinge_z]) rotate([0, 90, 0]) cylinder(r = knuckle_r, h = x1 - x0);
      translate([x0, width/2 - 0.01, 20]) cube([x1 - x0, 1, hinge_z - 20]);
    }
    translate([x0 - 1, hinge_y, hinge_z]) rotate([0, 90, 0]) cylinder(d = pin_hole, h = x1 - x0 + 2);
  }
}

module base() {
  difference() {
    union() {
      difference() {
        rbox(length, width, height, r);
        translate([0, 0, wall]) rbox(length - 2*wall, width - 2*wall, height, r - wall/2);
      }
      for (x = [-1, 1], y = [-1, 1])
        translate([x * (length/2 - boss_inset), y * (width/2 - boss_inset), 0]) cylinder(d = boss_d, h = height);
      for (y = [-1, 1], dx = [-1, 1])
        translate([dx * 1.95 - 0.75, y * (width/2 - wall) - (y > 0 ? 1.5 : 0) - 0.01 * y, 0]) cube([1.5, 1.5 + 0.01, height - 3]);
      knuckle(-30, -18);
      knuckle(18, 30);
    }
    for (x = [-1, 1])
      translate([x * (length/2 - boss_inset), -(width/2 - boss_inset), height - magnet_depth]) cylinder(d = magnet_d, h = magnet_depth + 1);
  }
}
base();
