// Shared sizes for the box and its lid (both parts include this file).
/* [Box] */
// Width (mm)
box_w = 80; // [40:1:200]
// Depth (mm)
box_d = 60; // [30:1:200]
// Height without the lid (mm)
box_h = 40; // [15:1:150]
// Wall thickness (mm)
wall = 2; // [1.2:0.2:4]
// Corner radius (mm)
corner = 4; // [1:0.5:10]
// Lid thickness (mm)
lid_t = 2.4; // [1.6:0.2:4]

/* [Hinge] */
// Hinge loop radius (mm)
knuckle_r = 3.5; // [2.5:0.5:6]
// Filament pin hole (mm)
pin_d = 2.0; // [1.8:0.1:2.4]
// Gap between loops (mm)
gap = 0.4; // [0.2:0.05:0.8]
// Lid swing room (mm)
swing_gap = 0.5; // [0.3:0.1:1.5]

/* [Hidden] */
// hinge axis: just behind the back wall (plus swing_gap), a loop radius above the rim
hinge_y = box_d + swing_gap + knuckle_r;
hinge_z = box_h + knuckle_r;
k_len = (box_w - 2 * corner) / 3; // length of each hinge loop

module rounded_rect(w, d, r) {
  hull() for (x = [r, w - r], y = [r, d - r]) translate([x, y]) circle(r);
}
