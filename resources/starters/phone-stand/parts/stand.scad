// Phone stand: leans the phone back at a comfortable angle, with a slot for the charging cable.
// Printed on its side? No: printed as shown, base flat on the bed.

/* [Size] */
// Width (mm)
width = 70; // [50:1:120]
// Base depth (mm)
depth = 85; // [60:1:130]
// Lean angle (°)
angle = 65; // [50:1:80]
// Back rest length (mm)
rest_len = 95; // [60:1:140]

/* [Phone] */
// Phone with case (mm)
phone_thickness = 12; // [7:0.5:20]
// Front lip (mm)
lip_height = 12; // [6:1:25]
// Cable slot (0 = none)
cable_slot = 14; // [0:1:24]

/* [Strength] */
// Wall thickness (mm)
thickness = 4; // [3:0.5:8]

/* [Hidden] */
$fn = $preview ? 24 : 48;
s = thickness + phone_thickness; // where the back rest starts

module profile() {
  // base
  square([depth, thickness]);
  // front lip
  square([thickness, lip_height]);
  // back rest
  translate([s, 0]) rotate(angle) translate([0, -thickness]) square([rest_len, thickness]);
  // brace from the back of the base up to the back rest
  hull() {
    translate([depth - thickness, 0]) square([thickness, thickness]);
    translate([s + 0.55 * rest_len * cos(angle), 0.55 * rest_len * sin(angle) - thickness]) square([thickness, thickness]);
  }
}

difference() {
  // clip to the desk plane: the tilted back rest would otherwise dip below the base
  rotate([90, 0, 90]) linear_extrude(width) intersection() {
    profile();
    translate([-1, 0]) square([depth + rest_len + 2, rest_len + lip_height + 2]);
  }
  // cable slot through the lip and the front of the base
  if (cable_slot > 0)
    translate([(width - cable_slot) / 2, -1, -1]) cube([cable_slot, s + 1, thickness + lip_height + 2]);
}
