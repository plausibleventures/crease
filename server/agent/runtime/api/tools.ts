// The direct API runtime's own tools (R11f): structured file access and skills, no shell. Together with the app's
// registry tools (render/check/slice/print…) and AskUserQuestion they are everything the model can do.
//
// - read_file / list_files: the project folder (symlinks resolved) and the bundled OpenSCAD libraries; never the
//   app's secret files (policy.denyRead) or anything else outside. Images come back as images.
// - write_file / edit_file: inside the project only, never app-owned paths (policy.ts protectedReason: build/,
//   renders/, .studio/, .git/, .claude/, project.json, G-code…). Every write is reported to the app (approval tracking).
// - read_skill: the bundled skills as reading material (list, SKILL.md, files next to it).
// Inputs are validated with zod (eager input streaming means the API doesn't): failures are tool errors the model reads.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, extname, join, relative, sep } from "node:path"
import { z } from "zod"
import { LIBRARIES_DIR } from "../../../cad/libraries"
import { canonicalPath, isInside, realRoot } from "../../../projects/paths"
import { protectedReason } from "../../policy"
import { APP_SKILLS_DIR } from "../../prompt"
import { inputJsonSchema, type ToolDef, type ToolResult } from "../../registry"
import { ASK_DESCRIPTION, ASK_SCHEMA, ASK_TOOL } from "../codex/tools"
import type { ToolSpec } from "./endpoint"

export { ASK_TOOL }

export interface FileToolContext {
  root: string
  /** App files the agent may never read (settings.json, secrets.json). */
  denyRead: string[]
  /** A file write the app performed (approval tracking: a geometry change withdraws the approval). */
  onWrite(tool: "Write" | "Edit", absPath: string): void
  /** Override for tests. */
  skillsDir?: string
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const err = (text: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true })

const MAX_READ = 200_000
const MAX_IMAGE = 8 * 1024 * 1024
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }
const BINARY = /\.(stl|3mf|gcode|bgcode|zip|pdf|step|stp|obj|amf)$/i
const SKIP_DIRS = new Set([".git", ".studio", ".claude", "node_modules", ".codex", ".grok", ".agents"])

type FileTool = { def: ToolDef; run(ctx: FileToolContext, input: never): Promise<ToolResult> | ToolResult }

function readable(ctx: FileToolContext, path: string): { abs: string } | { error: string } {
  const abs = canonicalPath(ctx.root, path)
  const inside = isInside(realRoot(ctx.root), abs) || isInside(realRoot(LIBRARIES_DIR), abs)
  const denied = ctx.denyRead.some((d) => {
    const t = canonicalPath(d, d)
    return abs === t || isInside(t, abs) || isInside(abs, t)
  })
  if (!inside || denied) return { error: `Blocked by Crease: you can only read files in this project (and the bundled libraries); ${path} is outside.` }
  return { abs }
}

const rel = (ctx: FileToolContext, abs: string) => {
  const r = relative(realRoot(ctx.root), abs)
  return r && !r.startsWith("..") ? r : abs
}

