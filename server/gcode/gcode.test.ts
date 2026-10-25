import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseGcode } from "./parse"
import { analyzeGcode } from "./analyze"
import { layerSvg } from "./render"

/** A square 20×20 block; optionally a 2 mm bar starting in mid-air at layer 3, gap fill / ironing on the top. */
function gcode(opts: { midAir?: boolean; gapTop?: boolean; ironing?: boolean; speed?: number }) {
  const out = ["; HEADER_BLOCK_START", "; HEADER_BLOCK_END", "M83", "G90"]
  const square = (o: number) => [`G1 X${100 + o} Y${100 + o} F12000`, `G1 F${(opts.speed ?? 100) * 60}`, `G1 X${120 - o} Y${100 + o} E1`, `G1 X${120 - o} Y${120 - o} E1`, `G1 X${100 + o} Y${120 - o} E1`, `G1 X${100 + o} Y${100 + o} E1`]
  for (let l = 0; l < 5; l++) {
    out.push(";LAYER_CHANGE", `;Z:${(l + 1) * 0.2}`, ";HEIGHT:0.2", ";TYPE:Outer wall", ";WIDTH:0.42", ...square(0))
    out.push(l === 4 ? ";TYPE:Top surface" : ";TYPE:Internal solid infill")
    for (let y = 101; y < 120; y += 0.4) out.push(`G1 X101 Y${y} F12000`, "G1 F6000", `G1 X119 Y${y} E0.5`)
    if (l === 4 && opts.gapTop) out.push(";TYPE:Gap infill", "G1 X100.3 Y100.3", "G1 X119.7 Y100.3 E0.2", "G1 X119.7 Y119.7 E0.2")
    if (l === 4 && opts.ironing) out.push(";TYPE:Ironing", "G1 X101 Y101", "G1 X119 Y119 E0.01")
    if (opts.midAir && l >= 2) out.push(";TYPE:Outer wall", "G1 X125 Y110 F12000", `G1 F${(opts.speed ?? 100) * 60}`, "G1 X135 Y110 E0.5", "G1 X135 Y111 E0.1", "G1 X125 Y111 E0.5")
  }
  out.push("; filament used [g] = 1.00", "; only_one_wall_top = 1", "; retraction_length = 0.8", "; nozzle_temperature = 220")
  return out.join("\n")
}
const codes = (g: string) => analyzeGcode(parseGcode(g), "build/x.gcode", "standard").issues.map((i) => i.code)

