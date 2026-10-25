// Customizer parameters: parse OpenSCAD's annotations, and list what a part declares (its own file plus the
// project files it include<>s). Pure file reading, no OpenSCAD run, so the overrides store (server/projects/
// revision.ts) can use it synchronously.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import type { ScadParameter } from "../../shared/types"
import { partSourceText } from "./sculpt"

/**
 * Parse OpenSCAD Customizer annotations from source text.
 * Supports: `x = 10; // [1:100]`, `// [1:0.5:100]`, `// [a, b, c]`, `// [10:Small, 20:Large]`,
 * a description comment on the line above, `/* [Group] *\/` headers, and `/* [Hidden] *\/`.
 * Only top-level assignments before the first module/function/geometry statement count (like OpenSCAD).
 */
export function parseCustomizer(src: string): ScadParameter[] {
  const params: ScadParameter[] = []
  const lines = src.split(/\r?\n/)
  let group: string | undefined
  let hidden = false
  let prevComment: string | undefined
  let depth = 0
  for (const raw of lines) {
    const line = raw.trim()
    const groupM = line.match(/^\/\*\s*\[([^\]]+)\]\s*\*\/$/)
    if (depth === 0 && groupM) {
      group = groupM[1].trim()
      hidden = group.toLowerCase() === "hidden"
      prevComment = undefined
      continue
    }
    if (depth === 0 && /^(module|function)\b/.test(line)) break
    const assign = depth === 0 ? line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);\s*(?:\/\/\s*(.*))?$/) : null
    if (assign && !hidden) {
      const [, name, rawValue, annotation] = assign
      const p = parseParam(name, rawValue.trim(), annotation?.trim(), group, prevComment)
      if (p) params.push(p)
    }
    if (line.startsWith("//") && !assign) prevComment = line.replace(/^\/\/\s*/, "")
    else if (line !== "") prevComment = undefined
    depth += (line.match(/[{([]/g)?.length ?? 0) - (line.match(/[})\]]/g)?.length ?? 0)
    if (depth < 0) depth = 0
  }
  return params
}

function parseLiteral(v: string): number | string | boolean | undefined {
  if (v === "true") return true
  if (v === "false") return false
  if (/^-?(\d+\.?\d*|\.\d+)(e-?\d+)?$/i.test(v)) return Number(v)
  const s = v.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (s) return s[1].replace(/\\(.)/g, "$1")
  return undefined // expressions / vectors are not customizable
}

function parseParam(
  name: string,
  rawValue: string,
  annotation: string | undefined,
  group: string | undefined,
  description: string | undefined,
): ScadParameter | null {
  if (name.startsWith("$")) return null
  const value = parseLiteral(rawValue)
  if (value === undefined) return null
  const ann = annotation?.match(/^\[([^\]]*)\]/)?.[1]
  // A trailing note that isn't a range ("box_w = 80; // outside width (mm)") describes it when nothing above does.
  if (!description && annotation && ann === undefined) description = annotation.replace(/^\/+\s*/, "").trim().replace(/^./, (c) => c.toUpperCase()) || undefined
  const base = { name, value, group, description }
  if (typeof value === "boolean") return { ...base, type: "boolean" }
  if (ann !== undefined) {
    // Range: [max], [min:max], [min:step:max]
    const nums = ann.split(":").map((s) => s.trim())
    if (typeof value === "number" && nums.every((n) => /^-?[\d.]+$/.test(n)) && nums.length >= 1 && nums.length <= 3) {
      const n = nums.map(Number)
      if (n.length === 1) return { ...base, type: "number", min: 0, max: n[0] }
      if (n.length === 2) return { ...base, type: "number", min: n[0], max: n[1] }
      return { ...base, type: "number", min: n[0], step: n[1], max: n[2] }
    }
    // Options: [a, b, c] or [10:Label, 20:Label]
    const options = ann
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((o) => {
        const key = o.includes(":") ? o.slice(0, o.indexOf(":")).trim() : o
        return typeof value === "number" && /^-?[\d.]+$/.test(key) ? Number(key) : key.replace(/^"|"$/g, "")
      })
    if (options.length) return { ...base, type: "enum", options }
  }
  return { ...base, type: typeof value === "number" ? "number" : "string" }
}

const INCLUDE_ONLY_RE = /^\s*include\s*<([^>]+)>/gm

/**
 * Customizer parameters of the project files a part include<>s (lib/params.scad …), recursively, tagged with their
 * file. Only include<>: use<> doesn't share variables. Files outside the project (BOSL2 …) and names the part (or
 * an earlier file) already defines are skipped. A -D override reaches them like the part's own (E2E #2 P3).
 */
export function includedParametersSync(scadAbs: string, root: string, have: Set<string>, read?: Set<string>): ScadParameter[] {
  const out: ScadParameter[] = []
  const seen = new Set<string>([scadAbs])
  const visit = (file: string) => {
    let src: string
    try {
      src = readFileSync(file, "utf8")
    } catch {
      return
    }
    for (const m of src.matchAll(INCLUDE_ONLY_RE)) {
      const hit = [join(dirname(file), m[1]), join(root, m[1]), join(root, "lib", m[1])].find((c) => existsSync(c))
      if (!hit || seen.has(hit)) continue
      const rel = relative(root, hit)
      if (rel.startsWith("..")) continue
      seen.add(hit)
      read?.add(hit)
      let text = ""
      try {
        text = readFileSync(hit, "utf8")
      } catch {
        /* unreadable: nothing from it */
      }
      for (const p of parseCustomizer(text)) {
        if (have.has(p.name)) continue
        have.add(p.name)
        out.push({ ...p, file: rel.split("\\").join("/") })
      }
      visit(hit)
    }
  }
  visit(scadAbs)
  return out
}

/** Every Customizer parameter a part has: its own file's, then its include<>d project files' (tagged with `file`). */
export function declaredParameters(scadAbs: string, root: string, read?: Set<string>): ScadParameter[] {
  read?.add(scadAbs)
  let own: ScadParameter[]
  try {
    own = parseCustomizer(partSourceText(scadAbs)) // a Blender part's settings block reads as Customizer lines
  } catch {
    return []
  }
  return [...own, ...includedParametersSync(scadAbs, root, new Set(own.map((p) => p.name)), read)]
}
