# Example: Plant pot with saucer

Two printed parts that go together, with a short assembly guide.

**Open it:** in Crease, Library > **Import pack** > `plant-pot-with-saucer.buildpack.zip`. Without the app, unzip it: `models/`
has STLs for any slicer, `source/` has the OpenSCAD files, `guide/assembly-guide.html` is the assembly guide.

Parts:
- **Pot**: 91.2 × 91.2 × 80 mm
- **Saucer**: 86 × 86 × 12 mm

Made from the "plant-pot" starter (`resources/starters/plant-pot`) by `npx tsx tools/make-examples.ts plant-pot`: no
designer (agent) run, so it costs nothing to rebuild. No G-code is included: slice it for your own printer.
Rendered with OpenSCAD version 2026.10.05. Check it: `cd examples/plant-pot && unzip -o plant-pot-with-saucer.buildpack.zip -d /tmp/plant-pot && cd /tmp/plant-pot && shasum -a 256 -c CHECKSUMS.sha256`.
