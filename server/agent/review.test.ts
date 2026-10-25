import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { APPROVAL_REFUSAL, STALE_APPROVAL_REFUSAL, setApproved } from "./approval"
import { deps } from "./deps"
import { designRevision } from "./revision"
import { assemblyStampAt } from "../projects/revision"
import { writeGuideStamp } from "../projects/validity"
import {
  fileSha256,
  noteReviewed,
  noteSliced,
  previewFirstRefusal,
  readSliceRecord,
  requestPrintGate,
  reviewQuestionGate,
  sliceAgainRefusal,
  sliceReviewGate,
} from "./review"

const P = "review-test"
let root = ""
let parts: { id: string; file: string; qty: number; colors: string[] }[] = []
let assembly: unknown = null
const realDeps = { ...deps }

const write = (rel: string, content: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), content)
}
/** Simulate the slicer writing G-code, then the agent's slice tool noting it (revision taken before slicing). */
const slice = (rel = "build/main.gcode", body = ";LAYER:0\nG1 X1\n") => {
  const rev = designRevision(P)
  write(rel, body)
  noteSliced(P, { gcodePath: rel, partId: "main" }, rev)
}
const preview = (rel = "build/main.gcode", issues = [{ code: "gap_infill_on_top", severity: "warn", layers: [41] }]) =>
  noteReviewed(P, fileSha256(join(root, rel)), rel, ["top", "first", 41], issues)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-"))
  parts = [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }]
  assembly = null
  write("parts/main.scad", "cube(20);")
  write("project.json", JSON.stringify({ id: P, parts }))
  Object.assign(deps, {
    projectDir: () => root,
    getProject: async () => ({ id: P, parts }),
    readAssembly: async () => ({ assembly }),
  })
})
afterEach(() => {
  Object.assign(deps, realDeps)
  rmSync(root, { recursive: true, force: true })
})

