// Cut a small G-code fixture out of a real slice: a few layers, only the moves that touch a box on the bed.
// Used for analyzer fixtures (server/gcode/fixtures/), e.g. the apple v3 leaf stick:
//   npx tsx tools/crop-gcode.ts <in.gcode> <out.gcode> <firstLayer> <lastLayer> <x0> <y0> <x1> <y1>
import { readFileSync, writeFileSync } from "node:fs"
import { parseGcode } from "../server/gcode/parse"

const [inp, out, l0, l1, ...box] = process.argv.slice(2)
const [x0, y0, x1, y1] = box.map(Number)
const p = parseGcode(readFileSync(inp, "utf8"))
const inBox = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1
const r = (n: number) => n.toFixed(3)
const lines = [`; cropped from a real OrcaSlicer slice: layers ${l0}-${l1}, box ${box.join(",")} (tools/crop-gcode.ts)`, "M83", "G90"]
for (let li = Number(l0); li <= Number(l1); li++) {
  const l = p.layers[li]
  lines.push(";LAYER_CHANGE", `;Z:${r(l.z)}`, `;HEIGHT:${r(l.height)}`)
  for (const s of l.segments) {
    const c = s.coords
    const moves: string[] = []
    for (let i = 0; i < c.length; i += 4) {
      if (!inBox(c[i], c[i + 1]) && !inBox(c[i + 2], c[i + 3])) continue
      moves.push(`G1 X${r(c[i])} Y${r(c[i + 1])} F12000`, `G1 X${r(c[i + 2])} Y${r(c[i + 3])} E0.05 F3000`)
    }
    if (moves.length) lines.push(`;TYPE:${s.feature}`, `;WIDTH:${s.lineWidth}`, ...moves)
  }
}
writeFileSync(out, lines.join("\n") + "\n")
console.log(`wrote ${out}: ${lines.length} lines`)
