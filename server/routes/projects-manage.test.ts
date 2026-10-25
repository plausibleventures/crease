import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// U4: rename, tags, duplicate, move to Trash. PRINTSTUDIO_HOME before any server import; nothing outside it is touched.
const home = mkdtempSync(join(tmpdir(), "ps-manage-"))
process.env.PRINTSTUDIO_HOME = home
const projectsDir = join(home, "projects")

let app: FastifyInstance
let store: typeof import("../projects/store")
let manage: typeof import("../projects/manage")
let db: typeof import("../db")

beforeAll(async () => {
  store = await import("../projects/store")
  manage = await import("../projects/manage")
  db = await import("../db")
  const routes = (await import("./projects")).default
  app = Fastify()
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.status(err.statusCode ?? 500).send({ error: err.message }))
  await app.register(routes)
})
afterAll(async () => {
  const cad = await import("../cad/index")
  await cad.unwatchProject()
  await app?.close()
  manage?.setTrashHandler(null)
  rmSync(home, { recursive: true, force: true })
})

const req = (method: "PATCH" | "POST" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) })

describe("rename + tags (PATCH /api/projects/:id)", () => {
  it("renames the display name only and keeps the id and folder", async () => {
    const p = await store.createProject("Phone stand")
    const r = await req("PATCH", `/api/projects/${p.id}`, { name: "  Desk   phone stand " })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ id: p.id, name: "Desk phone stand" })
    expect(existsSync(join(projectsDir, p.id, "project.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(projectsDir, p.id, "project.json"), "utf8")).name).toBe("Desk phone stand")
  })

  it("replaces tags (trimmed, de-duplicated) and the catalog tag filter finds the project", async () => {
    const p = await store.createProject("Hook")
    const r = await req("PATCH", `/api/projects/${p.id}`, { tags: [" Kitchen ", "kitchen", "wall  mount", ""] })
    expect(r.statusCode).toBe(200)
    expect(r.json().tags).toEqual(["Kitchen", "wall mount"])
    expect(db.listCatalog({ tag: "kitchen" }).map((x) => x.id)).toContain(p.id)
    expect(db.listTags().map((t) => t.tag.toLowerCase())).toContain("wall mount")
    // removing a tag removes it from the filter
    await req("PATCH", `/api/projects/${p.id}`, { tags: ["wall mount"] })
    expect(db.listCatalog({ tag: "kitchen" }).map((x) => x.id)).not.toContain(p.id)
  })

  it("rejects bad input", async () => {
    const p = await store.createProject("Bad input")
    expect((await req("PATCH", `/api/projects/${p.id}`, { name: "   " })).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/${p.id}`, { name: "x".repeat(81) })).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/${p.id}`, { tags: "kitchen" })).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/${p.id}`, { tags: ["x".repeat(33)] })).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/${p.id}`, { tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/${p.id}`, {})).statusCode).toBe(400)
    expect((await req("PATCH", `/api/projects/no-such-project`, { name: "x" })).statusCode).toBe(404)
  })
})

describe("duplicate (POST /api/projects/:id/duplicate)", () => {
  it("copies the design and history under a new id, without chats or print jobs", async () => {
    const p = await store.createProject("Cable tray")
    const dir = store.projectDir(p.id)
    writeFileSync(join(dir, "parts", "main.scad"), "cube(12);\n")
    await store.updateProject(p.id, { sessions: [{ id: "s1", title: "chat", forkedFrom: null }], activeSessionId: "s1" })
    mkdirSync(join(dir, ".studio", "jobs"), { recursive: true })
    writeFileSync(join(dir, ".studio", "jobs", "state.json"), "{}")
    mkdirSync(join(dir, ".studio", "params", "main"), { recursive: true })
    writeFileSync(join(dir, ".studio", "params", "main", "main.json"), '{"w":3}')

    const r = await req("POST", `/api/projects/${p.id}/duplicate`)
    expect(r.statusCode).toBe(200)
    const copy = r.json()
    expect(copy.id).not.toBe(p.id)
    expect(copy.name).toBe("Cable tray copy")
    expect(copy.sessions).toEqual([])
    expect(copy.activeSessionId).toBeNull()
    const cdir = store.projectDir(copy.id)
    expect(readFileSync(join(cdir, "parts", "main.scad"), "utf8")).toBe("cube(12);\n")
    expect(existsSync(join(cdir, ".git"))).toBe(true)
    expect(existsSync(join(cdir, ".studio", "jobs"))).toBe(false)
    expect(existsSync(join(cdir, ".studio", "params", "main", "main.json"))).toBe(true)
    expect((await store.listCheckpoints(copy.id)).checkpoints[0].message).toMatch(/copy of Cable tray/)
    // the original is untouched
    expect((await store.getProject(p.id)).sessions.map((s) => s.id)).toEqual(["s1"])
    expect(db.listCatalog({}).map((x) => x.id)).toContain(copy.id)
  })

  it("takes a name, and a second copy gets its own id", async () => {
    const p = await store.createProject("Coaster")
    const a = (await req("POST", `/api/projects/${p.id}/duplicate`, { name: "Coaster B" })).json()
    const b = (await req("POST", `/api/projects/${p.id}/duplicate`, { name: "Coaster B" })).json()
    expect(a.name).toBe("Coaster B")
    expect(a.id).not.toBe(b.id)
  })
})

describe("move to Trash (DELETE /api/projects/:id)", () => {
  it("without an OS trash: moves the folder into <home>/.trash and drops the catalog row", async () => {
    const p = await store.createProject("Old idea")
    const r = await req("DELETE", `/api/projects/${p.id}`)
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ trashed: true, where: "app" })
    expect(existsSync(join(projectsDir, p.id))).toBe(false)
    expect(body.path.startsWith(join(home, ".trash") + "/")).toBe(true)
    expect(existsSync(join(body.path, "project.json"))).toBe(true) // nothing deleted
    expect(db.listCatalog({}).map((x) => x.id)).not.toContain(p.id)
    expect((await req("DELETE", `/api/projects/${p.id}`)).statusCode).toBe(404)
  })

  it("with the desktop trash handler: hands it the project folder", async () => {
    const p = await store.createProject("Desktop trash")
    const got: string[] = []
    const fakeTrash = join(home, "fake-os-trash")
    mkdirSync(fakeTrash, { recursive: true })
    manage.setTrashHandler(async (abs) => {
      got.push(abs)
      const { renameSync } = await import("node:fs")
      renameSync(abs, join(fakeTrash, p.id))
    })
    try {
      const r = await req("DELETE", `/api/projects/${p.id}`)
      expect(r.statusCode).toBe(200)
      expect(r.json()).toMatchObject({ trashed: true, where: "system", path: null })
      expect(got).toEqual([join(projectsDir, p.id)])
    } finally {
      manage.setTrashHandler(null)
    }
  })

  it("refuses ids that try to leave the projects folder", async () => {
    for (const bad of ["..", "..%2F..", "a%2Fb", ".trash", "%2E%2E"]) {
      const r = await req("DELETE", `/api/projects/${bad}`)
      expect([400, 404]).toContain(r.statusCode)
    }
    expect(existsSync(home)).toBe(true)
    expect(existsSync(projectsDir)).toBe(true)
  })

  it("refuses a project folder that is a link, and leaves its target alone", async () => {
    const target = join(home, "elsewhere")
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "project.json"), JSON.stringify({ id: "linked", name: "Linked", parts: [], tags: [] }))
    symlinkSync(target, join(projectsDir, "linked"))
    await expect(manage.trashProject("linked")).rejects.toMatchObject({ statusCode: 400 })
    expect(lstatSync(join(projectsDir, "linked")).isSymbolicLink()).toBe(true)
    expect(readdirSync(target)).toEqual(["project.json"])
  })

  it("a running print blocks it", async () => {
    const p = await store.createProject("Printing now")
    const rec = db.recordPrintStart({ projectId: p.id, machineId: null, partIds: ["main"], gcodeName: "main.gcode", printerFilename: null, estimatedTimeS: null, filamentG: null })
    const r = await req("DELETE", `/api/projects/${p.id}`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatch(/print/i)
    expect(existsSync(join(projectsDir, p.id, "project.json"))).toBe(true)
    db.recordPrintFinish(rec.id, "complete")
    expect((await req("DELETE", `/api/projects/${p.id}`)).statusCode).toBe(200)
  })

  it("a job waiting for approval or printing blocks it", async () => {
    const p = await store.createProject("Job printing")
    const jobs = await import("../jobs")
    jobs.setJobStatus(p.id, "job-1", "printing")
    expect((await req("DELETE", `/api/projects/${p.id}`)).statusCode).toBe(409)
    jobs.setJobStatus(p.id, "job-1", "done")
    expect((await req("DELETE", `/api/projects/${p.id}`)).statusCode).toBe(200)
  })
})
