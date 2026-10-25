# Example: 3-part parts bin with a hinged lid (base, divider, lid + 4 magnets, 1 hinge pin, 4 feet)

Parts: `parts/base.scad` (magnet pockets in the front corner posts, divider ribs, two hinge knuckles behind the back wall),
`parts/lid.scad` (printed top-down; centre knuckle, magnet pockets, relief cuts so its corners clear the base knuckles),
`parts/divider.scad` (printed flat). `check_motion` caught a 0.04 mm rub between the lid knuckle and the back wall in the
first version; moving the hinge axis 0.5 mm further back fixed it (closest gap now 0.4 mm).

## assembly.scad
```openscad
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
```

## assembly.json
```json
{
  "title": "Parts bin with hinged lid",
  "summary": "A small two-compartment bin. The lid swings open on a steel pin and snaps shut on two pairs of magnets.",
  "timeMinutes": 10,
  "parts": [
    { "id": "base", "qty": 1, "color": "royalblue", "name": "Base" },
    { "id": "divider", "qty": 1, "color": "white", "name": "Divider" },
    { "id": "lid", "qty": 1, "color": "orange", "name": "Lid" }
  ],
  "hardware": [
    { "id": "magnet", "type": "magnet", "qty": 4, "material": "nickel-plated NdFeB",
      "magnet": { "shape": "disc", "diaMm": 6, "thicknessMm": 3, "grade": "N52" },
      "purchaseHint": "6x3mm N52 neodymium disc magnet", "notes": "Press fit in 6.2 mm pockets, 3.2 mm deep." },
    { "id": "pin", "type": "dowel-pin", "qty": 1, "size": "3x60", "standard": "ISO 2338", "material": "steel",
      "purchaseHint": "3mm x 60mm steel dowel pin", "notes": "Any 3 mm steel rod cut to 60 mm works." },
    { "id": "feet", "type": "rubber-foot", "qty": 4, "size": "10 x 3 mm", "name": "Self-adhesive rubber bumper 10 × 3 mm",
      "purchaseHint": "10 mm self adhesive rubber bumpers" }
  ],
  "tools": [],
  "consumables": [ { "id": "ca", "name": "Superglue (CA)", "qty": "a drop per magnet, only if loose", "purchaseHint": "superglue gel" } ],
  "placements": [
    { "part": "base", "translate": [0, 0, 0] },
    { "part": "divider", "translate": [-1, -19.75, 2], "rotate": [90, 0, 90] },
    { "part": "lid", "translate": [0, 0, 36], "rotate": [180, 0, 0] }
  ],
  "motions": [
    { "id": "lid", "label": "Lid opens", "type": "rotate", "parts": ["lid"], "axis": [-1, 0, 0], "origin": [0, 26, 32.5],
      "range": [0, 110], "rest": 0, "check": "Swings open to about 110° without rubbing and snaps shut on the magnets." }
  ],
  "steps": [
    { "n": 1, "title": "Press in the base magnets", "adds": ["base", { "id": "magnet", "qty": 2 }],
      "explodeDirection": [0, 0, 1], "explodeDistance": 25,
      "text": "Press one magnet into each front corner post.",
      "check": "Both magnets sit flush with the top of the posts.",
      "tips": ["If a magnet is loose, add a drop of superglue first."] },
    { "n": 2, "title": "Slide in the divider", "adds": ["divider"],
      "explodeDirection": [0, 0, 1], "explodeDistance": 40, "view": [55, 0, -35],
      "text": "Slide the divider down between the ribs, notch up.",
      "check": "The divider stands straight and does not wobble." },
    { "n": 3, "title": "Press in the lid magnets", "adds": ["lid", { "id": "magnet", "qty": 2 }],
      "explodeDirection": [0, 0, 1], "explodeDistance": 30,
      "text": "Press the other two magnets into the pockets under the lid.",
      "warnings": ["Test before pressing: each lid magnet must pull towards the base magnet below it. If it pushes away, flip it over."],
      "check": "Held over the base, the lid pulls down onto it." },
    { "n": 4, "title": "Fit the hinge pin", "adds": ["pin"],
      "explodeDirection": [1, 0, 0], "explodeDistance": 70, "view": [60, 0, 150],
      "text": "Line up the three hinge loops and push the pin through from the side.",
      "check": "The lid swings open and shut smoothly and the pin stays put.",
      "showMotion": "lid" },
    { "n": 5, "title": "Stick on the feet", "adds": ["feet"],
      "explodeDirection": [0, 0, -1], "explodeDistance": 16,
      "text": "Turn the bin over and stick a bumper near each corner.",
      "check": "The bin sits flat without rocking." }
  ]
}
```
