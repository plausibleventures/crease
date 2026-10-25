import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "printstudio-model-test-"))
process.env.PRINTSTUDIO_HOME = home

const config = await import("../config")
const store = await import("../projects/store")
const agent = await import("./index")

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe("agent model switcher is per project", () => {
  it("switching in a project leaves the Settings default alone", async () => {
    config.saveSettings({ model: "opus" })
    const a = await store.createProject("Model A")
    const b = await store.createProject("Model B")
    await agent.setModel(a.id, "sonnet")
    expect((await store.getProject(a.id)).agentModel).toBe("sonnet")
    expect((await store.getProject(b.id)).agentModel).toBeUndefined()
    expect(config.getSettings().model).toBe("opus")
    // a workspace preference: kept out of the versioned project.json
    expect(readFileSync(join(store.projectDir(a.id), "project.json"), "utf8")).not.toContain("agentModel")
  })
})

describe("app notices without a live session", () => {
  it("go into the active session's transcript (shown on the next timeline load)", async () => {
    const p = await store.createProject("Notice")
    await agent.appendNotice(p.id, "no session yet") // nothing to write to: no-op
    expect(await agent.getTimeline(p.id)).toEqual([])
    await store.updateProject(p.id, { activeSessionId: "s-1" })
    await agent.appendNotice(p.id, "The print request was cancelled")
    await agent.appendNotice(p.id, "second")
    const tl = await agent.getTimeline(p.id)
    expect(tl.map((e) => [e.seq, (e.message as { type: string; text: string }).text])).toEqual([
      [0, "The print request was cancelled"],
      [1, "second"],
    ])
  })
})