const readFileShape = {
  path: z.string().min(1).describe("File path, relative to the project folder (e.g. parts/main.scad)."),
  offset: z.number().int().min(1).optional().describe("First line to read (1-based). Optional."),
  limit: z.number().int().min(1).optional().describe("How many lines to read. Optional."),
}
const listShape = {
  path: z.string().optional().describe("Folder relative to the project (default: the project folder)."),
}
const writeShape = {
  path: z.string().min(1).describe("File path relative to the project folder, e.g. parts/lid.scad."),
  content: z.string().describe("The whole new file content."),
}
const editShape = {
  path: z.string().min(1).describe("File path relative to the project folder."),
  old_string: z.string().min(1).describe("Exact text to replace (copy it from read_file, including indentation). Must be unique unless replace_all."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one."),
}
const skillShape = {
  name: z.string().optional().describe("Skill name (omit to list the skills)."),
  file: z.string().optional().describe("A file inside the skill's folder other than SKILL.md (as SKILL.md names it)."),
}

export const FILE_TOOLS: Record<string, FileTool> = {
  read_file: {
    def: {
      name: "read_file",
      description:
        "Read a text file in the project (or the bundled OpenSCAD libraries, e.g. BOSL2). Image files (PNG/JPEG/WebP/GIF, like a photo in refs/) come back as an image you can look at. Use offset/limit for long files.",
      input: readFileShape,
      handler: async () => ok(""),
    },
    run(ctx, input: z.infer<z.ZodObject<typeof readFileShape>>) {
      const r = readable(ctx, input.path)
      if ("error" in r) return err(r.error)
      let st
      try {
        st = statSync(r.abs)
      } catch {
        return err(`${input.path} doesn't exist. Use list_files to see what's there.`)
      }
      if (st.isDirectory()) return err(`${input.path} is a folder; use list_files.`)
      const type = IMAGE_TYPES[extname(r.abs).toLowerCase()]
      if (type) {
        if (st.size > MAX_IMAGE) return err(`${input.path} is too large to look at (over 8 MB).`)
        return { content: [{ type: "text", text: rel(ctx, r.abs) }, { type: "image", data: readFileSync(r.abs).toString("base64"), mimeType: type }] }
      }
      if (BINARY.test(r.abs)) return err(`${input.path} is a binary file (mesh, slice or archive); use the studio tools (check_part, preview_slice, …) to inspect it.`)
      let text = readFileSync(r.abs, "utf8")
      let note = ""
      if (input.offset || input.limit) {
        const lines = text.split("\n")
        const start = (input.offset ?? 1) - 1
        const end = input.limit ? start + input.limit : lines.length
        text = lines.slice(start, end).join("\n")
        note = `[lines ${start + 1}-${Math.min(end, lines.length)} of ${lines.length}]\n`
      }
      if (text.length > MAX_READ) {
        note += `[showing the first ${MAX_READ} characters of ${text.length}; use offset/limit for the rest]\n`
        text = text.slice(0, MAX_READ)
      }
      return ok(note + text)
    },
  },
  list_files: {
    def: { name: "list_files", description: "List the files in a project folder (recursively; app folders like .git and .studio are skipped).", input: listShape, handler: async () => ok("") },
    run(ctx, input: z.infer<z.ZodObject<typeof listShape>>) {
      const r = readable(ctx, input.path || ".")
      if ("error" in r) return err(r.error)
      if (!existsSync(r.abs) || !statSync(r.abs).isDirectory()) return err(`${input.path} isn't a folder.`)
      const out: string[] = []
      const walk = (dir: string, depth: number) => {
        if (out.length >= 500 || depth > 6) return
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        } catch {
          return
        }
        for (const e of entries) {
          if (out.length >= 500) return
          const p = join(dir, e.name)
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue
            out.push(rel(ctx, p) + "/")
            walk(p, depth + 1)
          } else if (e.isFile()) {
            let size = 0
            try {
              size = statSync(p).size
            } catch {
              /* gone */
            }
            out.push(`${rel(ctx, p)} (${size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KB`})`)
          }
        }
      }
      walk(r.abs, 0)
      return ok(out.length ? out.join("\n") + (out.length >= 500 ? "\n[list cut at 500 entries]" : "") : "(empty)")
    },
  },
  write_file: {
    def: {
      name: "write_file",
      description: "Create or overwrite a file in the project (e.g. parts/<id>.scad, lib/*.scad). Generated folders (build/, renders/), .studio/, project.json and G-code can't be written.",
      input: writeShape,
      handler: async () => ok(""),
    },
    run(ctx, input: z.infer<z.ZodObject<typeof writeShape>>) {
      const why = protectedReason(ctx.root, input.path)
      if (why) return err(`Blocked by Crease: ${why}`)
      const abs = canonicalPath(ctx.root, input.path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, input.content)
      ctx.onWrite("Write", abs)
      return ok(`Wrote ${rel(ctx, abs)} (${input.content.split("\n").length} lines).`)
    },
  },
  edit_file: {
    def: {
      name: "edit_file",
      description: "Replace exact text in a project file. old_string must match the file exactly (read it first) and be unique unless replace_all is true.",
      input: editShape,
      handler: async () => ok(""),
    },
    run(ctx, input: z.infer<z.ZodObject<typeof editShape>>) {
      const why = protectedReason(ctx.root, input.path)
      if (why) return err(`Blocked by Crease: ${why}`)
      const abs = canonicalPath(ctx.root, input.path)
      let text: string
      try {
        text = readFileSync(abs, "utf8")
      } catch {
        return err(`${input.path} doesn't exist; use write_file to create it.`)
      }
      const n = text.split(input.old_string).length - 1
      if (n === 0) return err(`old_string wasn't found in ${input.path}. Read the file and copy the text exactly.`)
      if (n > 1 && !input.replace_all) return err(`old_string appears ${n} times in ${input.path}; include more surrounding text to make it unique, or set replace_all.`)
      const next = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string)
      writeFileSync(abs, next)
      ctx.onWrite("Edit", abs)
      return ok(`Edited ${rel(ctx, abs)} (${input.replace_all ? n : 1} change${(input.replace_all ? n : 1) === 1 ? "" : "s"}).`)
    },
  },
  read_skill: {
    def: {
      name: "read_skill",
      description:
        "Crease's skills: reference notes on designing printable parts (beginner intake, printable OpenSCAD, fits, joints, print finish, assembly guides, measuring from photos…). Call with no name to list them, with a name to read its SKILL.md, plus `file` for a file it points to.",
      input: skillShape,
      handler: async () => ok(""),
    },
    run(ctx, input: z.infer<z.ZodObject<typeof skillShape>>) {
      const dir = ctx.skillsDir ?? APP_SKILLS_DIR
      const skills = listSkills(dir)
      if (!input.name) return ok(skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") || "(no skills)")
      const s = skills.find((x) => x.name === input.name || x.dir === input.name)
      if (!s) return err(`No skill named "${input.name}". Skills: ${skills.map((x) => x.name).join(", ")}`)
      const base = join(dir, s.dir)
      const target = join(base, input.file || "SKILL.md")
      if (!isInside(base, target)) return err("That file is outside the skill's folder.")
      let text: string
      try {
        text = readFileSync(target, "utf8")
      } catch {
        return err(`${input.file} isn't in the ${s.name} skill. Files: ${filesIn(base).join(", ")}`)
      }
      const others = filesIn(base).filter((f) => f !== "SKILL.md")
      return ok(text + (input.file || !others.length ? "" : `\n\n[Other files in this skill (read with read_skill name="${s.name}" file=…): ${others.join(", ")}]`))
    },
  },
}

