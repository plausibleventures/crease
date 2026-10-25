// Shared props for eval photos: an ISO ID-1 card (85.6 x 53.98 mm) and a wooden table top.
module card() {
  color("#1f4fa8") linear_extrude(0.76) offset(r = 3) offset(delta = -3) square([85.6, 53.98]);
  color("#111") translate([0, 38, 0.77]) cube([85.6, 8, 0.05]);
  color("#e8c547") translate([10, 18, 0.77]) cube([12, 9, 0.05]);
  color("white") translate([40, 10, 0.77]) linear_extrude(0.05) text("BANK", size = 7);
}
module table(w = 260, d = 180) { color("#c9a27a") translate([-20, -40, -2]) cube([w, d, 2]); }
