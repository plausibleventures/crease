import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  APPROVAL_REFUSAL,
  STALE_APPROVAL_REFUSAL,
  approvesDesign,
  asksToPrint,
  holdsPrint,
  isApproved,
  onQuestionsAnswered,
  onToolAllowed,
  onUserMessage,
  REVIEW_Q,
  setApproved,
  sliceOrPrintGate,
} from "./approval"
import { deps } from "./deps"
import { designRevision } from "./revision"

const P = "proj"
const REVIEW = "How does this look?"
const review = (answer: string) => onQuestionsAnswered(P, [{ question: REVIEW }], { [REVIEW]: answer })

// Every project id maps to its own temp folder with one part.
let base = ""
const realProjectDir = deps.projectDir
const dir = (id: string) => join(base, id)
const write = (id: string, rel: string, content: string) => {
  mkdirSync(join(dir(id), rel, ".."), { recursive: true })
  writeFileSync(join(dir(id), rel), content)
}
const newProject = (id: string) => {
  write(id, "parts/main.scad", "width = 40;\ncube(width);\n")
  write(id, "project.json", JSON.stringify({ id, parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: [] }] }))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "approval-"))
  Object.assign(deps, { projectDir: (id: string) => dir(id) })
  newProject(P)
  setApproved(P, false)
})
afterEach(() => {
  Object.assign(deps, { projectDir: realProjectDir })
  rmSync(base, { recursive: true, force: true })
})

