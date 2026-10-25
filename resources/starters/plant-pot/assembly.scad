// Plant pot with saucer. Parts come from assembly.json placements via at(id).
include <lib/studio_assembly.scad>

stage(1, "white", dist = 0) at("saucer");
stage(1, [0.85, 0.45, 0.3]) at("pot");
