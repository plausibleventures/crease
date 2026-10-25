import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// R09: the project file routes judge paths by where they really land. PRINTSTUDIO_HOME before any server import.
const home = mkdtempSync(join(tmpdir(), "ps-routes-"))
process.env.PRINTSTUDIO_HOME = home
const outside = join(home, "outside")

let app: FastifyInstance
let id = ""
let dir = ""

beforeAll(async () => {
  const store = await import("../projects/store")
  const routes = (await import("./projects")).default
  const cad = await import("../cad/index")
  app = Fastify()
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.status(err.statusCode ?? 500).send({ error: err.message }))
  await app.register(routes)
  const p = await store.createProject("Paths")
  id = p.id
  dir = store.projectDir(id)
  await cad.unwatchProject() // createProject doesn't watch, but be safe
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "secret.txt"), "secret")
  writeFileSync(join(outside, "notes.scad"), "w = 1;")
  symlinkSync(join(outside, "secret.txt"), join(dir, "parts", "evil.scad"))
  symlinkSync(outside, join(dir, "lib", "out"))
  symlinkSync(join(outside, "secret.txt"), join(dir, "build", "leak.stl"))
  symlinkSync("../parts", join(dir, "lib", "inner"))
})
afterAll(async () => {
  const cad = await import("../cad/index")
  await cad.unwatchProject()
  await app?.close()
  rmSync(home, { recursive: true, force: true })
})

const get = (path: string) => app.inject({ method: "GET", url: `/api/projects/${id}/file?path=${encodeURIComponent(path)}` })
const put = (path: string, content: string) => app.inject({ method: "PUT", url: `/api/projects/${id}/file`, payload: { path, content } })

describe("project file routes: canonical paths (R09)", () => {
  it("reads normal files and in-project links", async () => {
    expect((await get("parts/main.scad")).statusCode).toBe(200)
    expect((await get("lib/inner/main.scad")).statusCode).toBe(200)
  })

  it("refuses to read through a link that leaves the project", async () => {
    const r = await get("parts/evil.scad")
    expect(r.statusCode).toBe(403)
    expect(r.body).not.toContain("secret")
    expect((await get("lib/out/secret.txt")).statusCode).toBe(403)
  })

  it("refuses to write through a link that leaves the project, existing or new", async () => {
    expect((await put("parts/evil.scad", "pwned")).statusCode).toBe(403)
    expect((await put("lib/out/new/dir/x.scad", "pwned")).statusCode).toBe(403)
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret")
    expect(existsSync(join(outside, "new"))).toBe(false)
  })

  it("the code editor can't write the app's own files or assistant settings", async () => {
    for (const p of [".claude/settings.json", ".studio/state.json", "build/x.gcode", ".mcp.json", "parts/.claude/settings.json"])
      expect((await put(p, "{}")).statusCode, p).toBe(403)
    expect((await put("parts/new.scad", "cube(2);")).statusCode).toBe(200)
    expect((await put("project.json", readFileSync(join(dir, "project.json"), "utf8"))).statusCode).toBe(200)
  })

  it("artifacts are served only from real build/ and renders/ paths", async () => {
    const r = await app.inject({ method: "GET", url: `/api/projects/${id}/artifacts/build/leak.stl` })
    expect(r.statusCode).toBe(403)
    expect(r.body).not.toContain("secret")
    expect((await app.inject({ method: "GET", url: `/api/projects/${id}/artifacts/parts/main.scad` })).statusCode).toBe(403)
  })

  it("agent-config status/enable/disable round trip", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "from elsewhere")
    const { prepareAgentConfig } = await import("../projects/agent-config")
    const { APP_SKILLS_DIR, installProjectSkills } = await import("../agent/prompt")
    expect(prepareAgentConfig(id, dir, APP_SKILLS_DIR).disabled).toEqual(["CLAUDE.md"])
    installProjectSkills(dir)
    let st = (await app.inject({ method: "GET", url: `/api/projects/${id}/agent-config` })).json()
    expect(st).toEqual({ enabled: [], pending: [], disabled: ["CLAUDE.md"] })
    expect((await app.inject({ method: "POST", url: `/api/projects/${id}/agent-config/enable`, payload: {} })).json()).toEqual({ enabled: ["CLAUDE.md"], skipped: [] })
    st = (await app.inject({ method: "GET", url: `/api/projects/${id}/agent-config` })).json()
    expect(st.enabled).toEqual(["CLAUDE.md"])
    expect(prepareAgentConfig(id, dir, APP_SKILLS_DIR).disabled).toEqual([])
    await app.inject({ method: "POST", url: `/api/projects/${id}/agent-config/disable` })
    // moved aside straight away, not only at the next session start
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false)
    expect((await app.inject({ method: "GET", url: `/api/projects/${id}/agent-config` })).json()).toEqual({ enabled: [], pending: [], disabled: ["CLAUDE.md"] })
    expect(prepareAgentConfig(id, dir, APP_SKILLS_DIR).disabled).toEqual([])
  })

  it("app skill folders are exact mirrors: links inside them are replaced, never written through", async () => {
    const { APP_SKILLS_DIR, installProjectSkills } = await import("../agent/prompt")
    const skill = readdirSync(APP_SKILLS_DIR, { withFileTypes: true }).find((e) => e.isDirectory())!.name
    const target = join(dir, ".claude", "skills", skill, "SKILL.md")
    rmSync(target, { force: true })
    symlinkSync(join(outside, "notes.scad"), target)
    writeFileSync(join(dir, ".claude", "skills", skill, "extra.md"), "added")
    installProjectSkills(dir)
    expect(readFileSync(join(outside, "notes.scad"), "utf8")).toBe("w = 1;")
    expect(readFileSync(target, "utf8")).toBe(readFileSync(join(APP_SKILLS_DIR, skill, "SKILL.md"), "utf8"))
    expect(existsSync(join(dir, ".claude", "skills", skill, "extra.md"))).toBe(false)
  })
})
