import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Project } from "../../shared/types"

// config.ts reads PRINTSTUDIO_HOME at import time, so set it before importing the db module.
const home = mkdtempSync(join(tmpdir(), "printstudio-db-test-"))
process.env.PRINTSTUDIO_HOME = home
type DbModule = typeof import("./index")
let db: DbModule

function makeProject(p: Partial<Project> & { id: string; name: string }, transcripts: Record<string, unknown[]> = {}) {
  const root = join(home, "projects", p.id)
  mkdirSync(join(root, "parts"), { recursive: true })
  mkdirSync(join(root, "renders"), { recursive: true })
  mkdirSync(join(root, ".studio", "sessions"), { recursive: true })
  const project: Project = {
    createdAt: "2026-10-01T10:00:00.000Z",
    printer: "sparkx-i7",
    engine: "openscad",
    tags: [],
    parts: [],
    activeSessionId: null,
    sessions: [],
    source: null,
    ...p,
  }
  for (const pt of project.parts) writeFileSync(join(root, pt.file), "cube(10);\n")
  if (project.parts[0]) writeFileSync(join(root, "renders", `${project.parts[0].id}-iso.png`), "png")
  writeFileSync(join(root, "project.json"), JSON.stringify(project, null, 2))
  for (const [sid, lines] of Object.entries(transcripts)) {
    writeFileSync(
      join(root, ".studio", "sessions", `${sid}.jsonl`),
      lines.map((m, i) => JSON.stringify({ projectId: p.id, sessionId: sid, seq: i, ts: `2026-10-02T10:00:0${i}.000Z`, message: m })).join("\n") + "\n{torn",
    )
  }
  return project
}

beforeAll(async () => {
  makeProject(
    {
      id: "desk-cable-tray",
      name: "Desk cable tray",
      tags: ["organizer", "desk"],
      parts: [
        { id: "tray", file: "parts/tray.scad", qty: 1, colors: ["black"] },
        { id: "cable-clip", file: "parts/cable-clip.scad", qty: 4, colors: [] },
      ],
      sessions: [{ id: "s1", title: "Initial design", forkedFrom: null }],
      activeSessionId: "s1",
    },
    {
      s1: [
        { type: "user_input", text: "Make a tray that clamps under my desk for power bricks" },
        { type: "assistant", message: { content: [] } },
        { type: "result", subtype: "success", total_cost_usd: 0.42 },
      ],
    },
  )
  makeProject({
    id: "headphone-hook",
    name: "Headphone hook",
    tags: ["desk", "audio"],
    createdAt: "2026-10-03T10:00:00.000Z",
    parts: [{ id: "hook", file: "parts/hook.scad", qty: 1, colors: [] }],
  })
  makeProject({ id: "plant-pot", name: "Plant pot", tags: ["garden"] })
  db = await import("./index")
})

afterAll(() => {
  db?.closeDb()
  rmSync(home, { recursive: true, force: true })
})

