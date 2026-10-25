// Sculpted parts: parts/<id>.blend.py, a Blender Python script the APP runs (sandboxed, server/cad/blender.ts) to
// make the part's mesh. Everything after that is the ordinary mesh pipeline: the app writes a small OpenSCAD wrapper,
// build/<id>.blend.scad, that import()s the mesh (with the part's print orientation and colours), and renders,
// checks, slicing, plates, the assembly, compare and colours all use that wrapper like any part's .scad.
//
// This file is the pure half (no Blender): the file convention, the settings block and the OpenSCAD "view" of a
// script that the Customizer, set_parameters, shared settings, orientation and preview hints read.
//
// A part script looks like:
//
//   # printstudio:sculpt  (made by Blender; see the blender-sculpting skill)
//   # @front: -y
//   import printstudio as ps
//   # --- settings ---
//   # [Size]
//   height = 110  # [80:1:140] Height (mm)
//   cape = True  # Cape
//   # --- end settings ---
//   ...
//
// Settings are one per line, `name = literal  # annotation`, between the two marker comments, with OpenSCAD's
// Customizer annotations after the `#` ([min:step:max], [a, b, c], a trailing label) and `# [Group]` headers.
// Literals: numbers, True/False and quoted strings. Values chosen in the app are written into these lines in a copy
// of the script before Blender runs it (the same as OpenSCAD's -D), so the script just uses the names.
import { existsSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { ORIENTATION_MARK, orientationBlock } from "./orient"

export const SCULPT_SUFFIX = ".blend.py"
export const SCULPT_MARK = "printstudio:sculpt"

/** Is this (project-relative or absolute) path a Blender part script? */
export const isSculptFile = (file: string): boolean => /\.blend\.py$/i.test(file)

/** The generated OpenSCAD wrapper of a Blender part (in build/, next to the part's other outputs). */
export const sculptWrapperRel = (partId: string): string => `build/${partId}.blend.scad`

const START_RE = /^\s*#\s*-{2,}\s*settings\s*-{2,}\s*$/i
const END_RE = /^\s*#\s*-{2,}\s*end\s+settings\s*-{2,}\s*$/i
const NAME_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/
const LIT_RE = /^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|True|False|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*(?:#\s?(.*))?$/

/** Line indexes of the settings block's interior [start, end), or null when the script has none. */
export function settingsRange(lines: string[]): [number, number] | null {
  const s = lines.findIndex((l) => START_RE.test(l))
  if (s < 0) return null
  const e = lines.findIndex((l, i) => i > s && END_RE.test(l))
  return [s + 1, e < 0 ? s + 1 : e]
}

interface PyAssign {
  name: string
  literal: string
  comment: string | undefined
}

function parseAssign(line: string): PyAssign | null {
  const n = NAME_RE.exec(line)
  if (!n) return null
  const m = LIT_RE.exec(line.slice(n[0].length))
  return m ? { name: n[1], literal: m[1], comment: m[2]?.trim() || undefined } : null
}

/** A Python literal as OpenSCAD source (True -> true, 'a' -> "a"). */
export function pyLiteralToScad(lit: string): string {
  if (lit === "True") return "true"
  if (lit === "False") return "false"
  if (lit.startsWith("'")) return JSON.stringify(lit.slice(1, -1).replace(/\\(.)/g, "$1"))
  return lit
}

/** A value as a Python literal. */
export function pyLiteral(v: number | string | boolean): string {
  if (typeof v === "boolean") return v ? "True" : "False"
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("invalid number")
    return String(v)
  }
  return JSON.stringify(String(v)) // JSON string escapes are valid Python
}

/** The settings a script declares, as `name -> literal` (in order). */
export function pySettings(src: string): PyAssign[] {
  const lines = src.split(/\r?\n/)
  const r = settingsRange(lines)
  if (!r) return []
  const out: PyAssign[] = []
  for (let i = r[0]; i < r[1]; i++) {
    const a = parseAssign(lines[i].trim())
    if (a) out.push(a)
  }
  return out
}

/**
 * Write values into the script's settings lines (keeping each line's annotation). Like applyParameters for .scad:
 * returns the names it didn't find. Only the settings block is touched.
 */
export function applyPyParameters(src: string, values: Record<string, number | string | boolean>): { source: string; missing: string[] } {
  const lines = src.split("\n")
  const r = settingsRange(lines.map((l) => l.replace(/\r$/, "")))
  const missing: string[] = []
  for (const [name, value] of Object.entries(values)) {
    let hit = false
    if (r && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      for (let i = r[0]; i < r[1]; i++) {
        const cr = lines[i].endsWith("\r") ? "\r" : ""
        const line = lines[i].replace(/\r$/, "")
        const indent = /^\s*/.exec(line)![0]
        const a = parseAssign(line.trim())
        if (!a || a.name !== name) continue
        const lit = pyLiteral(value)
        const n = NAME_RE.exec(line.trim())!
        const rest = line.trim().slice(n[0].length + a.literal.length) // spaces + "# comment"
        lines[i] = `${indent}${n[0]}${lit}${rest}${cr}`
        hit = true
        break
      }
    if (!hit) missing.push(name)
  }
  return { source: lines.join("\n"), missing }
}

/** The script with saved values written in (only names it declares). */
export function effectiveScript(src: string, params?: Record<string, number | string | boolean> | null): string {
  if (!params) return src
  const declared = new Set(pySettings(src).map((a) => a.name))
  const own = Object.fromEntries(Object.entries(params).filter(([k]) => declared.has(k)))
  return Object.keys(own).length ? applyPyParameters(src, own).source : src
}

/* ---------- print orientation (written by set_orientation; applied by the wrapper, not by Blender) ---------- */

type Vec = [number, number, number]
const PY_ORIENT_RE = /^(print_orientation\s*=\s*)\[([^\]\n]*)\]/m

/** The rotation a script's part is printed at (print_orientation), or [0, 0, 0]. */
export function readPyOrientation(src: string): Vec {
  if (!src.includes(ORIENTATION_MARK)) return [0, 0, 0]
  const v = PY_ORIENT_RE.exec(src)?.[2].split(",").map((s) => Number(s.trim())) ?? []
  return v.length === 3 && v.every(Number.isFinite) ? (v as Vec) : [0, 0, 0]
}

const vec = (v: Vec) => `[${v.map((x) => +x.toFixed(4)).join(", ")}]`

/** Set print_orientation in a script: the vector changes, or the documented line is added after the settings. */
export function writePyOrientation(src: string, rot: Vec): string {
  if (src.includes(ORIENTATION_MARK) && PY_ORIENT_RE.test(src)) return src.replace(PY_ORIENT_RE, (_m, a: string) => `${a}${vec(rot)}`)
  const lines = src.split("\n")
  const r = settingsRange(lines.map((l) => l.replace(/\r$/, "")))
  // after the settings block's end marker; else after the leading comment lines
  let at = r ? Math.min(lines.length, r[1] + 1) : lines.findIndex((l) => !/^\s*(#.*)?$/.test(l))
  if (at < 0) at = lines.length
  const block = [
    `# ${ORIENTATION_MARK}: how this part lies on the print bed (degrees about x, y, z), set by Crease.`,
    `# Crease turns the finished mesh; the script itself doesn't use it. [0, 0, 0] prints it as modelled.`,
    `print_orientation = ${vec(rot)}`,
  ]
  lines.splice(at, 0, ...block)
  return lines.join("\n")
}

/* ---------- the OpenSCAD view ---------- */

export interface SculptBody {
  /** path of the mesh, relative to the wrapper (build/) */
  file: string
  color: string | null
}

/**
 * OpenSCAD source standing for a script: its settings (Customizer syntax, so the app's parameter code reads them),
 * its preview hints (`# @front: +y` -> `// @front: +y`, `# @show: plate`), its print orientation and, when the
 * meshes are known, the geometry: each body import()ed (in its colour) inside rotate(print_orientation).
 */
export function sculptView(src: string, bodies?: SculptBody[], from = "a Blender part script"): string {
  const lines = src.split(/\r?\n/)
  const out: string[] = [`// generated by Crease from ${from} (a Blender part): do not edit. Edit the script instead.`, `// ${SCULPT_MARK}`]
  let defaultColor: string | null = null
  for (const l of lines) {
    const d = /^\s*#\s*@(front|show)\b(.*)$/i.exec(l)
    if (d) out.push(`// @${d[1].toLowerCase()}${d[2]}`)
    const c = /^\s*#\s*@colou?r\s*:?\s*["']?([#\w]+)["']?\s*$/i.exec(l)
    if (c) defaultColor = c[1]
  }
  const r = settingsRange(lines)
  if (r)
    for (let i = r[0]; i < r[1]; i++) {
      const t = lines[i].trim()
      const g = /^#\s*\[([^\]]+)\]\s*$/.exec(t)
      if (g) {
        out.push(`/* [${g[1].trim()}] */`)
        continue
      }
      const a = parseAssign(t)
      if (a) {
        out.push(`${a.name} = ${pyLiteralToScad(a.literal)};${a.comment ? ` // ${a.comment}` : ""}`)
        continue
      }
      if (t.startsWith("#")) out.push(`// ${t.replace(/^#\s?/, "")}`)
      else out.push("")
    }
  if (bodies) {
    const body = bodies
      .map((b) => {
        const c = b.color ?? defaultColor
        const imp = `import(${JSON.stringify(b.file)}, convexity = 10);`
        return `  ${c ? `color(${JSON.stringify(c)}) ` : ""}${imp}`
      })
      .join("\n")
    out.push("", orientationBlock(readPyOrientation(src), body))
  } else {
    const rot = readPyOrientation(src)
    out.push("", `// ${ORIENTATION_MARK}`, `print_orientation = ${vec(rot)};`)
  }
  return out.join("\n") + "\n"
}

/**
 * The text the parameter, orientation and preview code reads for a part file: the file itself, or for a Blender
 * part its OpenSCAD view (settings only; no geometry). Throws like readFileSync when the file is missing.
 */
export function partSourceText(abs: string): string {
  const src = readFileSync(abs, "utf8")
  return isSculptFile(abs) ? sculptView(src) : src
}

/**
 * Project files a script imports from lib/ (`import name` / `from name import …` with lib/name.py present),
 * recursively. Part of what the part is made from (its hash, the watcher).
 */
export function sculptLibDeps(scriptAbs: string, projectRoot: string): string[] {
  const lib = join(projectRoot, "lib")
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (file: string) => {
    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch {
      return
    }
    for (const m of src.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_]\w*)[ \t]+import|import[ \t]+([A-Za-z_][\w \t,.]*))/gm)) {
      const names = m[1] ? [m[1]] : m[2].split(",").map((s) => s.trim().split(/[\s.]+/)[0])
      for (const n of names) {
        const p = join(lib, `${n}.py`)
        if (seen.has(p) || !existsSync(p) || dirname(p) !== lib) continue
        seen.add(p)
        out.push(p)
        visit(p)
      }
    }
  }
  visit(scriptAbs)
  return out
}

/** Does this file name (in parts/) register as a part: an OpenSCAD file or a Blender part script? */
export const isPartFile = (name: string): boolean => /\.scad$/i.test(name) || isSculptFile(name)

/** Part id from its file: "parts/tray.scad" -> "tray", "parts/king.blend.py" -> "king". */
export const partIdOf = (file: string): string => basename(file).replace(/\.blend\.py$/i, "").replace(/\.scad$/i, "")

/**
 * OpenSCAD text whose color() calls give a part's colours: its .scad, or for a Blender part its built wrapper (the
 * colours of its bodies) once built, else its view (a `# @color:` line). Throws like readFileSync when missing.
 */
export function partColorText(root: string, file: string): string {
  if (!isSculptFile(file)) return readFileSync(join(root, file), "utf8")
  const src = readFileSync(join(root, file), "utf8")
  try {
    return readFileSync(join(root, sculptWrapperRel(partIdOf(file))), "utf8")
  } catch {
    return sculptView(src, [{ file: "", color: null }])
  }
}
