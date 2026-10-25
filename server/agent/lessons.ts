// What each printer has taught the design agent: <STUDIO_HOME>/printers/<machineId>/lessons.md, one dated line per
// lesson with its evidence. Read into the brief (truncated) and via read_printer_lessons; appended by
// add_printer_lesson after the user reports a print result.
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PrinterLesson } from "../../shared/types"
import { machineLessonsPath } from "../machines"

export function readLessons(machineId: string, maxChars?: number): string {
  const f = machineLessonsPath(machineId)
  if (!existsSync(f)) return ""
  const text = readFileSync(f, "utf8").trim()
  if (!maxChars || text.length <= maxChars) return text
  // keep the newest lessons (appended at the end) and the heading
  const lines = text.split("\n")
  const head = lines[0]?.startsWith("#") ? lines.shift()! + "\n" : ""
  const out: string[] = []
  let n = head.length + 40
  for (let i = lines.length - 1; i >= 0 && n + lines[i].length + 1 <= maxChars; i--) {
    out.unshift(lines[i])
    n += lines[i].length + 1
  }
  return `${head}(older lessons trimmed; read_printer_lessons has them all)\n${out.join("\n")}`
}

/** Append one concise lesson: "- 2026-10-08: <lesson> (<evidence>)". Returns the line written. */
export function addLesson(machineId: string, machineName: string, lesson: string, evidence: string, date = new Date()): string {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim()
  const l = clean(lesson).replace(/\.$/, "")
  if (!l) throw Object.assign(new Error("lesson is empty"), { statusCode: 400 })
  if (l.length > 300) throw Object.assign(new Error("keep a lesson to one concise line (≤ 300 characters)"), { statusCode: 400 })
  const f = machineLessonsPath(machineId)
  mkdirSync(dirname(f), { recursive: true })
  if (!existsSync(f)) writeFileSync(f, `# What ${machineName} has taught us\n\n`)
  const existing = readFileSync(f, "utf8").toLowerCase()
  if (existing.includes(l.toLowerCase())) return `(already recorded) ${l}`
  const line = `- ${date.toISOString().slice(0, 10)}: ${l}${evidence.trim() ? ` (${clean(evidence)})` : ""}`
  appendFileSync(f, (existing.endsWith("\n") ? "" : "\n") + line + "\n")
  return line
}

/** The lesson lines ("- …"), oldest first, for the Machines lessons list. */
export function listLessons(machineId: string): PrinterLesson[] {
  const f = machineLessonsPath(machineId)
  if (!existsSync(f)) return []
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => /^- /.test(l))
    .map((line) => {
      const m = line.match(/^- (\d{4}-\d{2}-\d{2}): (.*)$/)
      return { line, date: m?.[1] ?? null, text: (m?.[2] ?? line.slice(2)).trim() }
    })
}

/** Remove one lesson line exactly as written (undo of an accepted lesson). Returns whether it was there. */
export function removeLesson(machineId: string, line: string): boolean {
  const f = machineLessonsPath(machineId)
  if (!existsSync(f) || !line.trim()) return false
  const lines = readFileSync(f, "utf8").split("\n")
  const i = lines.findIndex((l) => l.trimEnd() === line.trimEnd())
  if (i < 0) return false
  lines.splice(i, 1)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, lines.join("\n"))
  renameSync(tmp, f)
  return true
}