describe("design approval gate (agent slice_part / slice_plate / request_print)", () => {
  it("refuses before approval", () => {
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    expect(sliceOrPrintGate("never-seen")).toBe(APPROVAL_REFUSAL)
  })

  it('allows after "Looks great" on the review question', () => {
    review("Looks great (Recommended)")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("other review answers don't approve, and revoke an earlier approval", () => {
    for (const a of ["Make it bigger", "Make it smaller", "Change something…", "Can the hooks be longer?", "Looks good but make it taller", "Looks great, don't print it yet"]) {
      review(a)
      expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    }
    review("Looks great")
    review("Make it smaller")
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
  })

  it("discovery answers don't approve unless they ask to print", () => {
    onQuestionsAnswered(P, [{ question: "Where will it live?" }], { "Where will it live?": "On my desk (Recommended)" })
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    onQuestionsAnswered(P, [{ question: "Anything else?" }], { "Anything else?": "No, just print it" })
    expect(sliceOrPrintGate(P)).toBeNull()
    onQuestionsAnswered(P, [{ question: "Anything else?" }], { "Anything else?": "Hold off on printing for now" })
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
  })

  it('allows after a user message like "print it"', () => {
    onUserMessage(P, "make me a phone stand")
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    onUserMessage(P, "print it")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it('"Please do not print it yet" doesn\'t approve, and withdraws an earlier approval', () => {
    onUserMessage(P, "Please do not print it yet")
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    review("Looks great")
    expect(sliceOrPrintGate(P)).toBeNull()
    onUserMessage(P, "Actually wait, don't print it yet")
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
  })

  it("chat that doesn't mention printing leaves approval alone (edits are caught by the revision)", () => {
    review("Looks great")
    onUserMessage(P, "thanks!")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("resets after a .scad write (Write/Edit), but not after other writes", () => {
    review("Looks great")
    onToolAllowed(P, "Write", { file_path: "/x/projects/p/notes.md" })
    expect(sliceOrPrintGate(P)).toBeNull()
    onToolAllowed(P, "Edit", { file_path: "/x/projects/p/parts/main.scad" })
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)

    onUserMessage(P, "print it")
    onToolAllowed(P, "Write", { file_path: "lib/params.scad" })
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
  })

  it("resets after set_parameters (by short or MCP name)", () => {
    review("Looks great")
    onToolAllowed(P, "mcp__studio__set_parameters", { partId: "main", values: { width: 120 } })
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
    review("Looks great")
    onToolAllowed(P, "set_parameters", {})
    expect(sliceOrPrintGate(P)).toBe(APPROVAL_REFUSAL)
  })

  it("read-only tools and renders don't reset", () => {
    review("Looks great")
    onToolAllowed(P, "Read", { file_path: "parts/main.scad" })
    onToolAllowed(P, "Bash", { command: "ls parts" })
    onToolAllowed(P, "mcp__studio__render_part", { partId: "main" })
    onToolAllowed(P, "mcp__studio__check_part", { partId: "main" })
    expect(sliceOrPrintGate(P)).toBeNull()
  })
})

describe("approval is tied to the design revision, whatever changes it", () => {
  it("a change no tool reported (Bash sed, the user's editor, Customizer) makes approval stale", () => {
    review("Looks great")
    write(P, "parts/main.scad", "width = 120;\ncube(width);\n") // nobody called onToolAllowed
    expect(isApproved(P)).toBe(false)
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
    // putting the exact approved content back is the approved design again
    write(P, "parts/main.scad", "width = 40;\ncube(width);\n")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("covers included lib/ files, Customizer overrides, the parts list (qty, colours) and new parts", () => {
    write(P, "parts/main.scad", 'include <common.scad>\nwidth = 40;\ncube(width);\n')
    write(P, "lib/common.scad", "module rim() {}")
    const changes: [string, string][] = [
      ["lib/common.scad", "module rim() { cube(2); }"], // found via lib/
      ["build/main.render.json", JSON.stringify({ hash: "x", params: { width: 60 } })], // the user's Customizer value
      ["project.json", JSON.stringify({ id: P, parts: [{ id: "main", file: "parts/main.scad", qty: 4, colors: [] }] })],
      ["project.json", JSON.stringify({ id: P, parts: [{ id: "main", file: "parts/main.scad", qty: 4, colors: ["red"] }] })],
      ["parts/extra.scad", "sphere(5);"],
      ["project.json", JSON.stringify({ id: P, parts: [{ id: "main", file: "parts/main.scad", qty: 4, colors: ["red"] }, { id: "extra", file: "parts/extra.scad", qty: 1, colors: [] }] })],
      ["parts/extra.scad", "sphere(6);"],
    ]
    for (const [rel, content] of changes) {
      review("Looks great")
      expect(sliceOrPrintGate(P)).toBeNull()
      write(P, rel, content)
      if (rel === "parts/extra.scad" && !content.includes("6")) {
        expect(sliceOrPrintGate(P), "a .scad no part uses doesn't count").toBeNull()
        continue
      }
      expect(sliceOrPrintGate(P), rel).toBe(STALE_APPROVAL_REFUSAL)
    }
  })

  const ASM = {
    title: "Key hook",
    parts: [{ id: "main", qty: 1, color: "black" }],
    hardware: [],
    tools: [],
    consumables: [],
    steps: [{ n: 1, title: "Print", adds: ["main"], text: "Print the hook." }],
  }

  it("building the picture guide after approval keeps it (hardware, steps, assembly.scad, generated lib files)", () => {
    // approved with no assembly.json at all (a one-part hook); the guide comes after "Looks great"
    review("Looks great")
    expect(sliceOrPrintGate(P)).toBeNull()
    write(P, "assembly.json", JSON.stringify(ASM))
    expect(sliceOrPrintGate(P)).toBeNull()
    // update_assembly: hardware list, tools, steps text, title/notes
    const guide = {
      ...ASM,
      title: "Key hook by the door",
      summary: "Screw it to the wall.",
      parts: [{ id: "main", qty: 1, color: "black", name: "Hook", notes: "print flat" }],
      hardware: [{ id: "screw", type: "wall-anchor", qty: 2, size: "6x30", purchaseHint: "6x30 wall plug" }],
      tools: [{ id: "drill", type: "drill", name: "Drill" }],
      consumables: [],
      steps: [
        { n: 1, title: "Drill", adds: [], text: "Drill two holes." },
        { n: 2, title: "Hang", adds: ["main", "screw"], text: "Screw the hook on." },
      ],
      hardwarePlacements: [{ hardware: "screw", instance: 0, translate: [0, 0, 0] }],
    }
    write(P, "assembly.json", JSON.stringify(guide, null, 2))
    // build_assembly_guide: assembly.scad, generated lib files, guide output
    onToolAllowed(P, "Write", { file_path: "/x/projects/proj/assembly.scad" })
    write(P, "assembly.scad", "include <lib/studio_assembly.scad>\nat(\"main\");\n")
    write(P, "lib/studio_assembly.scad", "module at(id) {}")
    write(P, "lib/studio_assembly_data.scad", "// generated")
    write(P, "build/assembly-guide.html", "<html>")
    write(P, "build/shopping-list.md", "- 2 wall plugs")
    write(P, "build/assembly.json.stamp", "{}")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("a colour change (project parts list, .scad or an assembled build), placement or motion change resets approval", () => {
    const PLACED = { ...ASM, placements: [{ part: "main", translate: [0, 0, 0] }] }
    write(P, "assembly.json", JSON.stringify(PLACED))
    const changes = [
      { ...PLACED, parts: [{ id: "main", qty: 1, color: "white" }] },
      { ...PLACED, parts: [{ id: "main", qty: 1, color: "white" }], placements: [{ part: "main", translate: [0, 0, 5] }] },
      {
        ...PLACED,
        parts: [{ id: "main", qty: 1, color: "white" }],
        placements: [{ part: "main", translate: [0, 0, 5] }],
        motions: [{ id: "m", label: "Swings", type: "rotate", parts: ["main"], axis: [0, 0, 1], range: [0, 90] }],
      },
    ]
    for (const a of changes) {
      review("Looks great")
      expect(sliceOrPrintGate(P)).toBeNull()
      write(P, "assembly.json", JSON.stringify(a))
      expect(sliceOrPrintGate(P), JSON.stringify(a).slice(0, 80)).toBe(STALE_APPROVAL_REFUSAL)
    }
    // the part's colour in the project's parts list (what the 3D view and the slicer use)
    review("Looks great")
    write(P, "project.json", JSON.stringify({ id: P, parts: [{ id: "main", file: "parts/main.scad", qty: 1, colors: ["Red PLA"] }] }))
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
    // a colour in the .scad (color("red"))
    review("Looks great")
    write(P, "parts/main.scad", 'width = 40;\ncolor("red") cube(width);\n')
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
    // invalid JSON counts as a change too (conservative)
    review("Looks great")
    write(P, "assembly.json", "{ not json")
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
  })

  it("outputs and app state don't count (build/, renders/, .studio/, notes)", () => {
    review("Looks great")
    write(P, "build/main.stl", "solid x")
    write(P, "build/main.gcode", ";gcode")
    write(P, "renders/main-iso.png", "png")
    write(P, ".studio/checks/main.json", "{}")
    write(P, "notes.md", "hello")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("a checkpoint restore / branch switch to a different design makes approval stale", () => {
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir(P), stdio: "pipe" })
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-qm", "v1")
    git("checkout", "-qb", "taller")
    write(P, "parts/main.scad", "width = 40;\ncube([width, width, 90]);\n")
    git("commit", "-qam", "taller")
    review("Looks great") // approved the taller variant
    expect(sliceOrPrintGate(P)).toBeNull()
    git("checkout", "-q", "main")
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
    git("checkout", "-q", "taller")
    expect(sliceOrPrintGate(P)).toBeNull()
  })

  it("the revision is stable and content-based", () => {
    const a = designRevision(P)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(designRevision(P)).toBe(a)
    expect(designRevision("other")).not.toBeNull() // empty / missing folder still hashes
  })
})

// Phrase table: [text, asks to print?]. Prefer false negatives: when unsure the agent just asks.
const PHRASES: [string, boolean][] = [
  // plain requests
  ["print it", true],
  ["Print it!", true],
  ["Send it to the printer", true],
  ["slice it please", true],
  ["just make it and print", true],
  ["Yes, print it", true],
  ["ok, print both please", true],
  ["No, just print it", true],
  ["Looks great — print both", true],
  ["Perfect. Go ahead and print", true],
  ["let's print it", true],
  ["start the print", true],
  ["make me a dragon and print it", true],
  // polite questions aimed at the agent count
  ["Looks great — can you print both on the same plate?", true],
  ["Can you print it?", true],
  ["could you please send it to the printer?", true],
  ["Love it. Would you print two of them?", true],
  // negations and hesitation
  ["Please do not print it yet", false],
  ["don't print it", false],
  ["Don’t print it yet", false],
  ["dont print it", false],
  ["No, don't print it", false],
  ["never print it without asking me", false],
  ["not yet, print it later", false],
  ["Before you print it, make the walls thicker", false],
  ["Wait, print it?", false],
  ["wait", false],
  ["Hold off on printing it", false],
  ["hold on, print it after I check the size", false],
  ["Print it — actually no", false],
  ["Looks good but make it bigger before you print it", false],
  ["make it bigger first, then print it", false],
  ["maybe print it", false],
  ["if it fits, print it", false],
  ["cancel, don't send it to the printer", false],
  ["stop, I don't want to print this", false],
  // questions that aren't requests
  ["Should I print it?", false],
  ["Is it ready to print?", false],
  ["Can I print it on my printer?", false],
  ["How long will it take to print it?", false],
  ["What happens when you print it?", false],
  // mentions of printing, not requests
  ["make me a phone stand", false],
  ["make me something I can print", false],
  ["what can my printer do?", false],
  ["How do these look?", false],
  ["", false],
]

describe("asksToPrint phrase table", () => {
  for (const [text, want] of PHRASES) {
    it(`${want ? "asks" : "doesn't ask"}: ${JSON.stringify(text)}`, () => expect(asksToPrint(text)).toBe(want))
  }
  it("holdsPrint: talks about printing but holds back", () => {
    expect(holdsPrint("Please do not print it yet")).toBe(true)
    expect(holdsPrint("wait before slicing")).toBe(true)
    expect(holdsPrint("make it blue")).toBe(false)
    expect(holdsPrint("don't make it blue")).toBe(false)
    expect(holdsPrint("print it")).toBe(false)
    expect(holdsPrint("hold off on the print")).toBe(true)
    expect(holdsPrint("don't send it to the printer")).toBe(true)
    expect(holdsPrint("let's print it later")).toBe(true)
    expect(holdsPrint("not yet, don't slice it")).toBe(true)
  })
  it("holdsPrint: how to print isn't holding back (Cyberbear, 2026-10-17: these re-asked for an unchanged design)", () => {
    expect(holdsPrint("make sure the print is reliable. its okay if its slow.")).toBe(false)
    expect(holdsPrint("doesn't our design need careful and proper printing? please configure this properly.")).toBe(false)
    expect(holdsPrint("i think we need to remove that thin layer at the layer 1")).toBe(false)
  })
})

describe("review answers (\"How does this look?\")", () => {
  const table: [string, boolean][] = [
    ["Looks great (Recommended)", true],
    ["Looks great", true],
    ["looks good!", true],
    ["They look perfect", true],
    ["Looks great — can you print both on the same plate?", true],
    ["Looks great, print it", true],
    ["Looks good but make it bigger", false],
    ["Looks great, but don't print yet", false],
    ["Looks great, wait though", false],
    ["Looks right (Recommended)", true],
    ["Got it, looks great", true], // the designer's own option (Cyberbear, 2026-10-17)
    ["Yes, looks good but make it taller", false],
    ["Make it bigger", false],
    ["Make it smaller", false],
    ["Change something…", false],
    ["Can the hooks be longer?", false],
  ]
  for (const [a, want] of table) it(`${want ? "approves" : "doesn't approve"}: ${JSON.stringify(a)}`, () => expect(approvesDesign(a)).toBe(want))
})

describe("approval phrasing from real use", () => {
  it("accepts 'How do these look?' answered with a typed 'Looks great — can you print both…'", () => {
    const id = "p-phrasing-1"
    newProject(id)
    setApproved(id, false)
    const q = "Here are D and E. How do these look?"
    onQuestionsAnswered(id, [{ question: q }], { [q]: "Looks great — can you print both on the same plate?" })
    expect(isApproved(id)).toBe(true)
  })
  it("Codex's own wording: 'How does your phone stand look?' answered 'Looks right' approves (parity run 2026-10-11)", () => {
    const id = "p-phrasing-3"
    newProject(id)
    setApproved(id, false)
    for (const q of ["How does your phone stand look? The preview shows it lying on its side.", "How do these new photo-based fronts look?"]) {
      setApproved(id, false)
      onQuestionsAnswered(id, [{ question: q }], { [q]: "Looks right" })
      expect(isApproved(id)).toBe(true)
    }
    // a discovery question about looks is not a review
    expect(REVIEW_Q.test("How do you want it to look?")).toBe(false)
    expect(REVIEW_Q.test("How should the edges look?")).toBe(false)
  })
  it("a non-approving review answer still doesn't approve", () => {
    const id = "p-phrasing-2"
    newProject(id)
    setApproved(id, false)
    const q = "How do they look?"
    onQuestionsAnswered(id, [{ question: q }], { [q]: "Make it a bit bigger" })
    expect(isApproved(id)).toBe(false)
  })
})

describe("approval across a restart (R12 follow-up)", () => {
  it("is saved as the approved revision and re-validated after a restart", async () => {
    const { forgetApprovalsInMemory } = await import("./approval")
    review("Looks great")
    expect(JSON.parse(readFileSync(join(dir(P), ".studio/approval.json"), "utf8")).revision).toBe(designRevision(P))
    forgetApprovalsInMemory() // server restart
    expect(isApproved(P)).toBe(true)
    // the design changed while the app was closed: the saved approval is for an older version
    write(P, "parts/main.scad", "width = 50;\ncube(width);\n")
    forgetApprovalsInMemory()
    expect(isApproved(P)).toBe(false)
    expect(sliceOrPrintGate(P)).toBe(STALE_APPROVAL_REFUSAL)
  })

  it("withdrawing removes it; a garbled or linked file is not an approval", async () => {
    const { forgetApprovalsInMemory } = await import("./approval")
    review("Looks great")
    review("Make it bigger")
    expect(existsSync(join(dir(P), ".studio/approval.json"))).toBe(false)
    forgetApprovalsInMemory()
    expect(isApproved(P)).toBe(false)
    write(P, ".studio/approval.json", JSON.stringify({ revision: "yes", approved: true }))
    forgetApprovalsInMemory()
    expect(isApproved(P)).toBe(false)
    // a .studio/ that isn't a real folder is never trusted
    const other = "linked"
    newProject(other)
    const outside = mkdtempSync(join(tmpdir(), "approval-outside-"))
    writeFileSync(join(outside, "approval.json"), JSON.stringify({ revision: designRevision(other) }))
    rmSync(join(dir(other), ".studio"), { recursive: true, force: true })
    symlinkSync(outside, join(dir(other), ".studio"))
    forgetApprovalsInMemory()
    expect(isApproved(other)).toBe(false)
    rmSync(outside, { recursive: true, force: true })
  })
})
