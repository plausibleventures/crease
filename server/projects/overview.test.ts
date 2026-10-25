// R12: the project overview's next action, composer suggestions and overall size.
import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OverviewPlate } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-overview-test-"))
process.env.PRINTSTUDIO_HOME = home

const { nextAction, suggestionsFor, assembledSize, placedBox, projectOverview, tooBigFor, staleDetail } = await import("./overview")
const store = await import("./store")
const { setApproved } = await import("../agent/approval")
const { stopPractice } = await import("../printer/practice")

afterAll(() => {
  stopPractice()
  rmSync(home, { recursive: true, force: true })
})

type NextInput = Parameters<typeof nextAction>[0]
const base: NextInput = {
  hasDesign: true,
  renderErrors: [],
  missingRenders: [],
  staleRenders: [],
  approved: false,
  multiPart: true,
  slice: { state: "none", reasons: [], kind: null },
  plates: [],
  nextPlate: null,
  guide: { steps: 3, exists: true },
  needsAssembly: true,
  lastPrint: null,
}
const plate = (n: number, status: OverviewPlate["status"]): OverviewPlate => ({
  plate: n,
  jobId: `j${n}`,
  status,
  partIds: ["a"],
  estimatedTimeS: 600,
  adjustedTime: null,
  filamentG: 5,
})
const sliced = (statuses: OverviewPlate["status"][], next: number | null): Partial<NextInput> => ({
  approved: true,
  slice: { state: "current", reasons: [], kind: "plate" },
  plates: statuses.map((s, i) => plate(i + 1, s)),
  nextPlate: next,
})

describe("nextAction", () => {
  it("walks the build journey: describe → slice → print each plate → assemble → feedback → again (approval is in the print dialog)", () => {
    expect(nextAction({ ...base, hasDesign: false }).kind).toBe("describe")
    expect(nextAction(base)).toMatchObject({ kind: "slice", label: "Slice it" })
    expect(nextAction({ ...base, approved: true })).toMatchObject({ kind: "slice", label: "Slice it" })
    expect(nextAction({ ...base, ...sliced(["pending", "pending", "pending"], 1) })).toMatchObject({ kind: "print", label: "Print plate 1 of 3", plate: 1 })
    expect(nextAction({ ...base, ...sliced(["done", "pending", "pending"], 2) })).toMatchObject({ label: "Print plate 2 of 3", plate: 2 })
    expect(nextAction({ ...base, ...sliced(["done", "printing", "pending"], 3) }).kind).toBe("printing")
    const last = { id: "p1", state: "complete" as const, startedAt: "", finishedAt: "", rated: false }
    expect(nextAction({ ...base, ...sliced(["done", "done", "done"], null), lastPrint: last })).toMatchObject({ kind: "assemble", label: "Put it together" })
    expect(nextAction({ ...base, ...sliced(["done"], null), needsAssembly: false, lastPrint: last })).toMatchObject({ kind: "feedback", printId: "p1" })
    expect(nextAction({ ...base, ...sliced(["done", "done", "done"], null), lastPrint: { ...last, rated: true } }).kind).toBe("again")
  })

  it("single plate says 'Print it'; a failed plate is offered again; a rejected one was never sent", () => {
    expect(nextAction({ ...base, ...sliced(["pending"], 1) }).label).toBe("Print it")
    expect(nextAction({ ...base, ...sliced(["failed"], 1) })).toMatchObject({ label: "Print it again", detail: "The last try didn't finish. Clear the bed first." })
    const rejected = nextAction({ ...base, ...sliced(["rejected"], 1) })
    expect(rejected).toMatchObject({ label: "Print it", detail: "You'll check the bed is clear first." })
    expect(nextAction({ ...base, ...sliced(["done", "rejected"], 2) }).label).toBe("Print plate 2 of 2")
    expect(nextAction({ ...base, ...sliced(["requested"], 1) }).kind).toBe("waiting")
  })

  it("render problems and out-of-date slices come first", () => {
    expect(nextAction({ ...base, renderErrors: ["a: boom"] }).kind).toBe("fix")
    expect(nextAction({ ...base, staleRenders: ["a"] }).kind).toBe("update")
    const stale = nextAction({ ...base, approved: true, slice: { state: "stale", reasons: ["parts/a.scad changed"], kind: "plate" } })
    expect(stale).toMatchObject({ kind: "slice", label: "Slice again and print", detail: "The design changed. Slice again." })
    expect(staleDetail(["print settings changed to display"])).toBe("Settings changed. Slice again.")
    expect(staleDetail(["the project now prints on Garage printer"])).toBe("The printer changed. Slice again.")
  })

  it("failures known before slicing come first: too big → Make it fit, failing check → Fix the problem, failed slice", () => {
    const big = tooBigFor("stand", [300, 90, 86], { name: "Practice printer", buildVolumeMm: [256, 256, 256] })
    expect(big).toMatchObject({ axis: "wide", sizeMm: 300, maxMm: 246 })
    expect(tooBigFor("stand", [90, 90, 86], { name: "Practice printer", buildVolumeMm: [256, 256, 256] })).toBeNull()
    const fit = nextAction({ ...base, tooBig: [big!] })
    expect(fit).toMatchObject({ kind: "fit", label: "Make it fit", detail: "Too big for Practice printer: 300 mm wide, max 246 mm.", partId: "stand" })
    // in the user's unit (UX round 2): inches when they chose inches
    expect(nextAction({ ...base, tooBig: [big!], units: "in" }).detail).toBe("Too big for Practice printer: 11.8 in wide, max 9.69 in.")
    // even with an old slice that is still current, a too-big part isn't sent to be printed
    expect(nextAction({ ...base, ...sliced(["pending"], 1), tooBig: [big!] }).kind).toBe("fit")
    expect(nextAction({ ...base, failingChecks: [{ partId: "a", rule: "manifold", message: "The shape has holes or gaps, so it can't print." }] })).toMatchObject({
      kind: "problem",
      label: "Fix the problem",
    })
    expect(nextAction({ ...base, sliceError: { message: "The part doesn't fit on the plate.", kind: "fit" } })).toMatchObject({ kind: "fit", detail: "The part doesn't fit on the plate." })
    expect(nextAction({ ...base, sliceError: { message: "No filament is set up on the printer.", kind: "colour" } })).toMatchObject({
      kind: "problem",
      detail: "Slicing didn't work. No filament is set up on the printer.",
    })
    // a print in progress still says "Watch it print"
    expect(nextAction({ ...base, ...sliced(["printing"], null), tooBig: [big!] }).kind).toBe("printing")
  })

  it("a practice print isn't rated: the next action skips 'How did it turn out?'", () => {
    const last = { id: "p1", state: "complete" as const, startedAt: "", finishedAt: "", rated: false, practice: true }
    expect(nextAction({ ...base, ...sliced(["done"], null), needsAssembly: false, lastPrint: last })).toMatchObject({ kind: "again", detail: "Practice print done. Nothing was printed." })
  })

  it("a current slice doesn't need approval first (the user sliced it themselves)", () => {
    expect(nextAction({ ...base, ...sliced(["pending"], 1), approved: false }).kind).toBe("print")
  })
})

