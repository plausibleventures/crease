// Registry contract (R11a): the app's tools behave the same whatever runtime calls them. These drive the gates
// (approval, guide, slice review, job binding) through ToolRegistry.call directly: no Claude, no SDK.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { APPROVAL_REFUSAL, STALE_APPROVAL_REFUSAL, setApproved } from "../approval"
import { deps } from "../deps"
import { designRevision } from "../revision"
import { fileSha256, noteReviewed, previewFirstRefusal, readSliceRecord, sliceAgainRefusal } from "../review"
import { defineTool, studioTools, ToolRegistry, type ToolContext, type ToolResult } from "./index"

const P = "registry-test"
let root = ""
let parts: { id: string; file: string; qty: number; colors: string[] }[] = []
let assembly: unknown = null
const realDeps = { ...deps }
const caller = { projectId: P, sessionId: "s1", runId: "r1", runtime: "fake" }
const call = (name: string, input: unknown = {}) => studioTools.call(caller, name, input)
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")

const write = (rel: string, content: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "registry-"))
  parts = [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }]
  assembly = null
  write("parts/main.scad", "width = 20;\ncube(width);")
  write("project.json", JSON.stringify({ id: P, parts }))
  setApproved(P, false)
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => ({ id: P, parts }),
    readAssembly: async () => ({ assembly }),
    // The fake slicer writes G-code and reports its absolute path, as the real one does.
    slicePart: vi.fn(async (_p: string, partId: string) => {
      write(`build/${partId}.gcode`, `;LAYER:0\n; ${Math.random()}\n`)
      return { partId, gcodePath: join(root, `build/${partId}.gcode`), estimatedTime: "1m" }
    }),
    requestPrint: vi.fn(async () => ({ approved: true, filename: "main.gcode" })),
  })
})
afterEach(() => {
  Object.assign(deps, realDeps)
  setApproved(P, false)
  rmSync(root, { recursive: true, force: true })
})

describe("tool registry", () => {
  it("defines every studio tool once, with a description and a JSON Schema for other transports", () => {
    expect(studioTools.names()).toEqual([
      "share_plan",
      "list_parts",
      "render_part",
      "check_part",
      "export_part",
      "set_parameters",
      "set_orientation",
      "save_checkpoint",
      "slice_part",
      "slice_plate",
      "preview_slice",
      "printer_status",
      "list_machines",
      "read_printer_lessons",
      "add_printer_lesson",
      "read_print_outcomes",
      "set_target_machine",
      "save_loaded_filaments",
      "printer_snapshot",
      "request_print",
      "update_assembly",
      "render_assembly_step",
      "build_assembly_guide",
      "check_motion",
      "compare_ideas",
    ])
    for (const t of studioTools.list()) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(studioTools.jsonSchema(t.name)).toMatchObject({ type: "object" })
    }
    expect(studioTools.jsonSchema("slice_part")).toMatchObject({ required: ["partId"], properties: { partId: { type: "string" } } })
  })

  it("the context is the app's: input can't set the project, session or run", async () => {
    let seen: ToolContext | null = null
    const reg = new ToolRegistry([
      defineTool({
        name: "who",
        description: "who am I",
        input: { x: z.number() },
        handler: async (ctx, input) => {
          seen = ctx
          return { content: [{ type: "text", text: JSON.stringify(input) }] }
        },
      }),
    ])
    const r = await reg.call(caller, "who", { x: 1, projectId: "other", sessionId: "evil", runId: "x" })
    expect(textOf(r)).toBe('{"x":1}') // unknown keys dropped
    expect(seen).toMatchObject({ projectId: P, sessionId: "s1", runId: "r1", runtime: "fake", revision: designRevision(P) })
    expect(Object.isFrozen(seen)).toBe(true)
    // a bound view reads the caller at each call
    let run = "a"
    const bound = reg.bind(() => ({ ...caller, runId: run }))
    await bound.call("who", { x: 2 })
    expect(seen!.runId).toBe("a")
    run = "b"
    await bound.call("who", { x: 3 })
    expect(seen!.runId).toBe("b")
  })

  it("unknown tools, invalid input and thrown errors come back as readable tool errors", async () => {
    expect(await call("nope")).toMatchObject({ isError: true, content: [{ text: "Error: Unknown tool nope." }] })
    const bad = await call("slice_part", { partId: 3 })
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/Invalid input for slice_part/)
    const reg = new ToolRegistry([defineTool({ name: "boom", description: "throws", input: {}, handler: async () => Promise.reject(new Error("kaput")) })])
    expect(await reg.call(caller, "boom", {})).toEqual({ content: [{ type: "text", text: "Error: kaput" }], isError: true })
  })

  it("results are project-relative", async () => {
    setApproved(P, true)
    const r = await call("slice_part", { partId: "main" })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('"gcodePath": "build/main.gcode"')
    expect(textOf(r)).not.toContain(root)
  })
})

