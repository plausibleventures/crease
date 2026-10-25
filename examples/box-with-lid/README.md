# Example: Box with a hinged lid

Two printed parts, one piece of hardware (a filament pin), a hinge that moves, and an assembly guide.

**Open it:** in Crease, Library > **Import pack** > `box-with-a-hinged-lid.buildpack.zip`. Without the app, unzip it: `models/`
has STLs for any slicer, `source/` has the OpenSCAD files, `guide/assembly-guide.html` is the assembly guide.

Parts:
- **Box**: 80 × 67.5 × 47 mm
- **Lid**: 80 × 72.5 × 7 mm

Made from the "box-with-lid" starter (`resources/starters/box-with-lid`) by `npx tsx tools/make-examples.ts box-with-lid`: no
designer (agent) run, so it costs nothing to rebuild. No G-code is included: slice it for your own printer.
Rendered with OpenSCAD version 2026.10.05. Check it: `cd examples/box-with-lid && unzip -o box-with-a-hinged-lid.buildpack.zip -d /tmp/box-with-lid && cd /tmp/box-with-lid && shasum -a 256 -c CHECKSUMS.sha256`.