describe("slice review gate (request_print)", () => {
  it("refuses a G-code that doesn't exist or isn't in the project", () => {
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toMatch(/no build\/main.gcode yet.*Slice/)
    expect(sliceReviewGate(P, "../elsewhere/x.gcode").refusal).toMatch(/inside the project/)
    expect(sliceReviewGate(P, "parts/main.scad").refusal).toMatch(/inside the project/)
  })

  it("needs the agent's own slice, then a preview_slice of it", () => {
    write("build/main.gcode", ";sliced from the toolbar")
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBe(sliceAgainRefusal("build/main.gcode"))
    slice()
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBe(previewFirstRefusal("build/main.gcode"))
    preview()
    const r = sliceReviewGate(P, "build/main.gcode")
    expect(r.refusal).toBeNull()
    // logged: which layers were pictured and which issues were on screen
    expect(r.record?.reviews[0]).toMatchObject({ layersPictured: ["top", "first", 41], issues: [{ code: "gap_infill_on_top", severity: "warn", layers: [41] }] })
    expect(r.record?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("keys on the G-code bytes: a re-slice to the same path needs a fresh look", () => {
    slice()
    preview()
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBeNull()
    slice("build/main.gcode", ";LAYER:0\nG1 X2\n") // ironing on, say
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBe(previewFirstRefusal("build/main.gcode"))
    preview()
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBeNull()
  })

  it("a look at an earlier slice doesn't count for a later file, even one written outside the tools", () => {
    slice()
    preview()
    write("build/main.gcode", ";edited by hand")
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBe(sliceAgainRefusal("build/main.gcode"))
  })

  it("a design change after slicing means slicing again", () => {
    slice()
    preview()
    write("parts/main.scad", "cube(30);")
    expect(sliceReviewGate(P, "build/main.gcode").refusal).toBe(sliceAgainRefusal("build/main.gcode"))
  })

  it("plates: each plate needs its own look; path spelling doesn't matter", () => {
    const rev = designRevision(P)
    write("build/plate-1.gcode", ";plate 1")
    write("build/plate-2.gcode", ";plate 2")
    noteSliced(P, { plates: [{ plate: 1, gcodePath: "build/plate-1.gcode" }, { plate: 2, gcodePath: "build/plate-2.gcode" }] }, rev)
    preview("build/plate-1.gcode")
    expect(sliceReviewGate(P, "./build/plate-1.gcode").refusal).toBeNull()
    expect(sliceReviewGate(P, join(root, "build/plate-1.gcode")).refusal).toBeNull()
    expect(sliceReviewGate(P, "build/plate-2.gcode").refusal).toBe(previewFirstRefusal("build/plate-2.gcode"))
  })

  it("writes the record to .studio/slice-reviews/<sha256>.json", () => {
    slice()
    preview()
    const sha = fileSha256(join(root, "build/main.gcode"))
    const rec = JSON.parse(readFileSync(join(root, ".studio", "slice-reviews", `${sha}.json`), "utf8"))
    expect(rec).toMatchObject({ sha256: sha, gcodePath: "build/main.gcode", designRevision: designRevision(P) })
    expect(readSliceRecord(P, sha)?.reviews).toHaveLength(1)
  })
})

describe("requestPrintGate: everything that blocks, before the print dialog", () => {
  it("approval, a fresh approval after a change, the guide, then the slice review", async () => {
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBe(APPROVAL_REFUSAL)
    setApproved(P, true)
    slice()
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBe(previewFirstRefusal("build/main.gcode"))
    preview()
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBeNull()

    // it needs screws: the shopping list and guide aren't the design, so the approval and the slice still stand ...
    write("assembly.json", JSON.stringify({ parts: [{ id: "main", qty: 1, color: "black" }], hardware: [{ id: "s" }] }))
    assembly = { parts: [{ id: "main" }], hardware: [{ id: "s" }], consumables: [], motions: [], steps: [] }
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toMatch(/picture guide/)
    write("build/assembly-guide.html", "<html/>")
    write("assembly.scad", 'include <lib/studio_assembly.scad>\nat("main");\n')
    write("lib/studio_assembly_data.scad", "// generated")
    writeGuideStamp(root, assemblyStampAt(root, parts)) // built from the design as it is now (buildAssemblyGuide records this)
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBeNull()

    // ... but a geometry change after approval needs a fresh approval, and then a fresh slice
    write("parts/main.scad", "cube(21);")
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBe(STALE_APPROVAL_REFUSAL)
    setApproved(P, true)
    writeGuideStamp(root, assemblyStampAt(root, parts))
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBe(sliceAgainRefusal("build/main.gcode"))
    slice("build/main.gcode", ";v2")
    preview()
    expect((await requestPrintGate(P, "build/main.gcode")).refusal).toBeNull()
  })
})

describe('review question nudge: settle the guide before the first "How does this look?"', () => {
  const Q = [{ question: "How does this look?" }]
  it("passes other questions and builds that need no guide", async () => {
    expect(await reviewQuestionGate(P, [{ question: "What size?" }])).toBeNull()
    expect(await reviewQuestionGate(P, Q)).toBeNull()
  })

  it("turns the review back once when hardware needs a guide that isn't built; then lets it through", async () => {
    assembly = { parts: [{ id: "main" }], hardware: [{ id: "s" }], consumables: [], motions: [], steps: [] }
    write("assembly.json", JSON.stringify(assembly))
    const msg = await reviewQuestionGate(P, Q)
    expect(msg).toMatch(/^Before asking "How does this look\?": .*picture guide.*colours/s)
    expect(msg).not.toMatch(/then carry on/)
    expect(await reviewQuestionGate(P, Q)).toBeNull() // asked again at the same revision: no loop
    // a design change re-arms it
    write("parts/main.scad", "cube(25);")
    expect(await reviewQuestionGate(P, Q)).toMatch(/picture guide/)
    // with the guide built, the review goes straight through
    write("parts/main.scad", "cube(26);")
    write("build/assembly-guide.html", "<html/>")
    writeGuideStamp(root, assemblyStampAt(root, parts))
    expect(await reviewQuestionGate(P, Q)).toBeNull()
  })
})
