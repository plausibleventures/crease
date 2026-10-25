# Example build packs

Small, finished projects you can open in Crease (Library > **Import pack**) or unzip and print with any slicer.
Each is a build pack: the editable OpenSCAD source, STL models, pictures, a parts list and, when it has more than
one part, an assembly guide. Every file is listed with its checksum in `printstudio-pack.json` and `CHECKSUMS.sha256`.

| Example | What it shows |
|---|---|
| [box-with-lid](box-with-lid/) | Two parts, a hinge that moves on a filament pin, hardware in the shopping list, assembly guide |
| [plant-pot](plant-pot/) | Two parts that go together, assembly guide |
| [cable-clip](cable-clip/) | One part, nothing to assemble |

They are made from the bundled starters by `npx tsx tools/make-examples.ts` (needs OpenSCAD; no designer run, so
rebuilding costs nothing). The same OpenSCAD version gives byte-identical zips. No G-code is included: G-code only
fits the printer it was sliced for.
