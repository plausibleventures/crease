// Screens never show file names or raw variable names (E2E #2 P3). Server reasons stay exact (the agent, tooltips,
// "Details"); these helpers turn them into plain words for the simple view.

const PART_FILE = /\bparts\/([\w-]+)\.scad\b/g
const LIB_FILE = /\blib\/[\w./-]+\.scad\b/g
const NAMED: [RegExp, string][] = [
  [/\bassembly\.json\b/g, "the assembly plan"],
  [/\bassembly\.scad\b/g, "the assembled view"],
  [/\bproject\.json\b/g, "the project's settings"],
  [/\bbom\.json\b/g, "the shopping list"],
]
const OTHER_FILE = /\b[\w./-]+\.(scad|json|stl|3mf|gcode|png|svg|step|stp)\b/g

const human = (id: string) => id.replace(/[_-]+/g, " ").trim()

/** Replace file paths and raw Customizer variable lists in a sentence with plain words. */
export function plainWords(text: string): string {
  let s = text
  // "Customizer values changed (wall_thickness, hole_d)" -> "sizes or options changed"
  s = s.replace(/(?:(\S+)'s )?Customizer values changed \([^)]*\)/g, (_m, id: string | undefined) => (id ? `the ${human(id)}'s sizes or options changed` : "sizes or options changed"))
  s = s.replace(PART_FILE, (_m, id: string) => `the ${human(id)} design`)
  s = s.replace(LIB_FILE, "a shared design file")
  for (const [re, words] of NAMED) s = s.replace(re, words)
  s = s.replace(OTHER_FILE, "a design file")
  // "main: the main design changed" -> "the main design changed"
  s = s.replace(/^([\w-]+): (the \1 design)/, "$2")
  return s
}
