// The colours a part's design asks for, the same way the slicer reads them (server/slicer/index.ts partBodies): the
// named color() calls in its source first, else the colours project.json declares for it. The Overview and the print
// dialog use this so they never say White while the slice picks the Black slot for color("black").
import type { Project } from "../../shared/types"
import { partColorText } from "../cad/sculpt"

/** Named colours in OpenSCAD source: color("black"), color("#1a1a1a"). Comments are skipped; vectors aren't names. */
export function sourceColors(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  return [...new Set([...code.matchAll(/\bcolor\s*\(\s*(?:c\s*=\s*)?"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean))]
}

/** One part's design colours: its source's named color() calls, else project.json `colors`; [] = uncoloured. */
export function partDesignColors(root: string, part: Project["parts"][number]): string[] {
  let src = ""
  try {
    src = partColorText(root, part.file) // a Blender part: the colours of its built bodies
  } catch {
    /* missing source: fall back to the declared colours */
  }
  const named = sourceColors(src)
  return named.length ? named : (part.colors ?? [])
}
