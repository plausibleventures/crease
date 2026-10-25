import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ProjectFileNode, ServerEvent } from "../../shared/types"

// PRINTSTUDIO_HOME must be set before any server module loads (config.ts resolves it at import), so every app module
// below is imported dynamically.
const home = mkdtempSync(join(tmpdir(), "ps-files-"))
process.env.PRINTSTUDIO_HOME = home
const outside = join(home, "outside")

let app: FastifyInstance
let id = ""
let dir = ""
const events: ServerEvent[] = []

beforeAll(async () => {
  const Fastify = (await import("fastify")).default
  const store = await import("../projects/store")
  const routes = (await import("./files")).default
  const { onEvent } = await import("../events")
  onEvent((e) => events.push(e))
  app = Fastify()
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.status(err.statusCode ?? 500).send({ error: err.message }))
  await app.register(routes)
  const p = await store.createProject("Files")
  id = p.id
  dir = store.projectDir(id)
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "secret.txt"), "secret")
  symlinkSync(outside, join(dir, "out"))
  symlinkSync(join(outside, "secret.txt"), join(dir, "leak.txt"))
  mkdirSync(join(dir, "renders"), { recursive: true })
  writeFileSync(join(dir, "renders", "main-iso.png"), "png")
})
afterAll(async () => {
  const cad = await import("../cad/index")
  await cad.unwatchProject()
  await app?.close()
  rmSync(home, { recursive: true, force: true })
})

const upload = (path: string, body: string | Buffer, replace = false) =>
  app.inject({
    method: "POST",
    url: `/api/projects/${id}/files/upload?path=${encodeURIComponent(path)}${replace ? "&replace=1" : ""}`,
    headers: { "content-type": "application/octet-stream" },
    payload: typeof body === "string" ? Buffer.from(body) : body,
  })
const rename = (from: string, to: string) => app.inject({ method: "POST", url: `/api/projects/${id}/files/rename`, payload: { from, to } })
const del = (path: string) => app.inject({ method: "DELETE", url: `/api/projects/${id}/files?path=${encodeURIComponent(path)}` })
const list = async () => (await app.inject({ method: "GET", url: `/api/projects/${id}/files` })).json() as { files: ProjectFileNode[]; truncated: boolean }
const flat = (nodes: ProjectFileNode[]): ProjectFileNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])])