function filesIn(base: string, sub = ""): string[] {
  const out: string[] = []
  for (const e of readdirSync(join(base, sub), { withFileTypes: true })) {
    const p = sub ? `${sub}${sep}${e.name}` : e.name
    if (e.isDirectory()) out.push(...filesIn(base, p))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

export function listSkills(dir: string): { name: string; dir: string; description: string }[] {
  const out: { name: string; dir: string; description: string }[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    let text: string
    try {
      text = readFileSync(join(dir, e.name, "SKILL.md"), "utf8")
    } catch {
      continue
    }
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ""
    const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim() || e.name
    const description = (/^description:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "").slice(0, 300)
    out.push({ name, dir: e.name, description })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Run one of the runtime's own tools, with input validation. */
export async function runFileTool(ctx: FileToolContext, name: string, input: unknown): Promise<ToolResult> {
  const t = FILE_TOOLS[name]
  if (!t) return err(`Unknown tool ${name}.`)
  const parsed = z.object(t.def.input).safeParse(input ?? {})
  if (!parsed.success) return err(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`)
  try {
    return await t.run(ctx, parsed.data as never)
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}

/** The AskUserQuestion input, validated (the same shape Claude's tool takes). */
export const askInput = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1),
        header: z.string(),
        multiSelect: z.boolean(),
        options: z.array(z.object({ label: z.string().min(1), description: z.string(), preview: z.string().optional() })).min(2).max(4),
      })
    )
    .min(1)
    .max(4),
})

function clean(schema: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...rest } = schema
  return rest
}

/** Every tool the model gets, in a fixed order (the tool list is part of the cached, thinking-bound prefix). */
export function toolSpecs(appTools: readonly ToolDef[]): ToolSpec[] {
  return [
    ...Object.values(FILE_TOOLS).map((t) => ({ name: t.def.name, description: t.def.description, inputSchema: clean(inputJsonSchema(t.def)) })),
    ...appTools.map((t) => ({ name: t.name, description: t.description, inputSchema: clean(inputJsonSchema(t)) })),
    { name: ASK_TOOL, description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA },
  ]
}

/** How a call shows in the timeline: Claude's names for the same kind of thing, so it renders the same way. */
export function timelineCall(name: string, input: unknown): { name: string; input: unknown } {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  switch (name) {
    case "read_file":
      return { name: "Read", input: { file_path: i.path, ...(i.offset ? { offset: i.offset } : {}), ...(i.limit ? { limit: i.limit } : {}) } }
    case "list_files":
      return { name: "Glob", input: { path: i.path ?? "." } }
    case "write_file":
      return { name: "Write", input: { file_path: i.path, content: i.content } }
    case "edit_file":
      return { name: "Edit", input: { file_path: i.path, old_string: i.old_string, new_string: i.new_string, ...(i.replace_all ? { replace_all: true } : {}) } }
    case "read_skill":
      return { name: "Skill", input: { skill: i.name ?? "(list)", ...(i.file ? { file: i.file } : {}) } }
    case ASK_TOOL:
      return { name, input }
    default:
      return { name: `mcp__studio__${name}`, input }
  }
}