describe("suggestionsFor", () => {
  const s = {
    hasDesign: true,
    name: "Key hook",
    tags: [],
    sizeMm: [40, 20, 30] as [number, number, number],
    partCount: 1,
    colors: ["white"],
    loaded: [
      { slot: 1, colorName: "White", colorHex: "#fff", material: "PLA", loaded: true },
      { slot: 2, colorName: "Blue", colorHex: "#00f", material: "PLA", loaded: true },
    ],
    hasScrews: false,
    hasGuide: false,
    multiPart: false,
    printed: false,
    lastProblem: null,
    outOfDate: false,
  }
  it("comes from the project: size, mounting, loaded colours, prints", () => {
    expect(suggestionsFor(s)).toEqual(["Make it bigger", "Add holes to screw it to the wall", "Try it in blue", "Add my name to it"])
    expect(suggestionsFor({ ...s, name: "Phone stand", sizeMm: [200, 90, 120], printed: true })).toEqual([
      "Make it smaller",
      "Add a hole for a screw",
      "Try it in blue",
      "Print another one",
    ])
    // not while it's printing: the chip would ask for a second copy of what's still on the bed
    expect(suggestionsFor({ ...s, printed: true, printing: true })).not.toContain("Print another one")
    expect(suggestionsFor({ ...s, lastProblem: "didnt_stick" })[0]).toMatch(/stick/)
    expect(suggestionsFor({ ...s, hasDesign: false })).toEqual([])
  })
})

describe("overall size", () => {
  it("rotates part boxes before moving them", () => {
    const r = placedBox([0, 0, 0], [10, 20, 2], [0, 0, 90], [5, 0, 0])
    expect(r.min.map((x) => Math.round(x))).toEqual([-15, 0, 0])
    expect(r.max.map((x) => Math.round(x))).toEqual([5, 10, 2])
  })
  it("unions the placed parts (lid on top of a box)", () => {
    const a = {
      parts: [],
      hardware: [],
      tools: [],
      consumables: [],
      steps: [],
      placements: [
        { part: "box", translate: [0, 0, 0] as [number, number, number] },
        { part: "lid", translate: [0, 0, 40] as [number, number, number] },
      ],
    }
    const boxes = { box: { min: [0, 0, 0] as [number, number, number], max: [80, 60, 40] as [number, number, number] }, lid: { min: [0, 0, 0] as [number, number, number], max: [80, 60, 5] as [number, number, number] } }
    expect(assembledSize(a, boxes)).toEqual([80, 60, 45])
    expect(assembledSize(a, { box: boxes.box, lid: null })).toBeNull()
  })
})

describe("projectOverview", () => {
  it("a blank new project has no design and asks to describe it; editing the part makes it a design to approve", async () => {
    const p = await store.createProject("Overview test")
    let o = await projectOverview(p.id)
    expect(o.hasDesign).toBe(false)
    expect(o.next.kind).toBe("describe")
    expect(o.suggestions).toEqual([])

    writeFileSync(join(store.projectDir(p.id), "parts/main.scad"), "cube([30, 20, 10]);\n")
    // pretend it rendered (the render record is what the overview reads)
    writeFileSync(
      join(store.projectDir(p.id), "build/main.render.json"),
      JSON.stringify({ hash: "x", stats: { bbox: { min: [0, 0, 0], max: [30, 20, 10] }, sizeMm: [30, 20, 10], volumeMm3: 6000, triangles: 12, bodies: 1, manifold: true }, images: [] }),
    )
    o = await projectOverview(p.id)
    expect(o.hasDesign).toBe(true)
    expect(o.size).toEqual({ mm: [30, 20, 10], basis: "part" })
    expect(o.printedCount).toBe(1)
    expect(o.materials.length).toBeGreaterThan(0)
    expect(o.suggestions).toContain("Make it bigger")
    // (validity says the render record doesn't match the source, so the next step is to update the preview)
    expect(["update", "slice"]).toContain(o.next.kind)
    setApproved(p.id, true)
    expect((await projectOverview(p.id)).approved).toBe(true)
  })
})
