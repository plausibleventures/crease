// Desk organiser: a tray split into compartments for pens, clips, cards and odds and ends.

/* [Size] */
// Width (mm)
width = 160; // [80:5:240]
// Depth (mm)
depth = 100; // [60:5:200]
// Height (mm)
height = 45; // [20:1:100]

/* [Compartments] */
// Columns
columns = 3; // [1:1:6]
// Rows
rows = 2; // [1:1:4]
// Pen cup
pen_cup = true;
// Pen cup height (mm)
pen_cup_height = 90; // [50:5:140]

/* [Walls] */
// Wall thickness (mm)
wall = 2; // [1.2:0.2:4]
// Divider thickness (mm)
divider = 1.6; // [1.2:0.2:3]
// Corner radius (mm)
corner = 6; // [1:1:15]
// Floor thickness (mm)
floor_t = 1.6; // [1:0.2:3]

/* [Hidden] */
$fn = $preview ? 32 : 64;
cw = (width - 2 * wall) / columns;
rd = (depth - 2 * wall) / rows;

module rr(w, d, r) hull() for (x = [r, w - r], y = [r, d - r]) translate([x, y]) circle(r);

difference() {
  union() {
    linear_extrude(height) rr(width, depth, corner);
    if (pen_cup)
      translate([0, depth - rd - wall, 0]) linear_extrude(pen_cup_height) rr(cw + 2 * wall, rd + 2 * wall, min(corner, (cw + 2 * wall) / 2 - 0.1));
  }
  // compartments
  for (c = [0 : columns - 1], r = [0 : rows - 1]) {
    tall = pen_cup && c == 0 && r == rows - 1;
    translate([wall + c * cw + (c > 0 ? divider / 2 : 0), wall + r * rd + (r > 0 ? divider / 2 : 0), floor_t])
      linear_extrude((tall ? pen_cup_height : height) + 1)
        rr(cw - (c > 0 ? divider / 2 : 0) - (c < columns - 1 ? divider / 2 : 0),
           rd - (r > 0 ? divider / 2 : 0) - (r < rows - 1 ? divider / 2 : 0),
           max(0.5, min(corner - wall, 3)));
  }
}
