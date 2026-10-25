---
name: bosl2-joiners
description: Learn how to create mating tab/socket geometry using BOSL2 joiners and attach them to specific faces or corners.
---
# BOSL2 Joiners Skill
## Purpose
Explain how to create mating tab/socket geometry using BOSL2 joiners and attach them to specific faces or corners.

[BOSL2 is an OpenSCAD library](https://github.com/BelfrySCAD/BOSL2) that provides a collection of modules for creating complex geometries, including joiners for connecting parts. This skill focuses on using the `half_joiner` and `half_joiner2` modules to create mating features on parts.

## Crease notes
- BOSL2 is bundled with Crease (pinned release on OpenSCAD's library path): `include <BOSL2/std.scad>` works in every part. If `render_part` ever reports the include can't be found, tell the user and fall back to plain OpenSCAD (`translate`/`rotate`/`difference`).
- Never shell out to `openscad`. Verify every change with the Crease MCP tools: `render_part`, then `check_part`.
- One printable part per file in `parts/<id>.scad`; keep key dimensions as Customizer parameters at the top (`/* [Group] */`, `x = 10; // [min:step:max]`) and pass them into BOSL2 calls rather than hard-coding numbers.
- Joiners also need `include <BOSL2/joiners.scad>` (after `std.scad`).
- Both joiner halves may carry geometry tagged for removal (screw holes / clearance), so wrap the parent of **either** half in `diff()`; `diff()` is harmless when nothing is tagged. Confirm the screw hole actually appears with `render_part`.
- Part A and Part B are separate printable parts: put each in its own `parts/<id>.scad` file (the two-blocks example below shows both in one file only for illustration).
- Joiners are the main tool here for splitting a part that is too big for the SPARKX i7 bed into pieces that clip/screw together.


## Core Joiner Modules

- `half_joiner(...)`   -> one half of the joiner pair (typically tab/protrusion workflow)
- `half_joiner2(...)`  -> complementary half (typically socket/cut workflow)

> Exact fit depends on orientation and subtraction strategy (`diff()`).

## Typical Pairing Strategy

### Male/Female pair
- On part A: subtract `half_joiner2()` with `diff()` to create socket
- On part B: add `half_joiner()` to create mating tab

## Example: Two mating blocks

```openscad
include <BOSL2/std.scad>
include <BOSL2/joiners.scad>

// Part A: female socket on RIGHT face
diff()
cuboid([50,15,25]) {
    attach(RIGHT) half_joiner2(screwsize=2);
}

// Part B: male tab on LEFT face
translate([70,0,0])
cuboid([50,15,25]) {
    attach(LEFT) half_joiner(screwsize=2);
}
```

## Corner-style behavior (without corner-specific module)
Create corner behavior by placing joiners on 2+ perpendicular faces:

```openscad
diff()
cuboid([50,15,25]) {
    attach(RIGHT) half_joiner2(screwsize=2);
    attach(FWD)   half_joiner2(screwsize=2);
}
```

Mating part uses `half_joiner()` on opposite faces (`LEFT`, `BACK`).

## Placement Rules
- Use parent block form so each attach is anchored to cuboid:
```openscad
cuboid([50,15,25]) {
    attach(RIGHT) half_joiner(...);
    attach(LEFT)  half_joiner2(...);
}
```
- For short-end faces on a `[length,width,height]` cuboid:
  - If short side is width (`15`), ends are usually `FWD`/`BACK` (depending on orientation)
  - Verify visually and swap anchors if mirrored

## Common Errors
- `Ignoring unknown module 'corner_joiner2'`:
  - Module not available in your BOSL2 version
  - Use combinations of `half_joiner`/`half_joiner2` on multiple faces instead
- Joiner on wrong side:
  - Swap `LEFT/RIGHT` or `FWD/BACK`
- Joiner appears attached to another joiner:
  - Use block form `{ ... }` on the parent attachable
