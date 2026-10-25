// Parts bin assembly. Parts come from assembly.json placements via at(id); the lid's hinge motion
// (motion_lid, 0..1) comes from assembly.json motions. step / explode are set by the guide renderer.
include <lib/studio_assembly.scad>

H = 32;                       // base height
HINGE = [0, 26, 32.5];        // hinge axis point (matches motions[lid].origin)
FRONT = [for (x = [-26, 26]) [x, -16]];

// Step 5 turns the bin over to fit the feet: flip the model for that step only.
rotate(step == 5 ? [180, 0, 0] : [0, 0, 0]) {
  // 1: base (stays put) + 2 magnets in the front posts
  stage(1, "royalblue", dist = 0) at("base");
  for (p = FRONT) stage(1, STEEL, at = [p[0], p[1], H], line = true) magnet(6, 3);

  // 2: divider slides down between the ribs
  stage(2, "white") at("divider");

  // 3: lid (at() already applies the lid motion) + its 2 magnets (hardware: wrap in moving() to ride along)
  stage(3, "orange") at("lid");
  moving("lid") for (p = FRONT) stage(3, STEEL, at = [p[0], p[1], H], dist = 0.55) mirror([0, 0, 1]) magnet(6, 3);

  // 4: hinge pin slides in from the right
  stage(4, STEEL, at = [-30, HINGE[1], HINGE[2]], line = true) rotate([0, 90, 0]) rod(3, 60);

  // 5: rubber feet under the base
  for (x = [-24, 24], y = [-14, 14]) stage(5, RUBBER, at = [x, y, 0], line = true) mirror([0, 0, 1]) scale([1, 1, 0.3]) sphere(d = 10, $fn = 32);
}
