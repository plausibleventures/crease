// R22: comparing ideas (branches) and saved versions, and switching ideas without losing either idea's chat.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Assembly, IdeaComparison, IdeaList } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "ps-compare-"))
process.env.PRINTSTUDIO_HOME = home

const { diffSides, summarize, estimateGrams, slicedNumbers, SHARED } = await import("./compare")
const { buildBom } = await import("../assembly/bom")

const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const US = { country: "US", stores: ["amazon-us" as const] }
const fixture = (): Assembly => JSON.parse(readFileSync(join(import.meta.dirname, "..", "assembly", "fixtures", "parts-bin", "assembly.json"), "utf8"))
const bomOf = (a: Assembly) =>
  buildBom({ project: { name: "x", parts: [] }, assembly: a, sourcing: US, have: {}, bin: [] }).items.map((i) => ({
    key: i.key,
    name: i.name,
    category: i.category,
    need: i.need,
    ...(i.needText ? { needText: i.needText } : {}),
  }))

describe("idea diff (pure)", () => {
  const part = (id: string, sizeMm: [number, number, number], qty = 1) => ({ id, name: id[0].toUpperCase() + id.slice(1), qty, colors: [], sizeMm, error: null })

  it("finds size, part, parameter and shopping-list differences and says them in one plain sentence", () => {
    const a = fixture()
    const b = fixture()
    b.hardware.find((h) => h.id === "magnet")!.qty = 6
    b.hardware = b.hardware.filter((h) => h.id !== "feet")
    b.hardware.push({ id: "screw", type: "screw", qty: 2, size: "M3x12", head: "button" })
    const d = diffSides(
      {
        size: { mm: [80, 60, 40], basis: "assembled" },
        parts: [part("base", [80, 60, 30]), part("lid", [80, 60, 3])],
        params: { base: { height: 30, wall: 2 }, [SHARED]: { box_h: 40 } },
        paramInfo: { base: { height: "Outer height (mm)" } },
        grams: 50,
        timeS: 3600,
        costUsd: 3,
        bom: bomOf(a),
      },
      {
        size: { mm: [80, 60, 52], basis: "assembled" },
        parts: [part("base", [80, 60, 42]), part("lid", [80, 60, 3]), part("divider", [76, 2, 30], 2)],
        params: { base: { height: 42, wall: 2 }, divider: { t: 2 }, [SHARED]: { box_h: 52 } },
        grams: 58.4,
        timeS: 4200,
        costUsd: 4.5,
        bom: bomOf(b),
      },
    )
    expect(d.sizeMm).toEqual([0, 0, 12])
    expect(d.parts.map((p) => [p.id, p.change])).toEqual([
      ["base", "resized"],
      ["lid", "same"],
      ["divider", "added"],
    ])
    // a new part's settings are part of "added", not listed one by one
    expect(d.params).toEqual([
      { partId: "base", name: "height", description: "Outer height (mm)", a: 30, b: 42 },
      { partId: SHARED, name: "box_h", a: 40, b: 52 },
    ])
    const byName = Object.fromEntries(d.bom.map((x) => [x.change + ":" + x.name.split(" ")[0], [x.a, x.b]]))
    expect(Object.keys(byName).sort()).toEqual(["added:M3", "changed:Magnet", "removed:Self-adhesive"].sort())
    expect(d.grams).toBeCloseTo(8.4)
    expect(d.timeS).toBe(600)
    const s = summarize(d)
    expect(s).toMatch(/^B is 12 mm taller, uses 8 g more filament, adds the divider/)
    expect(s).toMatch(/needs 2 × M3/)
    expect(s).toMatch(/needs 2 × M3 × 12 button head screw plus 2 more magnets \(6 × 3 mm\) and no longer needs 4 × Self-adhesive/)
    
  })

  it("the same design says so; a settings-only change says what changed", () => {
    const side = { size: { mm: [10, 10, 10] as [number, number, number], basis: "part" as const }, parts: [part("main", [10, 10, 10])], params: { main: { w: 10 } }, grams: 1, timeS: 60, costUsd: 0.02, bom: [] }
    expect(summarize(diffSides(side, side))).toBe("A and B are the same design.")
    const d = diffSides(side, { ...side, params: { main: { w: 10, label: "Bob" } } })
    expect(summarize(d)).toBe("B changes 1 setting (label).")
  })

  it("estimates grams from volume only when every part has one", () => {
    expect(estimateGrams([{ qty: 2, volumeMm3: 10_000 }])).toBeCloseTo(2 * 10 * 1.24 * 0.5)
    expect(estimateGrams([{ qty: 1, volumeMm3: null }])).toBeNull()
  })

  it("sliced totals add every part of a two-part build, at its quantity (E2E #2 P3)", () => {
    const stamp = (f: string) => ({ files: { [f]: "h" + f }, params: null })
    const sp = (id: string, qty: number) => ({ ...part(id, [10, 10, 10], qty), file: `parts/${id}.scad`, bbox: null, volumeMm3: 1000, params: {}, paramInfo: {}, stamp: stamp(id) })
    const job = (jid: string, parts: { partId: string; qty: number }[], g: number, kind: "part" | "plate" = "part") =>
      ({ id: jid, kind, parts, filamentG: g, estimatedTimeS: g * 60, createdAt: jid, source: { stamps: Object.fromEntries(parts.map((p) => [p.partId, stamp(p.partId)])) } }) as never
    const parts = [sp("base", 1), sp("lid", 2)]
    // per-part slices: base 10 g + lid 3 g × 2
    const per = [job("1", [{ partId: "base", qty: 1 }], 10), job("2", [{ partId: "lid", qty: 1 }], 3)]
    expect(slicedNumbers(per, null, parts as never)?.grams).toBe(16)
    // a plate set with both parts at the right quantities is used as is
    const plate = job("3", [{ partId: "base", qty: 1 }, { partId: "lid", qty: 2 }], 17, "plate")
    expect(slicedNumbers([...per, plate], ["3"], parts as never)?.grams).toBe(17)
    // a plate set with only one lid doesn't describe this side: per-part slices instead
    const short = job("4", [{ partId: "base", qty: 1 }, { partId: "lid", qty: 1 }], 13, "plate")
    expect(slicedNumbers([...per, short], ["4"], parts as never)?.grams).toBe(16)
  })
})

