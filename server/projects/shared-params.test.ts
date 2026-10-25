// Shared Customizer settings: a setting several parts use (an include<>d lib file's, or the same setting declared in
// several parts) has one value for every part that has it; part-only settings stay per part. Older projects' per-part
// values are joined on first read, and a note keeps what each part had when they differed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  clearOverrides,
  currentIdeaAt,
  dismissSharedNotes,
  paramLinksAt,
  partOverridesAt,
  saveOverrides,
  sharedNotesAt,
  SHARED_KEY,
} from "./revision"
import { applyParamSnapshot, paramSnapshotAt } from "./param-snapshot"

let root = ""
const write = (rel: string, content: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), content)
}
const parts = (...ids: string[]) =>
  write("project.json", JSON.stringify({ id: "t", parts: ids.map((id) => ({ id, file: `parts/${id}.scad`, qty: 1, colors: [] })) }))
const ideaDir = () => join(root, ".studio", "params", encodeURIComponent(currentIdeaAt(root)))
const legacy = (partId: string, params: Record<string, number>) => {
  mkdirSync(ideaDir(), { recursive: true })
  writeFileSync(join(ideaDir(), `${partId}.json`), JSON.stringify({ params }))
}
const stored = (partId: string) => JSON.parse(readFileSync(join(ideaDir(), `${partId}.json`), "utf8")).params

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ps-shared-params-"))
  write("lib/params.scad", "/* [Fit between parts] */\n// Wall thickness\nwall = 2; // [1:0.5:5]\n// Saucer rim height\nrim_h = 10;\n")
  write("parts/pot.scad", "include <../lib/params.scad>\n/* [Pot] */\npot_h = 80;\ncylinder(h = pot_h, r = 40);\n")
  write("parts/saucer.scad", "include <../lib/params.scad>\n/* [Saucer] */\nsaucer_d = 120;\ncylinder(h = rim_h, d = saucer_d);\n")
  parts("pot", "saucer")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("which settings are shared", () => {
  it("lib settings are shared by every part that includes them; own settings are the part's", () => {
    const l = paramLinksAt(root)
    expect(l.byName.get("wall")).toMatchObject({ parts: ["pot", "saucer"], shared: true, files: ["lib/params.scad"] })
    expect(l.byName.get("pot_h")).toMatchObject({ parts: ["pot"], shared: false, files: ["parts/pot.scad"] })
  })

  it("the same name in several parts is shared when the design values match, not when they differ", () => {
    write("parts/pot.scad", "/* [Fit] */\nclearance = 0.3;\nheight = 120;\ncube(height);\n")
    write("parts/saucer.scad", "/* [Fit] */\nclearance = 0.3;\nheight = 15;\ncube(height);\n")
    const l = paramLinksAt(root)
    expect(l.byName.get("clearance")).toMatchObject({ shared: true, files: ["parts/pot.scad", "parts/saucer.scad"] })
    expect(l.byName.get("height")?.shared).toBe(false)
  })

  it("an imported mesh's own scale is never shared", () => {
    write("parts/a.scad", "scale_percent = 100;\ncube(1);\n")
    write("parts/b.scad", "scale_percent = 100;\ncube(1);\n")
    write(
      "project.json",
      JSON.stringify({
        id: "t",
        parts: ["a", "b"].map((id) => ({ id, file: `parts/${id}.scad`, qty: 1, colors: [], imported: { kind: "mesh" } })),
      }),
    )
    expect(paramLinksAt(root).byName.get("scale_percent")).toBeUndefined()
    saveOverrides(root, "a", { scale_percent: 50 })
    expect(partOverridesAt(root, "b")).toBeNull()
  })
})

