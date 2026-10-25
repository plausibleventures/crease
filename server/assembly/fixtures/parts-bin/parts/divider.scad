// Divider, printed flat. Slides between the guide ribs in the base.
/* [Size] */
span = 39.5;     // [20:0.1:120] inner width minus clearance
height = 26;     // [10:1:80]
thickness = 2;   // [1.2:0.1:4]
/* [Hidden] */
$fn = $preview ? 32 : 64;
module divider() {
  difference() {
    cube([span, height, thickness]);
    translate([span/2, height + 4, -1]) cylinder(r = 9, h = thickness + 2);
  }
}
divider();
