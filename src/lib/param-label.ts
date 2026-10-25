// Customizer setting labels: the .scad comment above a setting when it has one, else a readable name made from the
// variable ("box_d" -> "Box depth", "hole_d" -> "Hole diameter", "wall_t" -> "Wall thickness").

/** Things that are round, so a trailing `_d` means diameter rather than depth. */
const ROUND = /^(hole|screw|pin|cable|head|rod|bolt|nut|magnet|tube|pipe|shaft|wire|knob|ring|rim|top|bottom|inner|outer|pot|cup|stem|peg|axle|dowel|bore|thread|coin|disc|disk|wheel|bearing|bead|ball|button|cord|straw|lens|spool)$/i

const SUFFIX: Record<string, string> = {
  w: "width",
  h: "height",
  t: "thickness",
  r: "radius",
  l: "length",
  len: "length",
  dia: "diameter",
  th: "thickness",
  thk: "thickness",
  n: "count",
  num: "count",
  ang: "angle",
}

/** "box_d" -> "Box depth"; "n_holes" -> "Holes"; "rib_count" -> "Rib count". Unknown names keep their words. */
export function humanParamName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase
    .split(/_+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  if (!words.length) return name
  // a leading count marker: "n_holes" -> "holes"
  if (words.length > 1 && (words[0] === "n" || words[0] === "num")) words.shift()
  const last = words[words.length - 1]
  if (words.length > 1) {
    if (last === "d") words[words.length - 1] = words.slice(0, -1).some((w) => ROUND.test(w)) ? "diameter" : "depth"
    else if (SUFFIX[last]) words[words.length - 1] = SUFFIX[last]
  }
  const s = words.join(" ")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The label a setting shows: its description, else its humanized name. */
export const paramLabel = (p: { name: string; description?: string }) => p.description?.trim() || humanParamName(p.name)