describe("gates through the registry (any runtime)", () => {
  it("approval: slicing waits for the user's approval of this revision", async () => {
    expect(await call("slice_part", { partId: "main" })).toMatchObject({ isError: true, content: [{ text: `Error: ${APPROVAL_REFUSAL}` }] })
    expect(await call("slice_plate", {})).toMatchObject({ isError: true, content: [{ text: `Error: ${APPROVAL_REFUSAL}` }] })
    expect(deps.slicePart).not.toHaveBeenCalled()
    setApproved(P, true)
    write("parts/main.scad", "width = 30;\ncube(width);") // any change after approval
    expect(await call("slice_part", { partId: "main" })).toMatchObject({ isError: true, content: [{ text: `Error: ${STALE_APPROVAL_REFUSAL}` }] })
    expect(await call("request_print", { gcodePath: "build/main.gcode" })).toMatchObject({ content: [{ text: `Error: ${STALE_APPROVAL_REFUSAL}` }] })
  })

  it("set_parameters withdraws approval (geometry changed)", async () => {
    setApproved(P, true)
    const r = await call("set_parameters", { partId: "main", values: { width: 25 } })
    expect(textOf(r)).toContain('"width": 25')
    expect(await call("slice_part", { partId: "main" })).toMatchObject({ isError: true })
  })

  it("set_parameters writes a shared setting where it is declared, for every part that has it", async () => {
    parts = [
      { id: "pot", file: "parts/pot.scad", qty: 1, colors: [] },
      { id: "saucer", file: "parts/saucer.scad", qty: 1, colors: [] },
    ]
    write("project.json", JSON.stringify({ id: P, parts }))
    write("lib/params.scad", "wall = 2;\n")
    write("parts/pot.scad", "include <../lib/params.scad>\nclearance = 0.3;\npot_h = 80;\ncube(pot_h);\n")
    write("parts/saucer.scad", "include <../lib/params.scad>\nclearance = 0.3;\nsaucer_d = 120;\ncube(saucer_d);\n")
    // a saved slider value would hide the new design value: it goes
    const { saveOverrides, partOverridesAt } = await import("../../projects/revision")
    saveOverrides(root, "pot", { wall: 3, pot_h: 90 })
    const r = await call("set_parameters", { partId: "pot", values: { wall: 2.4, clearance: 0.35, pot_h: 85 } })
    const out = JSON.parse(textOf(r))
    expect(out).toMatchObject({ updated: { wall: 2.4, clearance: 0.35, pot_h: 85 }, missing: [], sharedWith: ["saucer"] })
    expect(out.files.sort()).toEqual(["lib/params.scad", "parts/pot.scad", "parts/saucer.scad"])
    expect(out.clearedSavedValues.sort()).toEqual(["pot_h", "wall"])
    expect(readFileSync(join(root, "lib/params.scad"), "utf8")).toContain("wall = 2.4;")
    expect(readFileSync(join(root, "parts/saucer.scad"), "utf8")).toContain("clearance = 0.35;")
    expect(readFileSync(join(root, "parts/saucer.scad"), "utf8")).toContain("saucer_d = 120;")
    expect(partOverridesAt(root, "saucer")).toBeNull()
    expect(partOverridesAt(root, "pot")).toBeNull()
  })

  it("set_orientation rotates through the .scad and withdraws approval (how it sits changed)", async () => {
    setApproved(P, true)
    deps.setPartOrientation = vi.fn(async () => ({ file: "parts/main.scad", rotate: [90, 0, 0] as [number, number, number] }))
    const r = await call("set_orientation", { partId: "main", rotate: [90, 0, 0] })
    expect(deps.setPartOrientation).toHaveBeenCalledWith(P, "main", [90, 0, 0])
    expect(textOf(r)).toContain("render_part, then check_part")
    expect(await call("slice_part", { partId: "main" })).toMatchObject({ isError: true })
  })

  it("guide: a build with hardware needs its picture guide before slicing", async () => {
    setApproved(P, true)
    assembly = { parts: [{ id: "main" }], hardware: [{ id: "s" }], consumables: [], motions: [], steps: [] }
    const r = await call("slice_part", { partId: "main" })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/needs its picture guide and shopping list/)
    expect(deps.slicePart).not.toHaveBeenCalled()
  })

  it("slice review + job binding: request_print needs the agent's own slice of this revision, previewed, and prints those bytes", async () => {
    setApproved(P, true)
    write("build/main.gcode", ";sliced from the toolbar")
    expect(textOf(await call("request_print", { gcodePath: "build/main.gcode" }))).toBe(`Error: ${sliceAgainRefusal("build/main.gcode")}`)
    await call("slice_part", { partId: "main" })
    const sha = fileSha256(join(root, "build/main.gcode"))
    expect(readSliceRecord(P, sha)?.designRevision).toBe(designRevision(P)) // tied to the revision it was sliced from
    expect(textOf(await call("request_print", { gcodePath: "build/main.gcode" }))).toBe(`Error: ${previewFirstRefusal("build/main.gcode")}`)
    noteReviewed(P, sha, "build/main.gcode", ["top", "first"], [])
    const r = await call("request_print", { gcodePath: "build/main.gcode", machineId: "m1" })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse(textOf(r))).toMatchObject({ approved: true, gcodeSha256: sha, reviewedLayers: ["top", "first"] })
    // the job is bound to the reviewed bytes: the expected job id is the review's sha256
    expect(deps.requestPrint).toHaveBeenCalledWith(P, "build/main.gcode", "agent", "m1", sha)
  })
})