describe.skipIf(!existsSync(OPENSCAD))("ideas: compare, switch, stable references", () => {
  let app: FastifyInstance
  let id = ""
  let dir = ""
  let first = ""
  const inject = async <T,>(method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url: `/api/projects/${id}${url}`, ...(payload ? { payload } : {}) })
    if (r.statusCode !== 200) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`)
    return r.json() as T
  }
  const events = (sid: string, items: { ts: string; event: unknown }[]) => {
    mkdirSync(join(dir, ".studio", "sessions"), { recursive: true })
    writeFileSync(
      join(dir, ".studio", "sessions", `${sid}.jsonl`),
      items.map((x, i) => JSON.stringify({ schemaVersion: 1, eventId: String(i), seq: i, ts: x.ts, projectId: id, sessionId: sid, runId: "r", itemId: `i${i}`, revision: null, runtime: "fake", event: x.event })).join("\n") + "\n",
    )
  }
  const setBoxH = (h: number) => {
    const f = join(dir, "lib", "params.scad")
    writeFileSync(f, readFileSync(f, "utf8").replace(/^box_h = \d+;/m, `box_h = ${h};`))
  }

  beforeAll(async () => {
    const store = await import("./store")
    const routes = (await import("../routes/projects")).default
    app = Fastify()
    app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => reply.status(err.statusCode ?? 500).send({ error: err.message }))
    await app.register(routes)
    const p = await store.createProjectFromStarter(join(import.meta.dirname, "..", "..", "resources", "starters", "box-with-lid"), "Compare box")
    id = p.id
    dir = store.projectDir(id)
    first = await store.currentBranch(id)
    // the first idea's chat: a plan card and an ask
    const plan = { type: "tool.started", name: "mcp__studio__share_plan", input: { title: "Your box", bullets: ["80 × 60 mm", "lid on a filament hinge"] } }
    events("s1", [
      { ts: "2026-10-01T10:00:00.000Z", event: { type: "run.started", input: { text: "make me a box with a lid" } } },
      { ts: "2026-10-01T10:01:00.000Z", event: plan },
    ])
    await store.updateProject(id, { sessions: [{ id: "s1", title: "Design session", forkedFrom: null }], activeSessionId: "s1" })
  }, 60_000)
  afterAll(async () => {
    await app?.close()
    rmSync(home, { recursive: true, force: true })
  })

  it("tries another idea, keeps each idea's chat when switching back and forth", async () => {
    const store = await import("./store")
    const v = await inject<{ branch: string; sessionId: string | null }>("POST", "/variants", { title: "Taller box" })
    expect(v.branch).toBe("variant-1")
    // no runtime in tests to fork the chat: give the new idea its own chat, as the fork would (copied history + more)
    events("s2", [
      { ts: "2026-10-01T10:00:00.000Z", event: { type: "run.started", input: { text: "make me a box with a lid" } } },
      { ts: "2026-10-01T10:01:00.000Z", event: { type: "tool.started", name: "mcp__studio__share_plan", input: { title: "Your box", bullets: ["80 × 60 mm", "lid on a filament hinge"] } } },
      { ts: "2026-10-02T09:00:00.000Z", event: { type: "run.started", input: { text: "make it 12 mm taller for my pens" } } },
    ])
    const p = await store.getProject(id)
    await store.updateProject(id, { sessions: [...p.sessions, { id: "s2", title: "Taller box", forkedFrom: "s1", branch: "variant-1" }] })
    await inject("POST", "/sessions/s2/activate")
    setBoxH(52)
    await store.saveCheckpoint(id, "agent: make the box 12 mm taller")

    let ideas = await inject<IdeaList>("GET", "/ideas")
    expect(ideas.ideas.map((i) => [i.branch, i.name, i.current, i.sessionId])).toEqual([
      [first, "First idea", false, "s1"],
      ["variant-1", "Taller box", true, "s2"],
    ])
    expect(ideas.ideas[1].startedFrom?.idea).toBe("First idea")

    const back = await inject<{ sessionId: string | null; switched: boolean }>("POST", `/ideas/${first}/activate`)
    expect(back).toMatchObject({ sessionId: "s1", switched: true })
    expect(readFileSync(join(dir, "lib", "params.scad"), "utf8")).toMatch(/^box_h = 40;/m)
    expect((await store.getProject(id)).activeSessionId).toBe("s1")

    const again = await inject<{ sessionId: string | null }>("POST", "/ideas/variant-1/activate")
    expect(again.sessionId).toBe("s2")
    expect(readFileSync(join(dir, "lib", "params.scad"), "utf8")).toMatch(/^box_h = 52;/m)
    const after = await store.getProject(id)
    expect(after.sessions.map((s) => [s.id, s.branch])).toEqual([
      ["s1", first],
      ["s2", "variant-1"],
    ])
    // transcripts are app state: untouched by switching files
    expect(readFileSync(join(dir, ".studio", "sessions", "s2.jsonl"), "utf8")).toContain("12 mm taller")

    // renaming is a label only; the id stays
    ideas = (await app.inject({ method: "PATCH", url: `/api/projects/${id}/ideas/variant-1`, payload: { name: "Pen box" } })).json() as IdeaList
    expect(ideas.ideas.find((i) => i.branch === "variant-1")?.name).toBe("Pen box")
  }, 120_000)

  it("compares two ideas: same-camera pictures, sizes, settings and what only one side decided", async () => {
    const c = await inject<IdeaComparison>("GET", `/compare?a=${first}&b=variant-1`)
    expect(c.a.ref).toMatchObject({ kind: "idea", label: "First idea", branch: first })
    expect(c.b.ref).toMatchObject({ kind: "idea", label: "Pen box", branch: "variant-1", unsaved: false })
    expect(c.a.size?.basis).toBe("assembled")
    expect(c.diff.sizeMm?.[2]).toBeCloseTo(12, 0)
    expect(c.summary).toMatch(/^B is 12 mm taller/)
    expect(c.diff.params).toContainEqual(expect.objectContaining({ partId: SHARED, name: "box_h", a: 40, b: 52 }))
    expect(c.diff.parts.find((p) => p.id === "base")?.change).toBe("resized")
    expect(c.diff.bom).toEqual([])
    expect(c.b.filament.basis).toBe("estimate")
    expect(c.b.filament.grams!).toBeGreaterThan(c.a.filament.grams!)
    // shared history isn't a difference; the later ask and the saved change are B's own
    expect(c.a.decisions).toEqual([])
    expect(c.b.decisions.map((d) => [d.kind, d.text])).toEqual([
      ["ask", "make it 12 mm taller for my pens"],
      ["change", "make the box 12 mm taller"],
    ])
    for (const s of [c.a, c.b]) {
      expect(s.imageUrl).toMatch(/\/artifacts\/build\/compare\/.+\.png/)
      const img = await app.inject({ method: "GET", url: s.imageUrl! })
      expect(img.statusCode).toBe(200)
      expect(img.headers["content-type"]).toBe("image/png")
    }
    expect(c.a.modelUrl).toMatch(/scene\.3mf/)
    expect(c.frame?.radius).toBeGreaterThan(0)
  }, 180_000)

  it("version references stay put after new commits; idea references follow the idea", async () => {
    const store = await import("./store")
    const ideas = await inject<IdeaList>("GET", "/ideas")
    const shaA = ideas.ideas[0].tip.commit
    const shaB = ideas.ideas[1].tip.commit
    const before = await inject<IdeaComparison>("GET", `/compare?a=${shaA.slice(0, 7)}&b=${shaB}`)
    expect(before.b.ref).toMatchObject({ kind: "version", commit: shaB, idea: "Pen box" })

    setBoxH(60)
    await store.saveCheckpoint(id, "agent: even taller")
    const same = await inject<IdeaComparison>("GET", `/compare?a=${shaA.slice(0, 7)}&b=${shaB}`)
    expect(same.b.ref.commit).toBe(shaB)
    expect(same.summary).toBe(before.summary)
    expect(same.diff.params).toEqual(before.diff.params)

    const moved = await inject<IdeaComparison>("GET", `/compare?a=${first}&b=variant-1`)
    expect(moved.b.ref.commit).not.toBe(shaB)
    expect(moved.summary).toMatch(/^B is 20 mm taller/)
    // unsaved edits in the open idea are included when comparing "current"
    setBoxH(64)
    const now = await inject<IdeaComparison>("GET", `/compare?a=${first}&b=current`)
    expect(now.b.ref.unsaved).toBe(true)
    expect(now.summary).toMatch(/^B is 24 mm taller/)
  }, 240_000)

  it("the agent's compare_ideas tool reads the same comparison by idea name, without switching anything", async () => {
    const { studioTools } = await import("../agent/registry/index")
    const store = await import("./store")
    const before = await store.currentBranch(id)
    const r = await studioTools.call({ projectId: id, sessionId: "s2", runId: null, runtime: "fake" }, "compare_ideas", { a: "First idea", b: "Pen box" })
    expect(r.isError).toBeFalsy()
    const t = r.content[0].type === "text" ? r.content[0].text : ""
    expect(t).toMatch(/^A = First idea/)
    expect(t).toMatch(/Summary: B is 24 mm taller/)
    expect(t).toMatch(/\(shared\)\.box_h.*40 → 64/)
    expect(t).toContain("Ideas in this project:")
    expect(await store.currentBranch(id)).toBe(before)
  }, 120_000)
})