describe("catalog index", () => {
  it("builds from the folders on first open", () => {
    db.getDb()
    expect(existsSync(join(home, "index.sqlite"))).toBe(true)
    const all = db.listCatalog({ sort: "name" })
    expect(all.map((p) => p.id)).toEqual(["desk-cable-tray", "headphone-hook", "plant-pot"])
    const tray = all[0]
    expect(tray.partCount).toBe(2)
    expect(tray.sessionCount).toBe(1)
    expect(tray.thumbnailUrl).toMatch(/^\/api\/projects\/desk-cable-tray\/artifacts\/renders\/tray-iso\.png\?v=\d+&bg=clear$/)
    expect(all[2].thumbnailUrl).toBeNull()
  })

  it("reads session stats from transcripts", () => {
    const [s] = db.listSessions("desk-cable-tray")
    expect(s).toMatchObject({
      id: "s1",
      title: "Initial design",
      messageCount: 3,
      costUsd: 0.42,
      createdAt: "2026-10-02T10:00:00.000Z",
      lastMessageAt: "2026-10-02T10:00:02.000Z",
    })
    expect(s.firstPrompt).toMatch(/power bricks/)
  })

  it("searches names, tags, part ids and session prompts", () => {
    const ids = (q: string) => db.listCatalog({ query: q }).map((p) => p.id).sort()
    expect(ids("headphone")).toEqual(["headphone-hook"])
    expect(ids("desk")).toEqual(["desk-cable-tray", "headphone-hook"])
    expect(ids("clip")).toEqual(["desk-cable-tray"]) // part id "cable-clip"
    expect(ids("power brick")).toEqual(["desk-cable-tray"]) // prefix match on first prompt
    expect(ids("garden")).toEqual(["plant-pot"])
    expect(ids("nothing-matches-this")).toEqual([])
    expect(ids('"; DROP TABLE projects; --')).toEqual([]) // quoted safely
    expect(db.listCatalog({ tag: "DESK" }).length).toBe(2)
    expect(db.listTags()[0]).toEqual({ tag: "desk", count: 2 })
  })

  it("records prints to the db and the project folder", () => {
    const rec = db.recordPrintStart({
      projectId: "desk-cable-tray",
      partIds: ["tray"],
      gcodeName: "tray.gcode",
      printerFilename: "desk-cable-tray_tray.gcode",
      estimatedTimeS: 960,
      filamentG: 6.6,
    })
    expect(db.openPrints().map((p) => p.id)).toEqual([rec.id])
    db.recordPrintFinish(rec.id, "complete")
    db.setPrintResult(rec.id, { result: "success", notes: "clean" })
    expect(db.openPrints()).toEqual([])
    expect(existsSync(join(home, "projects", "desk-cable-tray", ".studio", "prints", `${rec.id}.json`))).toBe(true)
    const tray = db.listCatalog({ query: "tray" })[0]
    expect(tray.lastPrint).toMatchObject({ id: rec.id, state: "complete", result: "success" })
    expect(db.listCatalog({ sort: "printed" })[0].id).toBe("desk-cable-tray")
  })

  it("touchSession updates counts and makes new prompts searchable", () => {
    db.touchSession("headphone-hook", "s2", { userPrompt: "Add a felt-lined cradle", lastMessageAt: "2026-10-04T00:00:00.000Z" })
    db.touchSession("headphone-hook", "s2", { costUsd: 0.1 })
    const [s] = db.listSessions("headphone-hook")
    expect(s).toMatchObject({ id: "s2", messageCount: 2, costUsd: 0.1, firstPrompt: "Add a felt-lined cradle" })
    expect(db.listCatalog({ query: "cradle" }).map((p) => p.id)).toEqual(["headphone-hook"])
  })

  it("deleting index.sqlite and reopening gives the same catalog", () => {
    // Make the transcript match what touchSession indexed, as the agent service would have written it.
    writeFileSync(
      join(home, "projects", "headphone-hook", ".studio", "sessions", "s2.jsonl"),
      [
        { ts: "2026-10-04T00:00:00.000Z", message: { type: "user_input", text: "Add a felt-lined cradle" } },
        { ts: "2026-10-04T00:00:05.000Z", message: { type: "result", total_cost_usd: 0.1 } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    )
    db.rebuildIndex()
    const snapshot = () => ({
      catalog: db.listCatalog({ sort: "name" }),
      tags: db.listTags(),
      sessions: ["desk-cable-tray", "headphone-hook", "plant-pot"].map((id) => db.listSessions(id)),
      prints: db.listPrints(),
      search: ["desk", "clip", "cradle", "power"].map((q) => db.listCatalog({ query: q }).map((p) => p.id)),
    })
    const before = snapshot()
    db.closeDb()
    for (const f of ["index.sqlite", "index.sqlite-wal", "index.sqlite-shm"]) rmSync(join(home, f), { force: true })
    const after = snapshot() // getDb() re-creates and rebuilds
    expect(after).toEqual(before)
    expect(after.prints).toHaveLength(1)
    expect(after.prints[0]).toMatchObject({ result: "success", notes: "clean", state: "complete" })
  })

  it("migrations are idempotent", () => {
    db.closeDb()
    const d = db.getDb()
    expect(d.pragma("user_version", { simple: true })).toBe(4)
    expect(d.pragma("journal_mode", { simple: true })).toBe("wal")
  })
})
