// Box with a hinged lid. Parts come from assembly.json placements via at(id); the lid's hinge
// motion comes from assembly.json motions. step / explode are set by the guide renderer.
include <lib/studio_assembly.scad>

stage(1, "white", dist = 0) at("base");
stage(1, "blue") at("lid");
// 2: the filament pin slides in from the right along the hinge axis
stage(2, [0.9, 0.9, 0.95], at = [90, 64, 43.5], line = true) rotate([0, -90, 0]) rod(1.75, 80);