describe("project files routes", () => {
  it("lists the tree without app internals or links out", async () => {
    const r = await list()
    const paths = flat(r.files).map((n) => n.path)
    expect(paths).toContain("parts/main.scad")
    expect(paths).toContain("renders/main-iso.png")
    for (const hidden of [".git", ".studio", ".gitignore", "project.json", "out", "leak.txt"]) expect(paths).not.toContain(hidden)
    expect(paths.some((p) => p.startsWith("build"))).toBe(false)
    expect(flat(r.files).find((n) => n.path === "renders")?.readOnly).toBe(true)
    expect(r.files[0].kind).toBe("dir") // folders first
  })

  it("copies a file in, emits project.changed, and a new part .scad becomes a part", async () => {
    const before = events.length
    const r = await upload("assets/logo.svg", "<svg/>")
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ path: "assets/logo.svg" })
    expect(readFileSync(join(dir, "assets", "logo.svg"), "utf8")).toBe("<svg/>")
    expect(events.slice(before).some((e) => e.type === "project.changed" && e.paths.includes("assets/logo.svg"))).toBe(true)

    const s = await upload("parts/My Bracket.scad", "cube(5);")
    expect(s.json()).toEqual({ path: "parts/my-bracket.scad" })
    const { getProject } = await import("../projects/store")
    expect((await getProject(id)).parts.map((p) => p.id)).toContain("my-bracket")
  })

  it("never overwrites by accident: a taken name gets -2, replace=1 overwrites", async () => {
    expect((await upload("assets/logo.svg", "two")).json()).toEqual({ path: "assets/logo-2.svg" })
    expect((await upload("assets/logo.svg", "new", true)).json()).toEqual({ path: "assets/logo.svg" })
    expect(readFileSync(join(dir, "assets", "logo.svg"), "utf8")).toBe("new")
  })

  it("refuses path traversal, absolute paths and links out of the project", async () => {
    for (const p of ["../escape.txt", "assets/../../escape.txt", "/tmp/escape.txt"]) expect((await upload(p, "x")).statusCode, p).toBeGreaterThanOrEqual(400)
    expect(existsSync(join(home, "projects", "escape.txt"))).toBe(false)
    expect((await upload("out/x.txt", "x")).statusCode).toBe(403)
    expect((await upload("leak.txt", "pwned", true)).statusCode).toBe(403)
    expect((await del("leak.txt")).statusCode).toBe(403)
    expect((await rename("assets/logo-2.svg", "out/logo.svg")).statusCode).toBe(403)
    expect((await rename("assets/logo-2.svg", "../logo.svg")).statusCode).toBe(400)
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
    expect(existsSync(join(outside, "x.txt"))).toBe(false)
  })

  it("refuses the app's own folders and files", async () => {
    expect((await upload(".git/config", "x", true)).statusCode).toBe(400)
    for (const p of [".studio/state.json", "build/main.stl", "renders/x.png", "node_modules/x.js", "Build/x.stl", "project.json", ".gitignore"])
      expect((await upload(p, "x", true)).statusCode, p).toBe(403)
    expect((await del("renders/main-iso.png")).statusCode).toBe(403)
    expect((await del("project.json")).statusCode).toBe(403)
    expect((await del(".git")).statusCode).toBe(400)
    expect((await rename("project.json", "p.json")).statusCode).toBe(403)
    expect(existsSync(join(dir, "renders", "main-iso.png"))).toBe(true)
  })

  it("refuses G-code anywhere", async () => {
    for (const p of ["parts/x.gcode", "assets/x.GCODE", "x.bgcode", "x.gco"]) expect((await upload(p, "G28")).statusCode, p).toBe(403)
    expect((await rename("assets/logo-2.svg", "assets/logo.gcode")).statusCode).toBe(403)
  })

  it("refuses designer settings files (they come in only through agent-config trust)", async () => {
    for (const p of ["CLAUDE.md", "parts/claude.md", "AGENTS.md", "lib/AGENTS.override.md", ".claude/settings.json", "x/.codex/config.toml", ".grok/settings.json", ".mcp.json"])
      expect((await upload(p, "x")).statusCode, p).toBe(403)
    expect((await rename("assets/logo-2.svg", "CLAUDE.md")).statusCode).toBe(403)
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false)
  })

  it("renames and deletes; deleting a part's .scad removes the part", async () => {
    const r = await rename("assets/logo-2.svg", "assets/badge.svg")
    expect(r.json()).toEqual({ path: "assets/badge.svg" })
    expect(existsSync(join(dir, "assets", "badge.svg"))).toBe(true)
    expect((await rename("assets/badge.svg", "assets/logo.svg")).statusCode).toBe(409)
    expect((await rename("assets", "assets/inner")).statusCode).toBe(400)

    expect((await del("parts/my-bracket.scad")).statusCode).toBe(200)
    const { getProject } = await import("../projects/store")
    expect((await getProject(id)).parts.map((p) => p.id)).not.toContain("my-bracket")
    expect((await del("assets")).statusCode).toBe(200)
    expect(existsSync(join(dir, "assets"))).toBe(false)
    expect((await del("assets")).statusCode).toBe(404)
  })

  it("caps a file at 100 MB", async () => {
    const r = await upload("big.bin", Buffer.alloc(100 * 1024 * 1024 + 1))
    expect(r.statusCode).toBe(413)
    expect(existsSync(join(dir, "big.bin"))).toBe(false)
  })

  it("makes a new folder (parents too) with the same rules; never over something that exists", async () => {
    const before = events.length
    const r = await folder("lib/shapes")
    expect(r.json()).toEqual({ path: "lib/shapes" })
    expect(statSync(join(dir, "lib", "shapes")).isDirectory()).toBe(true)
    expect(events.slice(before).some((e) => e.type === "project.changed" && e.paths.includes("lib/shapes"))).toBe(true)
    expect(flat((await list()).files).find((n) => n.path === "lib/shapes")?.kind).toBe("dir")
    expect((await folder("lib/shapes")).statusCode).toBe(409)
    expect((await folder("parts/main.scad")).statusCode).toBe(409)
    expect((await folder("")).statusCode).toBe(400)
    for (const p of ["../up", "/tmp/abs", "lib/../../up"]) expect((await folder(p)).statusCode, p).toBe(400)
    for (const p of ["out/inside-link", "renders/x", "build/x", ".studio/x", ".claude", "x/.codex", "Build"]) expect((await folder(p)).statusCode, p).toBe(403)
    expect(existsSync(join(outside, "inside-link"))).toBe(false)
    expect(existsSync(join(home, "projects", "up"))).toBe(false)
  })
})

const folder = (path: string) => app.inject({ method: "POST", url: `/api/projects/${id}/files/folder`, payload: { path } })