describe("saving", () => {
  it("a shared value changed on the pot applies to the saucer; the pot's own stays the pot's", () => {
    const r = saveOverrides(root, "pot", { wall: 3, pot_h: 90 })
    expect(r).toEqual({ changed: true, others: ["saucer"] })
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90, wall: 3 })
    expect(partOverridesAt(root, "saucer")).toEqual({ wall: 3 })
    // the saucer's own change leaves the shared one alone and touches no other part
    expect(saveOverrides(root, "saucer", { wall: 3, saucer_d: 130 })).toEqual({ changed: true, others: [] })
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90, wall: 3 })
    expect(partOverridesAt(root, "saucer")).toEqual({ saucer_d: 130, wall: 3 })
  })

  it("resetting a shared setting on one part resets it for all of them", () => {
    saveOverrides(root, "pot", { wall: 3, rim_h: 12, pot_h: 90 })
    expect(saveOverrides(root, "saucer", {}).others).toEqual(["pot"])
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90 })
    expect(partOverridesAt(root, "saucer")).toBeNull()
  })

  it("a part added later that includes the lib file gets the shared value", () => {
    saveOverrides(root, "pot", { wall: 3 })
    write("parts/lid.scad", "include <../lib/params.scad>\ncube(wall);\n")
    parts("pot", "saucer", "lid")
    expect(partOverridesAt(root, "lid")).toEqual({ wall: 3 })
  })

  it("when two parts stop sharing a setting, each keeps the value it had", () => {
    write("parts/pot.scad", "clearance = 0.3;\ncube(1);\n")
    write("parts/saucer.scad", "clearance = 0.3;\ncube(1);\n")
    saveOverrides(root, "pot", { clearance: 0.4 })
    expect(partOverridesAt(root, "saucer")).toEqual({ clearance: 0.4 })
    write("parts/saucer.scad", "clearance = 0.5;\ncube(1);\n") // now a different setting
    expect(partOverridesAt(root, "pot")).toEqual({ clearance: 0.4 })
    expect(partOverridesAt(root, "saucer")).toEqual({ clearance: 0.4 })
    saveOverrides(root, "saucer", {})
    expect(partOverridesAt(root, "pot")).toEqual({ clearance: 0.4 })
  })

  it("clearing (the designer set the design value) drops the shared value and the part's own", () => {
    saveOverrides(root, "pot", { wall: 3, pot_h: 90 })
    expect(clearOverrides(root, ["wall"]).sort()).toEqual(["wall"])
    expect(partOverridesAt(root, "saucer")).toBeNull()
    expect(clearOverrides(root, ["pot_h"], ["saucer"])).toEqual([])
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90 })
  })
})

describe("older projects (values saved per part)", () => {
  it("parts that disagree: the first part's value wins for all, and a note keeps what each had", () => {
    legacy("pot", { wall: 3, pot_h: 90 })
    legacy("saucer", { wall: 2.5 })
    expect(partOverridesAt(root, "saucer")).toEqual({ wall: 3 })
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90, wall: 3 })
    expect(stored("saucer")).toBeNull() // moved into the shared file
    expect(stored("pot")).toEqual({ pot_h: 90 })
    expect(sharedNotesAt(root)).toEqual([{ name: "wall", value: 3, was: { pot: 3, saucer: 2.5 } }])
    // changing it (or dismissing the note) forgets the note
    saveOverrides(root, "saucer", { wall: 2.5 })
    expect(sharedNotesAt(root)).toEqual([])
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90, wall: 2.5 })
  })

  it("one part set it and the other used the design value: both use the set one, no note", () => {
    legacy("saucer", { rim_h: 12 })
    expect(partOverridesAt(root, "pot")).toEqual({ rim_h: 12 })
    expect(sharedNotesAt(root)).toEqual([])
  })

  it("notes can be dismissed", () => {
    legacy("pot", { wall: 3 })
    legacy("saucer", { wall: 2.5 })
    expect(sharedNotesAt(root)).toHaveLength(1)
    dismissSharedNotes(root, ["wall"])
    expect(sharedNotesAt(root)).toEqual([])
    expect(partOverridesAt(root, "saucer")).toEqual({ wall: 3 })
  })
})

describe("versions remember shared values", () => {
  it("the snapshot carries them under @shared and restoring puts them back", () => {
    saveOverrides(root, "pot", { wall: 3, pot_h: 90 })
    const snap = paramSnapshotAt(root)
    expect(snap).toEqual({ pot: { pot_h: 90 }, [SHARED_KEY]: { wall: 3 } })
    saveOverrides(root, "saucer", { wall: 4, saucer_d: 100 })
    expect(applyParamSnapshot(root, snap)).toBe(true)
    expect(partOverridesAt(root, "saucer")).toEqual({ wall: 3 })
    expect(partOverridesAt(root, "pot")).toEqual({ pot_h: 90, wall: 3 })
  })

  it("an older version's per-part values are joined again when restored", () => {
    saveOverrides(root, "pot", { wall: 4 })
    applyParamSnapshot(root, { pot: { wall: 3 }, saucer: { wall: 2.5 } })
    expect(partOverridesAt(root, "saucer")).toEqual({ wall: 3 })
    expect(existsSync(join(ideaDir(), "@shared.json"))).toBe(true)
  })
})
