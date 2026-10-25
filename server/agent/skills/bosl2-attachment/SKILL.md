---
name: bosl2-attachment
title: BOSL2 Attachment System
description: Understand key concepts behind BOSL2's attachable/anchor system, including how to position parts reliably on faces, edges, and corners.
---
# BOSL2 Attachment System Skill

## Purpose
Teach how BOSL2's attachable/anchor system works so parts are positioned reliably on faces, edges, and corners.


[BOSL2 is an OpenSCAD library](https://github.com/BelfrySCAD/BOSL2) that provides a collection of modules for creating complex geometries, including an attachment system for positioning parts. This skill focuses on understanding the core concepts of BOSL2's attachment system, including anchors, attachable parents/children, orientation control, and common pitfalls.

## Crease notes
- BOSL2 is bundled with Crease (pinned release on OpenSCAD's library path): `include <BOSL2/std.scad>` works in every part. If `render_part` ever reports the include can't be found, tell the user and fall back to plain OpenSCAD (`translate`/`rotate`/`difference`).
- Never shell out to `openscad`. Verify every change with the Crease MCP tools: `render_part`, then `check_part`.
- One printable part per file in `parts/<id>.scad`; keep key dimensions as Customizer parameters at the top (`/* [Group] */`, `x = 10; // [min:step:max]`) and pass them into BOSL2 calls rather than hard-coding numbers.
- `isogrid_rect()` in the "Orientation-first placement" example below is **not** a BOSL2 module; it stands in for any user module that accepts `anchor`/`spin`/`orient`.

## Core Concepts

### 1) Anchors
BOSL2 uses named directions as anchors:
- Faces: `TOP`, `BOTTOM`, `LEFT`, `RIGHT`, `FWD`, `BACK`
- Edges/corners: combine directions with `+`, e.g. `TOP+RIGHT`, `TOP+FWD+RIGHT`

Important:
- `TOP+RIGHT` is one edge anchor (single combined anchor)
- `[TOP, RIGHT]` is an array of two separate anchors (used when a function accepts multiple anchors)

Examples:
- `attach(RIGHT)` = attach on right face
- `attach(TOP+FWD+RIGHT)` = top-front-right corner

### 2) Attachable Parent + Child
Attaching works when the parent is attachable (e.g., `cuboid()` from BOSL2).
Inside a block, each `attach()` is anchored to the parent:

```openscad
cuboid([50,15,25]) {
    attach(RIGHT) sphere(d=5);
    attach(LEFT)  sphere(d=5);
}
```

### 3) Chaining Pitfall
This chains to the previous child, not back to parent:

```openscad
cuboid([50,15,25])
    attach(RIGHT) thing1()
    attach(LEFT)  thing2();   // often attaches to thing1 context
```

Use block form to avoid this:

```openscad
cuboid([50,15,25]) {
    attach(RIGHT) thing1();
    attach(LEFT)  thing2();
}
```

### 4) Orientation: `attach(parent, child, spin=...)`
`attach()` controls both placement and rotation.

For predictable orientation, prefer the two-anchor form:

```openscad
attach(parent_anchor, child_anchor, spin=...)
```

Examples:
- `attach(TOP, BOTTOM)` -> put child's bottom onto parent's top
- `attach(RIGHT, BOTTOM)` -> put child's bottom onto parent's right face

Notes:
- Attaching to `TOP`/`BOTTOM` generally preserves the child's back direction.
- Attaching to side faces (`LEFT`/`RIGHT`/`FWD`/`BACK`) often needs `spin=` to get desired roll/twist.
- `spin=` in `attach()` rotates around the attachment vector.

Example with explicit face-to-face and spin:

```openscad
cuboid([60,20,20]) {
    attach(TOP, BOTTOM) cylinder(d=10, h=8);
    attach(RIGHT, BOTTOM, spin=90) prismoid([12,8],[8,8],h=6);
}
```

### 5) Single-arg `attach()` and child `anchor`/`orient`
Single-argument attach respects the child's own `anchor=` and `orient=`:

```openscad
cuboid([50,15,25])
    attach(TOP)
        cyl(h=8, d=10, anchor=BOTTOM, orient=UP);
```

Use this when the child module already exposes good anchor/orient controls.

### 6) `diff()` + Attach
`diff()` subtracts attached geometry from parent when used in BOSL2 style:

```openscad
diff()
cuboid([50,15,25]) {
    attach(RIGHT) cutter_shape();
}
```

## Practical Patterns

### Opposite-face features
```openscad
cuboid([50,15,25]) {
    attach(RIGHT) feature_a();
    attach(LEFT)  feature_b();
}
```

### Corner placement
```openscad
cuboid([50,15,25]) {
    attach(TOP+FWD+RIGHT) feature();
}
```

### Orientation-first placement
```openscad
cuboid([200,150,12], anchor=CENTER)
    attach(TOP, spin=90)
        isogrid_rect(200,150, triangle_size=20, thickness=1.5, extrude=1);
```

## Troubleshooting
- Feature appears on wrong side -> check anchor (`FWD` vs `BACK`, `LEFT` vs `RIGHT`)
- Second feature attaches to first feature -> use `{ ... }` block on parent
- Rotation unexpected -> use two-anchor form (`attach(parent, child)`) and add `spin=`
- Child points the wrong way with single-arg attach -> set child `anchor=`/`orient=` explicitly
- Nothing happens -> verify included BOSL2 modules and object is attachable