describe("G-code preview", () => {
  it("parses layers, features, widths and settings", () => {
    const p = parseGcode(gcode({ gapTop: true }))
    expect(p.layers).toHaveLength(5)
    expect(p.layers[4].z).toBeCloseTo(1.0)
    expect(p.layers[4].segments.map((s) => s.feature).sort()).toEqual(["Gap infill", "Outer wall", "Top surface"])
    expect(p.settings.only_one_wall_top).toBe("1")
    expect(p.bbox[0]).toBe(100)
  })
  it("flags gap fill on top, no ironing, fast walls, single top wall and mid-air starts", () => {
    const c = codes(gcode({ midAir: true, gapTop: true, speed: 200 }))
    expect(c).toEqual(expect.arrayContaining(["gap_infill_on_top", "no_ironing_flat_top", "fast_visible_walls", "single_top_wall", "starts_mid_air"]))
  })
  it("a clean, ironed, slow print has none of those", () => {
    const c = codes(gcode({ ironing: true, speed: 90 }).replace("; only_one_wall_top = 1", "; only_one_wall_top = 0"))
    expect(c).not.toEqual(expect.arrayContaining(["gap_infill_on_top"]))
    expect(c).not.toContain("no_ironing_flat_top")
    expect(c).not.toContain("fast_visible_walls")
    expect(c).not.toContain("starts_mid_air")
  })
  it("explains missing ironing honestly and never recommends the intent that's already selected", () => {
    const issue = (g: string, intent: "standard" | "display") => analyzeGcode(parseGcode(g), "build/x.gcode", intent).issues.find((i) => i.code === "no_ironing_flat_top")
    // Display asked for ironing (ironing_type = top) but the G-code has none
    const on = issue(gcode({}) + "\n; ironing_type = top", "display")!
    expect(on.message).toMatch(/Ironing is turned on, but the slicer didn't iron this top/)
    expect(on.fix).not.toMatch(/Use Display piece/)
    // Display with a custom "no ironing" override
    const off = issue(gcode({}) + "\n; ironing_type = no ironing", "display")!
    expect(off.message).toMatch(/turned off for this slice by a custom setting/)
    expect(off.fix).toMatch(/ironing_type/)
    // Standard: Display is the fix
    expect(issue(gcode({}) + "\n; ironing_type = no ironing", "standard")!.fix).toMatch(/Use Display piece/)
    // nothing on Display says "use Display"
    const all = analyzeGcode(parseGcode(gcode({ gapTop: true, speed: 200 }) + "\n; ironing_type = top"), "build/x.gcode", "display").issues
    for (const i of all) expect(i.fix ?? "", i.code).not.toMatch(/Use Display piece/)
  })

  it("says a small top was too small to iron when ironing was asked for", () => {
    // a 4×4 mm top: ~16 mm²
    const g = [
      ";LAYER_CHANGE", ";Z:0.2", ";HEIGHT:0.2", ";TYPE:Top surface", ";WIDTH:0.42",
      ...Array.from({ length: 10 }, (_, k) => [`G1 X100 Y${100 + k * 0.4} F12000`, `G1 X104 Y${100 + k * 0.4} E0.2`]).flat(),
      "; ironing_type = top",
    ].join("\n")
    const r = analyzeGcode(parseGcode(g), "build/x.gcode", "display").issues
    expect(r.map((i) => i.code)).toContain("ironing_skipped_small_top")
    expect(r.find((i) => i.code === "ironing_skipped_small_top")!.message).toMatch(/too small to iron/)
    expect(r.map((i) => i.code)).not.toContain("no_ironing_flat_top")
  })

  it("apple v3 leaf stick (flat underside, ~3 mm gap, real slice): a short bridge, not mid-air", () => {
    const g = readFileSync(new URL("./fixtures/apple-v3-stick.gcode", import.meta.url), "utf8")
    const issues = analyzeGcode(parseGcode(g), "build/x.gcode", "display").issues
    expect(issues.map((i) => i.code)).not.toContain("starts_mid_air")
    const sb = issues.find((i) => i.code === "short_bridge")!
    expect(sb.severity).toBe("info")
    expect(sb.message).toMatch(/short bridge/)
    expect(sb.layers).toEqual([4])
  })
  it("apple v1 round stem (one-loop sliver across the gap, real slice): still mid-air, fix says flat underside", () => {
    const g = readFileSync(new URL("./fixtures/apple-v1-round-stem.gcode", import.meta.url), "utf8")
    const issues = analyzeGcode(parseGcode(g), "build/x.gcode", "display").issues
    const m = issues.find((i) => i.code === "starts_mid_air")!
    expect(m.severity).toBe("warn")
    expect(m.fix).toMatch(/flat underside/)
    expect(issues.map((i) => i.code)).not.toContain("short_bridge")
  })
  it("plate side of a curved Display piece: straight zigzag first-layer lines are flagged, concentric loops aren't", () => {
    // A 20 mm disc, one layer: two walls (72-sided, gently curving) and a bottom surface filled either way.
    const ring = (r: number) => Array.from({ length: 73 }, (_, i) => [130 + r * Math.cos((i * Math.PI) / 36), 130 + r * Math.sin((i * Math.PI) / 36)])
    const path = (feature: string, pts: number[][]) => [`;TYPE:${feature}`, ";WIDTH:0.45", `G1 X${pts[0][0].toFixed(3)} Y${pts[0][1].toFixed(3)} F12000`, ...pts.slice(1).map(([x, y]) => `G1 X${x.toFixed(3)} Y${y.toFixed(3)} E0.02 F3000`)]
    const disc = (fill: "lines" | "concentric") => {
      const out = ["M83", "G90", ";LAYER_CHANGE", ";Z:0.2", ";HEIGHT:0.2", ...path("Outer wall", ring(10)), ...path("Inner wall", ring(9.55))]
      if (fill === "concentric") for (let r = 9.1; r > 0.5; r -= 0.45) out.push(...path("Bottom surface", ring(r)))
      else {
        // one joined zigzag, like OrcaSlicer's first layer: horizontal lines, short connectors along the wall
        const pts: number[][] = []
        for (let y = -8.9, k = 0; y < 8.9; y += 0.45, k++) {
          const x = Math.sqrt(9.1 * 9.1 - y * y)
          pts.push(...(k % 2 ? [[130 + x, 130 + y], [130 - x, 130 + y]] : [[130 - x, 130 + y], [130 + x, 130 + y]]))
        }
        out.push(...path("Bottom surface", pts))
      }
      return out.join("\n") + "\n"
    }
    const issue = (g: string, intent: "display" | "standard") => analyzeGcode(parseGcode(g), "build/x.gcode", intent).issues.find((i) => i.code === "bottom_lines_hit_curves")
    expect(issue(disc("lines"), "display")?.severity).toBe("info")
    expect(issue(disc("lines"), "display")?.fix).toMatch(/concentric bottom/)
    expect(issue(disc("concentric"), "display")).toBeUndefined()
    expect(issue(disc("lines"), "standard")).toBeUndefined() // only Display, where the plate side can be the show face
  })
  it("anchored overhang-wall spans: <=10 mm short bridge, longer or one-sided stays mid-air", () => {
    // two 10 mm blocks with a gap; from layer 4 a 2 mm band of overhang wall crosses the gap (or hangs off one side)
    const band = (gap: number, oneSided = false) => {
      const out = ["M83", "G90"]
      const right = 110 + gap
      const sq = (x0: number, x1: number) => [`G1 X${x0} Y100 F12000`, `G1 X${x1} Y100 E1`, `G1 X${x1} Y110 E1`, `G1 X${x0} Y110 E1`, `G1 X${x0} Y100 E1`]
      for (let l = 0; l < 6; l++) {
        out.push(";LAYER_CHANGE", `;Z:${(l + 1) * 0.2}`, ";HEIGHT:0.2", ";TYPE:Outer wall", ";WIDTH:0.42", ...sq(100, 110))
        if (!oneSided) out.push(...sq(right, right + 10))
        for (let y = 100.4; y < 110; y += 0.45) out.push(`G1 X100.4 Y${y.toFixed(2)} F12000`, `G1 X109.6 Y${y.toFixed(2)} E0.3`)
        if (l >= 3) {
          out.push(";TYPE:Overhang wall", ";WIDTH:0.4")
          const x1 = oneSided ? 110 + gap : right + 1
          for (const y of [104, 104.45, 104.9, 105.35, 105.8]) out.push(`G1 X109 Y${y} F12000`, `G1 X${x1} Y${y} E0.3`)
        }
      }
      return codes(out.join("\n"))
    }
    expect(band(6)).toContain("short_bridge")
    expect(band(6)).not.toContain("starts_mid_air")
    expect(band(14)).toContain("starts_mid_air")
    expect(band(6, true)).toContain("starts_mid_air")
    expect(band(6, true)).not.toContain("short_bridge")
  })

  it("renders a layer as SVG with a legend", () => {
    const svg = layerSvg(parseGcode(gcode({ gapTop: true })), "top")
    expect(svg).toContain("gap infill")
    expect(svg).toContain("<path")
  })
})
