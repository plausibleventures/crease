# FDM failure modes: symptom, cause, remedy, routing

Classification drives routing. **design_time** = preventable by geometry before slicing (route
to generation). **process** = slicer/printer/material setting (route to the printing agent).
**mixed** = check the design *and* recommend a setting.

| Failure | Class | Visual sign | Geometric cause | Process cause | Design fix | Process fix |
|---|---|---|---|---|---|---|
| Warping | mixed | Corners lift, gap under base | Large flat footprint, sharp 90° corners | Bed temp, no enclosure, draft | Mouse-ears, round corners, split | Bed temp, brim, enclosure |
| Stringing | mixed | Hairy strands between features | Many travel moves over gaps; sealed cavity oozing | Retraction, temp too high, wet filament | Add vents; reduce gaps | Tune retraction, dry filament, temp tower |
| Layer shift | process | One abrupt step at a Z height | - | Belt tension, loose grub screw, Vref, collision | - | Belt/pulley, lower accel, check for collisions |
| Under-extrusion | mixed | Thin/missing strands, gap-fill texture | Walls not a whole multiple of nozzle | Flow, clog, temp, feeder | Set wall = N x nozzle width | Flow calibration, clear clog |
| Elephant's foot | mixed | Bottom layers wider, smooth | Sharp bottom edges on fit faces | First-layer squish, bed too hot | Chamfer bottom 0.4-0.5 mm | Lower first-layer flow, elephant-foot compensation |
| Poor 1st-layer adhesion | mixed | Base detaches/curls | Tiny footprint | Z-offset, dirty/unlevel bed | Brim/raft, reorient for footprint | Z-offset, clean/level, adhesive |
| Delamination | mixed | Horizontal cracks mid-height | Load across layers; thin Z webs | Temp too low, cooling too high, wet | Reorient load to XY; thicken | Raise temp, less cooling, dry |
| Ghosting/ringing | process | Wave echoes from sharp corners | - | Vibration, high accel, loose frame | - | Input shaping (ADXL345), lower accel, tighten frame |
| Blobs/zits | process | Bumps on the surface, seam blobs | - | Retraction/coasting, seam placement | - | Coasting, wipe, seam alignment |
| Top pillowing | mixed | Top depressions over infill | Too-few top layers; low infill | Cooling on top | Top thickness >= 5 x layer; infill >= 15% | More cooling, more top layers |
| Gaps in top layers | mixed | Holes in the top surface | Thin top shell | Infill density, flow | Thicker top; raise infill | Raise top layers/infill |
| Clog / heat creep | process | Mid-print under-extrusion, stop | - | Hotend fan, ambient, worn/dirty nozzle | - | Hotend fan, lower ambient, clean/replace nozzle |
| Support failure | design_time | Supports detach, ruined overhang | Overhang past printer limit | Support density/interface | Reorient; chamfer overhangs; teardrops | Denser support/interface (last resort) |
| Bridging sag | mixed | Drooping unsupported span | Span > ~10 mm | Bridge speed/flow/cooling | Shorten span; add support rib | Bridge settings, more cooling |
| Z-seam zits | mixed | Vertical scar line | No designated seam edge | Seam placement | Add a sharp vertical edge for the seam | Align seam to a corner |
| Spaghetti | secondary | Tangled filament mid-air | Underlying adhesion/shift failure | Detachment, layer shift | Diagnose the root from bed remains | Fix the root cause |
