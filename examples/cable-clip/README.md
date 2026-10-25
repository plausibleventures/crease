# Example: Cable clip

The simplest kind of project: one part, no assembly.

**Open it:** in Crease, Library > **Import pack** > `cable-clip.buildpack.zip`. Without the app, unzip it: `models/`
has STLs for any slicer, `source/` has the OpenSCAD files.

Parts:
- **clip**: 36.5 × 10 × 12 mm

Made from the "cable-clip" starter (`resources/starters/cable-clip`) by `npx tsx tools/make-examples.ts cable-clip`: no
designer (agent) run, so it costs nothing to rebuild. No G-code is included: slice it for your own printer.
Rendered with OpenSCAD version 2026.10.05. Check it: `cd examples/cable-clip && unzip -o cable-clip.buildpack.zip -d /tmp/cable-clip && cd /tmp/cable-clip && shasum -a 256 -c CHECKSUMS.sha256`.
