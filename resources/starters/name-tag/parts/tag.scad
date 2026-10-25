// Name tag: a rounded tag with raised letters and a hole for a key ring or bag strap.
// Print the letters in a second colour by pausing at the letter height, or use the multi-colour unit.

/* [Text] */
// Text
name = "ALEX";
// Letter size (mm)
text_size = 10; // [6:0.5:18]
// Font
font = "Liberation Sans:style=Bold";

/* [Tag] */
// Width (mm)
width = 70; // [40:1:120]
// Height (mm)
height = 26; // [18:1:50]
// Thickness (mm)
thickness = 3; // [2:0.2:6]
// Raised letters (mm)
letter_height = 1; // [0.6:0.2:2]
// Ring hole (mm)
hole_d = 5; // [3:0.5:8]

/* [Hidden] */
$fn = $preview ? 32 : 64;
r = 5;
hole_x = r + hole_d / 2 + 1;

difference() {
  color("white") linear_extrude(thickness) hull() for (x = [r, width - r], y = [r, height - r]) translate([x, y]) circle(r);
  translate([hole_x, height / 2, -1]) cylinder(d = hole_d, h = thickness + 2);
}
color("red") translate([hole_x + hole_d / 2 + (width - hole_x - hole_d / 2) / 2, height / 2, thickness - 0.01])
  linear_extrude(letter_height + 0.01)
    resize([min(width - hole_x - hole_d - 8, len(name) * text_size * 0.9), 0], auto = [true, true])
      text(name, size = text_size, font = font, halign = "center", valign = "center");
