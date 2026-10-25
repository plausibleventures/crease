import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { derivePhase, firstLayerOffset, jobConsole, newPhaseMemory, type OurJob, type PhaseInput } from "./phase"

interface Step {
  t: number
  status: PhaseInput["status"]
  ws?: PhaseInput["ws"]
  expect: string
  why?: string
  layer?: number
  noJob?: boolean // a poll from before our job started
}
interface Sequence {
  name: string
  job: OurJob | null
  steps: Step[]
}
const sequences = JSON.parse(readFileSync(join(__dirname, "fixtures/status/sequences.json"), "utf8")) as Sequence[]

describe("printer phase from recorded/reconstructed status sequences", () => {
  for (const seq of sequences) {
    it(seq.name, () => {
      const mem = newPhaseMemory()
      for (const s of seq.steps) {
        const r = derivePhase({ now: s.t, status: s.status, ws: s.ws ?? null, job: s.noJob ? null : seq.job }, mem)
        const at = `${seq.name} @${s.t}`
        expect(r.state, at).toBe(s.expect)
        if (s.why) expect(r.why, at).toBe(s.why)
        if (s.layer != null) expect(r.layer, at).toBe(s.layer)
      }
    })
  }

  it("the pre-R19 rule (layer < 1) would have missed Preparing on the warm start", () => {
    const warm = sequences.find((s) => s.name === "i7-warm-start-stale-layer")!
    const step = warm.steps[1]
    expect(step.status.virtual_sdcard?.layer).toBe(100) // what the old rule read → "printing"
    expect(derivePhase({ now: step.t, status: step.status, ws: step.ws, job: warm.job }, newPhaseMemory()).state).toBe("preparing")
  })

  it("never reports a layer past the total (the i7 said 51 of 50 on the last layer)", () => {
    const status = {
      print_stats: { state: "standby", filename: "box.gcode" },
      virtual_sdcard: { is_active: true, progress: 0.99, layer: 51, layer_count: 50 },
      idle_timeout: { state: "Printing" },
      pause_resume: { is_paused: false },
    }
    const r = derivePhase({ now: 0, status, ws: null, job: null }, newPhaseMemory())
    expect(r.state).toBe("printing")
    expect(r.layer).toBe(50)
    expect(r.totalLayers).toBe(50)
  })
})

describe("first layer offset", () => {
  it("finds OrcaSlicer's first ;LAYER_CHANGE after START_PRINT", () => {
    const g = "; header\n; total layer number: 100\nSTART_PRINT EXTRUDER_TEMP=220 BED_TEMP=55\nM8200 O\nG1 X120 Y0 E15\n;LAYER_CHANGE\n;Z:0.2\n"
    expect(firstLayerOffset(g)).toBe(g.indexOf(";LAYER_CHANGE"))
    expect(firstLayerOffset(Buffer.from(g))).toBe(g.indexOf(";LAYER_CHANGE"))
    expect(firstLayerOffset("G28\nG1 X1\n")).toBeNull()
    expect(firstLayerOffset("START\n;LAYER:0\nG1\n")).toBe(6)
  })
})

describe("job console", () => {
  const lines = [
    { message: 'SDCARD_PRINT_FILE FILENAME="old.gcode"', time: 100 },
    { message: "Done printing file", time: 900 },
    { message: "// print preparing", time: 1001 },
  ]
  it("ignores the previous job's lines on a warm start before our file shows up", () => {
    // we started at t=1000 s; the console still ends with the previous job's "Done printing file"
    expect(jobConsole(lines, 1000_000).map((l) => l.message)).toEqual(["// print preparing"])
  })
  it("starts at our selection line once it's there", () => {
    const more = [...lines, { message: 'SDCARD_PRINT_FILE FILENAME="new.gcode"', time: 1002 }, { message: "File selected", time: 1002 }, { message: "BOX_LOAD_MATERIAL", time: 1010 }]
    expect(jobConsole(more, 1000_000).map((l) => l.message)).toEqual(["File selected", "BOX_LOAD_MATERIAL"])
  })
  it("without a job of ours, uses the last selection", () => {
    expect(jobConsole(lines, null).map((l) => l.message)).toEqual(lines.map((l) => l.message))
  })
})
