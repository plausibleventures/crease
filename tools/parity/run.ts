// Designer parity harness: drives the real server (HTTP + WS, like the UI) against each designer runtime with scripted
// user behaviour, and scores every session with objective checks (tools/parity/checks.ts) from its normalized events
// and project files.
//
//   npx tsx tools/parity/run.ts [--runtimes claude,codex,grok] [--scenarios open,interrupts,...] [--budget 15]
//                               [--claude-model sonnet] [--keep]
//
// One isolated stack: a temp PRINTSTUDIO_HOME, the server on :5874 and the mock printer on :7825 (never a real
// printer). Sign-ins are reused without reading them: Codex and Grok through their Crease homes
// (PRINTSTUDIO_CODEX_HOME / PRINTSTUDIO_GROK_HOME, default ~/PrintStudio/codex and ~/PrintStudio/grok), Claude through
// the user's own Claude Code login (subscription profile). Each scenario runs every runtime at once, each in its own
// project. Results: tools/parity/results/<stamp>/{results.json,report.md} (gitignored).
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentEventEnvelope, AgentQuestionRequest, PrintRequest } from "../../shared/types"
import { commonChecks, excerpt, facts, REVIEW_Q, usageOf, type Check, type Checks } from "./checks"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")
const argv = process.argv.slice(2)
const flag = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? "") : def
}
const PORT = Number(flag("port", "5874"))
const MOCK_PORT = Number(flag("mock-port", "7825"))
const BUDGET = Number(flag("budget", "15"))
const CLAUDE_MODEL = flag("claude-model", "sonnet")!
const CODEX_MODEL = flag("codex-model", "gpt-6.1-sol")!
const GROK_MODEL = flag("grok-model") ?? null
/** Reasoning effort per runtime profile, e.g. --effort grok=medium,codex=low (default: the runtime's own). */
const EFFORT = Object.fromEntries((flag("effort") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string]))
const RUNTIMES = (flag("runtimes", "claude,codex,grok") ?? "").split(",").filter(Boolean)
const SCENARIOS = flag("scenarios")?.split(",").filter(Boolean)
const KEEP = argv.includes("--keep")
/** Run the server from another checkout (e.g. an export of the previous commit, for a before/after comparison). */
const APP_ROOT = flag("app-root") ?? ROOT
const OPENSCAD = process.env.OPENSCAD ?? "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const QUIET_MS = 4000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// ---------------------------------------------------------------------------------------------
// Stack: mock printer + server (restartable), API, WebSocket fan-out
// ---------------------------------------------------------------------------------------------
type Listener = (e: Any) => void

class Stack {
  readonly home = mkdtempSync(join(tmpdir(), "printstudio-parity-"))
  readonly base = `http://127.0.0.1:${PORT}`
  private server: ChildProcess | null = null
  private mock: ChildProcess | null = null
  private ws: WebSocket | null = null
  private lastSpawned: ChildProcess | null = null
  readonly listeners = new Set<Listener>()
  serverLog: string[] = []

  env(): Record<string, string> {
    return {
      PRINTSTUDIO_HOME: this.home,
      PORT: String(PORT),
      PRINTSTUDIO_API_PORT: String(PORT),
      PRINTSTUDIO_WEB_PORT: String(PORT - 1),
      MOCK_PORT: String(MOCK_PORT),
      MOCK_PRINT_SECONDS: "5",
      LOG_LEVEL: "warn",
      PRINTSTUDIO_CODEX_HOME: process.env.PRINTSTUDIO_CODEX_HOME ?? join(homedir(), "PrintStudio", "codex"),
      PRINTSTUDIO_GROK_HOME: process.env.PRINTSTUDIO_GROK_HOME ?? join(homedir(), "PrintStudio", "grok"),
    }
  }

  private spawnTsx(script: string, label: string, ready: RegExp): Promise<ChildProcess> {
    const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs")
    const env: Record<string, string | undefined> = { ...process.env, ...this.env() }
    delete env.ANTHROPIC_API_KEY // Claude runs on the user's own Claude Code login, like the app's subscription profile
    const c = spawn(process.execPath, [tsx, script], { cwd: APP_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
    this.lastSpawned = c
    if (c.pid) SPAWNED.add(c.pid)
    c.on("exit", () => c.pid && SPAWNED.delete(c.pid))
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${label} did not start`)), 90_000)
      const on = (d: Buffer) => {
        const s = d.toString()
        if (label === "server") this.serverLog.push(...s.split("\n").filter(Boolean).map((l) => l.slice(0, 400)))
        if (this.serverLog.length > 4000) this.serverLog.splice(0, 1000)
        if (process.env.PARITY_DEBUG) process.stderr.write(`[${label}] ${s}`)
        if (ready.test(s)) {
          clearTimeout(t)
          res(c)
        }
      }
      c.stdout!.on("data", on)
      c.stderr!.on("data", on)
      c.on("exit", (code) => {
        clearTimeout(t)
        rej(new Error(`${label} exited ${code}`))
      })
    })
  }

  async start() {
    for (const p of [PORT, MOCK_PORT]) {
      if (await fetch(`http://127.0.0.1:${p}/`).then(() => true).catch(() => false)) throw new Error(`port ${p} is in use: pick others (--port/--mock-port)`)
    }
    this.mock = await this.spawnTsx("tools/mock-moonraker.ts", "mock", /listening/)
    await this.startServer()
  }

  async startServer() {
    let failed: Error | null = null
    const started = this.spawnTsx("server/index.ts", "server", /listening/i)
    started.catch((e) => (failed = e))
    let up = false
    for (let k = 0; k < 180 && !failed && !up; k++) {
      up = await fetch(`${this.base}/api/health`).then((r) => r.ok).catch(() => false)
      if (!up) await sleep(500)
    }
    if (!up) throw new Error(`the server didn't start: ${failed ?? "no health"}\n${this.serverLog.slice(-30).join("\n")}`)
    this.server = this.lastSpawned
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = rej
    })
    ws.onmessage = (m) => {
      let e: Any
      try {
        e = JSON.parse(String(m.data))
      } catch {
        return
      }
      for (const l of this.listeners) l(e)
    }
    this.ws = ws
  }

  get serverPid() {
    return this.server?.pid ?? null
  }

  async stopServer() {
    this.ws?.close()
    this.ws = null
    const s = this.server
    this.server = null
    if (!s?.pid) return
    const exited = new Promise<void>((r) => s.once("exit", () => r()))
    try {
      process.kill(-s.pid, "SIGTERM")
    } catch {
      /* gone */
    }
    await Promise.race([exited, sleep(15_000)])
    try {
      process.kill(-s.pid, "SIGKILL")
    } catch {
      /* gone */
    }
  }

  async restartServer() {
    await this.stopServer()
    await sleep(1500)
    await this.startServer()
  }

  async stop() {
    await this.stopServer()
    if (this.mock?.pid) {
      try {
        process.kill(-this.mock.pid, "SIGTERM")
      } catch {
        /* gone */
      }
    }
  }

  async api<T = Any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined })
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)?.slice(0, 300)}`)
    return data as T
  }
}

/** Process groups this harness started: killed if it exits any other way. */
const SPAWNED = new Set<number>()
process.on("exit", () => {
  for (const pid of SPAWNED) {
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      /* gone */
    }
  }
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Processes started for this stack (designer CLIs carry the temp home or the project path in their arguments/env). */
function stackProcesses(stack: Stack): { pid: number; cmd: string }[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  const rows = out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }))
  const root = stack.serverPid
  if (!root) return []
  const desc = new Set<number>([root])
  for (let changed = true; changed; ) {
    changed = false
    for (const r of rows) {
      if (desc.has(r.pid) || !desc.has(r.ppid)) continue
      desc.add(r.pid)
      changed = true
    }
  }
  return rows.filter((r) => desc.has(r.pid) && r.pid !== root)
}

/** A runtime's designer process, by its program's name (arguments mention other runtimes' paths, e.g. .claude/skills). */
const DESIGNER_CMD: Record<string, RegExp> = { codex: /^\S*\/codex\s.*app-server/, grok: /^\S*\/grok\s+agent\b/, claude: /^\S*\/claude(\s|$)/ }

// ---------------------------------------------------------------------------------------------
// Driver: one runtime in one project, acting like the UI and a user
// ---------------------------------------------------------------------------------------------
class Driver {
  events = new Map<string, AgentEventEnvelope>()
  sessionId: string | null = null
  running = false
  pendingQs = new Map<string, AgentQuestionRequest>()
  handledQs = new Set<string>()
  prints: PrintRequest[] = []
  handledPrints = new Set<string>()
  sent: string[] = []
  answerLines = new Set<string>()
  nudges = 0
  printed = false
  declined = 0
  lastEventAt = Date.now()
  notes: string[] = []
  checks: Checks = {}
  startedAt = Date.now()
  private waiters: (() => void)[] = []

  constructor(
    readonly stack: Stack,
    readonly runtime: string,
    readonly projectId: string,
    readonly scenario: string
  ) {
    stack.listeners.add((e) => this.onEvent(e))
  }

  log(s: string) {
    console.log(`[${this.scenario}/${this.runtime}] ${s}`)
  }

  private onEvent(e: Any) {
    if (e.type === "agent.event" && e.projectId === this.projectId) {
      const env = { ...e } as AgentEventEnvelope & { type?: string }
      delete env.type
      this.events.set(`${env.sessionId}:${env.seq}`, env)
      this.lastEventAt = Date.now()
    } else if (e.type === "agent.status" && e.projectId === this.projectId) {
      this.running = !!e.running
      this.sessionId = e.sessionId ?? this.sessionId
      this.lastEventAt = Date.now()
    } else if (e.type === "agent.question" && e.request?.projectId === this.projectId) {
      this.pendingQs.set(e.request.requestId, e.request)
      this.lastEventAt = Date.now()
    } else if (e.type === "agent.question.resolved" && e.projectId === this.projectId) {
      this.pendingQs.delete(e.requestId)
    } else if (e.type === "print.request" && e.request?.projectId === this.projectId) {
      this.prints.push(e.request)
      this.lastEventAt = Date.now()
    } else return
    for (const w of this.waiters.splice(0)) w()
  }

  /** Wait until `pred` holds (re-checked on every event and every second). */
  async until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const end = Date.now() + timeoutMs
    while (!pred()) {
      if (Date.now() > end) return false
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 1000)
      })
    }
    return true
  }

  list(): AgentEventEnvelope[] {
    return [...this.events.values()].sort((a, b) => a.seq - b.seq)
  }

  async refresh(): Promise<AgentEventEnvelope[]> {
    const evs = await this.stack.api<AgentEventEnvelope[]>("GET", `/api/projects/${this.projectId}/agent/events`).catch(() => null)
    if (evs) {
      this.events.clear()
      for (const e of evs) this.events.set(`${e.sessionId}:${e.seq}`, e)
    }
    return this.list()
  }

  openQuestion(): AgentQuestionRequest | null {
    return [...this.pendingQs.values()].find((q) => !this.handledQs.has(q.requestId)) ?? null
  }

  openPrint(): PrintRequest | null {
    return this.prints.find((p) => !this.handledPrints.has(p.requestId)) ?? null
  }

  /** Not working, nothing to answer, and quiet for a moment. */
  idle(): boolean {
    return !this.running && !this.openQuestion() && !this.openPrint() && Date.now() - this.lastEventAt > QUIET_MS
  }

  async send(text: string, images?: { mediaType: string; data: string }[]) {
    this.sent.push(text)
    this.log(`user: ${text}${images?.length ? " [+photo]" : ""}`)
    this.running = true
    this.lastEventAt = Date.now()
    await this.stack.api("POST", `/api/projects/${this.projectId}/agent/message`, { text, ...(images?.length ? { images } : {}) })
  }

  async answer(q: AgentQuestionRequest, answers: Record<string, string>, notes?: Record<string, string>) {
    this.handledQs.add(q.requestId)
    this.answerLines.add(Object.values(answers).map((a) => a.replace(/\s*\(recommended\)/gi, "")).join(" · "))
    this.log(`answer: ${q.questions.map((x) => x.question.slice(0, 60)).join(" | ")} -> ${Object.values(answers).join(" | ")}`)
    this.lastEventAt = Date.now()
    await this.stack.api("POST", `/api/projects/${this.projectId}/agent/answer`, { requestId: q.requestId, answers, ...(notes ? { notes } : {}) })
  }

  /** Stop, then wait for the runtime to close the run (the status goes idle at once; the run end follows). */
  async stop() {
    this.log("STOP")
    const ends = () => this.list().filter((e) => /^run\.(completed|failed|interrupted)$/.test(e.event.type)).length
    const starts = () => this.list().filter((e) => e.event.type === "run.started").length
    await this.stack.api("POST", `/api/projects/${this.projectId}/agent/stop`).catch((e) => this.log(String(e)))
    const closed = await this.until(() => ends() >= 1 && this.facts().runEnds.at(-1)!.seq > (this.facts().userTexts.at(-1)?.seq ?? -1), 30_000)
    if (!closed) this.notes.push(`Stop: no run end within 30 s (${starts()} runs started, ${ends()} ended)`)
    this.running = false
  }

  async print(p: PrintRequest, approve: boolean) {
    this.handledPrints.add(p.requestId)
    this.log(`print dialog (${p.gcodeName}) -> ${approve ? "Print" : "Cancel"}`)
    if (approve) this.printed = true
    else this.declined++
    this.lastEventAt = Date.now()
    await this.stack
      .api("POST", `/api/print-requests/${p.requestId}`, { approved: approve, bedClear: approve, ...(approve && p.needsApproval ? { approveDesign: true } : {}) })
      .catch((e) => this.log(`print answer failed: ${e}`))
  }

  facts() {
    return facts(this.list())
  }

  file(path: string): string | null {
    const p = join(this.stack.home, "projects", this.projectId, path)
    return existsSync(p) ? readFileSync(p, "utf8") : null
  }

  scad(): string {
    const dir = join(this.stack.home, "projects", this.projectId)
    const out: string[] = []
    for (const sub of ["parts", "lib"]) {
      const d = join(dir, sub)
      if (!existsSync(d)) continue
      for (const f of readdirSync(d)) if (f.endsWith(".scad")) out.push(`// ${sub}/${f}\n${readFileSync(join(d, f), "utf8")}`)
    }
    return out.join("\n")
  }

  check(name: string, ok: boolean | null, detail?: string) {
    this.checks[name] = { ok, ...(detail ? { detail } : {}) }
    if (ok === false) this.log(`CHECK FAIL ${name}${detail ? `: ${detail}` : ""}`)
  }
}

// ---------------------------------------------------------------------------------------------
// The user: answering cards, reviewing, the print dialog, nudging a designer that stopped
// ---------------------------------------------------------------------------------------------
const isReview = (q: AgentQuestionRequest) => q.questions.some((x) => REVIEW_Q.test(x.question))
const recommended = (q: AgentQuestionRequest["questions"][number]) => (q.options.find((o) => /\(recommended\)/i.test(o.label)) ?? q.options[0])?.label.replace(/\s*\(recommended\)\s*$/i, "") ?? "You decide"
const looksGreat = (q: AgentQuestionRequest["questions"][number]) => q.options.find((o) => /looks (great|good|right)|perfect|print it|yes/i.test(o.label))?.label.replace(/\s*\(recommended\)\s*$/i, "") ?? "Looks great"

interface Persona {
  /** Answers for a discovery card (default: the recommended option of each). */
  discovery?: (q: AgentQuestionRequest, d: Driver) => { answers: Record<string, string>; notes?: Record<string, string> }
  /** Replies to successive review cards; then "Looks great". */
  reviews?: string[]
  /** What to do with the print dialog. */
  print?: "approve" | "decline-once" | "stop"
  /** Stop when this is reached. */
  until: "review" | "approved" | "print-dialog" | "printed" | "idle"
  maxNudges?: number
  wallMs?: number
  /** Wait for the turn to end (or this long) before answering a discovery card. */
  lateMs?: number
}

type Outcome = "review" | "approved" | "print-dialog" | "printed" | "idle" | "stuck" | "timeout" | "failed"

async function autopilot(d: Driver, p: Persona): Promise<{ outcome: Outcome; review?: AgentQuestionRequest }> {
  // Grok 4.7 thinks for minutes between steps: same work, twice the wall time
  const end = Date.now() + (p.wallMs ?? 15 * 60_000) * (d.runtime === "grok" ? 2 : 1)
  const reviews = [...(p.reviews ?? [])]
  let approved = false
  for (;;) {
    const left = end - Date.now()
    if (left <= 0) return { outcome: "timeout" }
    const got = await d.until(() => !!d.openQuestion() || !!d.openPrint() || d.idle(), left)
    if (!got) return { outcome: "timeout" }
    const pr = d.openPrint()
    if (pr) {
      if (p.until === "print-dialog") return { outcome: "print-dialog" }
      const approve = p.print !== "decline-once" || d.declined > 0
      await d.print(pr, approve)
      if (approve && p.until === "printed") {
        await d.until(() => d.idle(), 5 * 60_000)
        return { outcome: "printed" }
      }
      continue
    }
    const q = d.openQuestion()
    if (q) {
      if (isReview(q)) {
        if (p.until === "review") return { outcome: "review", review: q }
        const fb = reviews.shift()
        const answers: Record<string, string> = {}
        for (const x of q.questions) answers[x.question] = fb && REVIEW_Q.test(x.question) ? fb : REVIEW_Q.test(x.question) ? looksGreat(x) : recommended(x)
        await d.answer(q, answers, fb ? Object.fromEntries(q.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])) : undefined)
        if (!fb) {
          approved = true
          if (p.until === "approved") return { outcome: "approved" }
        }
      } else {
        if (p.lateMs) await d.until(() => !d.running, p.lateMs)
        const a = p.discovery?.(q, d) ?? { answers: Object.fromEntries(q.questions.map((x) => [x.question, recommended(x)])) }
        await d.answer(q, a.answers, a.notes)
      }
      continue
    }
    // idle: the designer stopped without asking anything
    if (p.until === "idle") return { outcome: "idle" }
    if (d.facts().runEnds.at(-1)?.type === "run.failed" && d.facts().runEnds.at(-2)?.type === "run.failed") return { outcome: "failed" }
    if (d.nudges >= (p.maxNudges ?? 3)) return { outcome: "stuck" }
    d.nudges++
    const rendered = d.facts().tools.some((t) => t.name === "render_part" && t.done && !t.isError)
    await d.send(!rendered ? "Where's the design? You decide the details, just make it." : approved ? "Yes, print it." : "Looks good, print it please.")
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------
interface Ctx {
  stack: Stack
  /** Wait for every runtime of this scenario to reach this point (e.g. before a server restart). */
  barrier(name: string): Promise<void>
  /** Restart the server once for the whole scenario (every runtime calls it; the last one in restarts). */
  restart(): Promise<void>
  photo(): string
}

interface Scenario {
  id: string
  title: string
  run(d: Driver, ctx: Ctx): Promise<void>
}

/** Discovery answers for the "answers" scenario: free text for the first question, "You decide" for the rest. */
function freeTextThenDecide(q: AgentQuestionRequest) {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  q.questions.forEach((x, i) => {
    if (i === 0) {
      answers[x.question] = /name|text|word|letter|say|initial/i.test(`${x.question} ${x.header}`) ? "MAYA" : `${recommended(x)}, and put the name MAYA on it`
    } else {
      answers[x.question] = recommended(x)
      notes[x.question] = "The user chose “You decide”: go with your recommendation."
    }
  })
  return { answers, notes }
}

/** End of a scenario: stop the designer if it is still working or waiting on a card (closing the run), then the common checks. */
async function finish(d: Driver, o: { design?: boolean; discovery?: boolean; printed?: boolean; answerLines?: Set<string> }, sent = d.sent) {
  if (d.running || d.pendingQs.size) await d.stop()
  Object.assign(d.checks, commonChecks(await d.refresh(), sent, o))
}

const NO_QUESTIONS = "No need to ask me about the details, just make it."

const ALL: Scenario[] = [
  {
    id: "open",
    title: "a+d: short open request -> questions -> design -> review -> slice -> preview -> print (approve)",
    async run(d) {
      await d.send("make me a phone stand")
      const r = await autopilot(d, { until: "printed", print: "approve", maxNudges: 3 })
      d.check("reachedPrint", r.outcome === "printed", r.outcome)
      d.check("noNudgeNeeded", d.nudges === 0, `${d.nudges} nudge(s)`)
      await finish(d, { design: true, discovery: true, printed: true, answerLines: d.answerLines })
    },
  },
  {
    id: "answers",
    title: "b+d: late + free-text + You decide answers; review feedback; decline the print -> asks; change needs re-approval",
    async run(d) {
      await d.send("make me a name tag for my backpack")
      // discovery: answered only after the turn ended (or 45 s), the first with free text, the rest "You decide"
      let r = await autopilot(d, { until: "review", discovery: freeTextThenDecide, lateMs: 45_000, maxNudges: 2 })
      d.check("usedFreeTextAnswer", /MAYA/i.test(d.scad()), "the name MAYA isn't in the design")
      if (r.outcome !== "review") return void d.check("reachedReview", false, r.outcome)
      // review: free-text feedback -> a revision and a new review card
      const before = d.facts().tools.filter((t) => t.name === "render_part").length
      await d.answer(r.review!, Object.fromEntries(r.review!.questions.map((x) => [x.question, REVIEW_Q.test(x.question) ? "Make the letters bigger" : recommended(x)])), Object.fromEntries(r.review!.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])))
      r = await autopilot(d, { until: "review", maxNudges: 2 })
      d.check("feedbackRevised", r.outcome === "review" && d.facts().tools.filter((t) => t.name === "render_part").length > before, r.outcome)
      if (r.outcome !== "review") return
      // approve, then cancel the print dialog: the designer should ask what to change (a card), not stop
      await d.answer(r.review!, Object.fromEntries(r.review!.questions.map((x) => [x.question, REVIEW_Q.test(x.question) ? looksGreat(x) : recommended(x)])))
      const dialog = await autopilot(d, { until: "print-dialog", maxNudges: 2 })
      d.check("reachedPrintDialog", dialog.outcome === "print-dialog", dialog.outcome)
      if (dialog.outcome !== "print-dialog") return
      const declineSeq = Math.max(...d.list().map((e) => e.seq))
      await d.print(d.openPrint()!, false)
      const asked = await d.until(() => !!d.openQuestion() || d.idle(), 4 * 60_000)
      const q = d.openQuestion()
      d.check("declineAsksWhatToChange", asked && !!q, q ? q.questions.map((x) => x.question).join(" | ") : "no card after the decline")
      // change after approval: thinner -> needs a fresh "How does this look?" before slicing again
      if (q) await d.answer(q, Object.fromEntries(q.questions.map((x) => [x.question, "Make it a bit thinner"])), Object.fromEntries(q.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])))
      else await d.send("Make it a bit thinner.")
      r = await autopilot(d, { until: "printed", print: "approve", maxNudges: 2 })
      const f = d.facts()
      const editAfter = f.tools.find((t) => t.seq > declineSeq && /^(Write|Edit|set_parameters)$/.test(t.name))
      const sliceAfter = editAfter ? f.tools.find((t) => t.seq > editAfter.seq && /^slice_(part|plate)$/.test(t.name) && t.done && !t.isError) : undefined
      const reReview = editAfter ? f.questions.find((x) => x.review && x.seq > editAfter.seq && (!sliceAfter || x.seq < sliceAfter.seq)) : undefined
      d.check("changeNeedsReapproval", !!editAfter && (!sliceAfter || !!reReview), editAfter ? (reReview ? undefined : "sliced again without a new review") : "no change made")
      d.check("printedAfterChange", r.outcome === "printed", r.outcome)
      await finish(d, { design: true, discovery: true, answerLines: d.answerLines })
    },
  },
  {
    id: "interrupts",
    title: "c: mid-turn correction + two rapid messages; typed reply to an open card; Stop then a new message",
    async run(d) {
      await d.send(`Make me a simple clip that holds a 6 mm cable to the edge of a desk. ${NO_QUESTIONS}`)
      // as soon as it starts working: correct it, then a second message right after
      await d.until(() => d.facts().tools.length > 0, 4 * 60_000)
      await d.send("Actually the cable is 9 mm thick, not 6.")
      await sleep(1200)
      await d.send("And add a screw hole so I can screw it down.")
      let r = await autopilot(d, { until: "review", maxNudges: 2 })
      const scad = d.scad()
      d.check("correctionApplied", /\b9(\.0+)?\b/.test(scad) && !/=\s*6(\.0+)?\s*;\s*\/\/[^\n]*(cable|diam)/i.test(scad), "9 mm not in the design")
      d.check("secondMessageApplied", /screw|hole/i.test(scad), "no screw hole")
      const f1 = d.facts()
      const corrections = f1.userTexts.filter((u) => /9 mm|screw hole/.test(u.text))
      d.check("correctionsRead", corrections.every((u) => !u.queued || f1.inputStatus.get(u.runId ?? "") === "received"), corrections.map((u) => `${u.text.slice(0, 20)}=${u.runId ? (f1.inputStatus.get(u.runId) ?? (u.queued ? "never read" : "own turn")) : "?"}`).join(", "))
      if (r.outcome !== "review") return void d.check("reachedReview", false, r.outcome)
      // the UI turns typed text into the answer of an open card
      const reviews = d.facts().questions.filter((q) => q.review).length
      await d.answer(r.review!, Object.fromEntries(r.review!.questions.map((x) => [x.question, "Can you round the corners a bit?"])), Object.fromEntries(r.review!.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])))
      r = await autopilot(d, { until: "review", maxNudges: 2 })
      d.check("typedReplyToCardHandled", r.outcome === "review" && d.facts().questions.filter((q) => q.review).length > reviews, r.outcome)
      // Stop mid-turn, then a new message
      if (r.review) await d.answer(r.review, Object.fromEntries(r.review.questions.map((x) => [x.question, "Make it 20 mm wide."])), Object.fromEntries(r.review.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])))
      else await d.send("Make it 20 mm wide.")
      const mark = d.list().at(-1)?.seq ?? 0
      await d.until(() => d.facts().tools.some((t) => t.seq > mark), 3 * 60_000)
      await sleep(3000)
      await d.stop()
      const stopped = await d.until(() => !d.running, 60_000)
      d.check("stopEndsTurn", stopped, "still running 60 s after Stop")
      await sleep(2000)
      d.check("stopClosesCards", d.pendingQs.size === 0, `${d.pendingQs.size} card(s) still open after Stop`)
      const afterStop = Math.max(...d.list().map((e) => e.seq))
      await d.send("Actually make it 15 mm wide instead.")
      r = await autopilot(d, { until: "review", maxNudges: 1, wallMs: 10 * 60_000 })
      const f = d.facts()
      d.check("newMessageAfterStopHandled", f.tools.some((t) => t.seq > afterStop && /^(Write|Edit|set_parameters|render_part)$/.test(t.name)), r.outcome)
      d.check("interruptRecorded", f.runEnds.some((e) => e.type === "run.interrupted"))
      await finish(d, { design: true, answerLines: d.answerLines })
    },
  },
  {
    id: "resume",
    title: "f: restart the server mid-session and continue; designer process killed; switch chats and back",
    async run(d, ctx) {
      await d.send(`Make me a round coaster with a star cut into the middle. ${NO_QUESTIONS}`)
      const r = await autopilot(d, { until: "review", maxNudges: 2, wallMs: 12 * 60_000 })
      d.check("reachedReview", r.outcome === "review", r.outcome)
      const session = d.sessionId
      const parts = d.facts().tools.filter((t) => /^(Write|Edit)$/.test(t.name)).length
      if (d.running) await d.stop()
      await d.until(() => !d.running, 60_000)
      await ctx.restart()
      d.pendingQs.clear()
      const mark = Math.max(...(await d.refresh()).map((e) => e.seq))
      await d.send("Make the star bigger.")
      const r2 = await autopilot(d, { until: "review", maxNudges: 1, wallMs: 10 * 60_000 })
      let f = d.facts()
      const reopenFail = f.notices.find((n) => n.seq > mark && /couldn.t reopen|starting a fresh one|new conversation/i.test(n.text))
      d.check("resumedAfterRestart", !reopenFail && d.sessionId === session, reopenFail?.text ?? (d.sessionId !== session ? `session changed ${session} -> ${d.sessionId}` : undefined))
      const askedWhat = f.questions.some((q) => q.seq > mark && q.questions.some((x) => /what (would you like|do you want|are we|should I) (to )?make|which (design|project)/i.test(x.question)))
      d.check("keptContextAfterRestart", r2.outcome === "review" && !askedWhat && f.tools.some((t) => t.seq > mark && /^(Write|Edit|set_parameters)$/.test(t.name)), r2.outcome)
      void parts
      // the designer process dies while idle
      if (d.running) await d.stop()
      await d.until(() => !d.running, 60_000)
      const procs = stackProcesses(ctx.stack).filter((p) => DESIGNER_CMD[d.runtime]?.test(p.cmd))
      d.notes.push(`designer processes: ${procs.map((p) => p.pid).join(",") || "none found"}`)
      for (const p of procs) {
        try {
          process.kill(p.pid, "SIGKILL")
        } catch {
          /* gone */
        }
      }
      await sleep(3000)
      const mark2 = Math.max(...(await d.refresh()).map((e) => e.seq))
      d.pendingQs.clear()
      await d.send("Make the coaster 5 mm thick.")
      const r3 = await autopilot(d, { until: "review", maxNudges: 1, wallMs: 10 * 60_000 })
      f = d.facts()
      const fresh = f.notices.find((n) => n.seq > mark2 && /couldn.t reopen|starting a fresh one/i.test(n.text))
      const replied = f.assistantTexts.some((t) => t.seq > mark2) || f.questions.some((q) => q.seq > mark2)
      d.check("resumedAfterCrash", replied && !fresh && !f.runEnds.some((e) => e.seq > mark2 && e.type === "run.failed"), fresh?.text ?? r3.outcome)
      // switch to a new chat and back
      if (d.running) await d.stop()
      await d.until(() => !d.running, 60_000)
      const first = d.sessionId
      await d.stack.api("POST", `/api/projects/${d.projectId}/agent/session`, { sessionId: null })
      await d.send("Hi! Just say hello in one short line.")
      await d.until(() => d.idle(), 4 * 60_000)
      const second = d.sessionId
      await d.stack.api("POST", `/api/projects/${d.projectId}/agent/session`, { sessionId: first })
      d.pendingQs.clear()
      const mark3 = Math.max(...(await d.refresh()).map((e) => e.seq))
      await d.send("Quick question, no changes: how thick is the coaster now? Answer in one line.")
      await d.until(() => d.idle() || !!d.openQuestion(), 5 * 60_000)
      f = d.facts()
      const reply = f.assistantTexts.filter((t) => t.seq > mark3).map((t) => t.text).join(" ")
      d.check("switchBackKeepsContext", d.sessionId === first && second !== first && /\b5(\.0)?\s*(mm|millimet)/i.test(reply), `${reply.slice(0, 160)} (session ${d.sessionId === first ? "same" : "changed"})`)
      // the hello went to the other chat
      await finish(d, { design: true, answerLines: d.answerLines }, d.sent.filter((s) => !/^Hi! Just say hello/.test(s)))
    },
  },
  {
    id: "photo",
    title: "e: photo with the first message (pipe next to a credit card)",
    async run(d, ctx) {
      await d.send("make me a clip to hold this pipe against the wall. The card in the photo is a normal credit card.", [{ mediaType: "image/png", data: ctx.photo() }])
      const r = await autopilot(d, { until: "review", maxNudges: 2 })
      d.check("reachedReview", r.outcome === "review", r.outcome)
      const scad = d.scad()
      const nums = [...scad.matchAll(/(pipe|diam|dia|\bd)\w*\s*=\s*([\d.]+)/gi)].map((m) => Number(m[2])).filter((n) => n > 5 && n < 200)
      const best = nums.sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0]
      d.check("measuredFromPhoto", best !== undefined && Math.abs(best - 32) / 32 <= 0.15, `pipe ≈ ${best ?? "?"} mm (truth 32)`)
      const f = d.facts()
      d.check("lookedAtPhoto", f.assistantTexts.some((t) => /card|photo|picture/i.test(t.text)) || f.questions.some((q) => q.questions.some((x) => /photo|card|picture|measure/i.test(`${x.question} ${x.options.map((o) => o.description).join(" ")}`))))
      await finish(d, { design: true, answerLines: d.answerLines })
    },
  },
  {
    id: "multipart",
    title: "e: multi-part build with an assembly guide before the review",
    async run(d) {
      await d.send("make me a small box with a lid that slides on")
      const r = await autopilot(d, { until: "review", maxNudges: 2 })
      d.check("reachedReview", r.outcome === "review", r.outcome)
      const f = d.facts()
      const review = f.questions.find((q) => q.review)
      const guide = f.tools.find((t) => t.name === "build_assembly_guide" && t.done && !t.isError)
      const pj = JSON.parse(d.file("project.json") ?? "{}")
      d.check("multiplePieces", (pj.parts?.length ?? 0) >= 2, `${pj.parts?.length ?? 0} part(s)`)
      d.check("guideBeforeReview", !!guide && !!review && guide.seq < review.seq, guide ? undefined : "no guide")
      await finish(d, { design: true, discovery: true, answerLines: d.answerLines })
    },
  },
  {
    id: "errors",
    title: "g: a broken OpenSCAD file is repaired (syntax error recovery)",
    async run(d) {
      await d.stack.api("PUT", `/api/projects/${d.projectId}/file`, { path: "parts/stand.scad", content: "// Phone stand\nwidth = 70; // Width (mm)\ndepth = 60 // Depth (mm)\ncube([width, depth, 4]\ntranslate([0, depth - 8, 0]) rotate([70, 0, 0]) cube([width, 5, 90]);\n" })
      await d.send("My phone stand file doesn't work anymore. Can you fix it and show me?")
      const r = await autopilot(d, { until: "review", maxNudges: 2, wallMs: 10 * 60_000 })
      const f = d.facts()
      const ok = f.tools.find((t) => t.name === "render_part" && t.done && !t.isError)
      d.check("repaired", !!ok, r.outcome)
      d.check("askedReview", r.outcome === "review", `${r.outcome}${d.nudges ? `, ${d.nudges} nudge(s)` : ""}`)
      await finish(d, { answerLines: d.answerLines })
    },
  },
]

// ---------------------------------------------------------------------------------------------
// Setup + main
// ---------------------------------------------------------------------------------------------
interface RuntimeSpec {
  runtime: string
  profileId: string
}

async function setup(stack: Stack): Promise<RuntimeSpec[]> {
  // The mock printer as the (only, so default) machine, a 4-slot printer with colours loaded.
  await stack.api("POST", "/api/machines", {
    name: "Parity i7",
    model: "Creality SPARKX i7",
    slicerProfile: "sparkx-i7",
    buildVolumeMm: [260, 260, 255],
    nozzleMm: 0.4,
    maxNozzleC: 300,
    filamentSlots: 4,
    filaments: [
      { slot: 1, colorName: "White", colorHex: "#f5f5f5", material: "PLA", loaded: true },
      { slot: 2, colorName: "Black", colorHex: "#1a1a1a", material: "PLA", loaded: true },
      { slot: 3, colorName: "Red", colorHex: "#d32f2f", material: "PLA", loaded: true },
      { slot: 4, colorName: "Blue", colorHex: "#1e5bd8", material: "PLA", loaded: true },
    ],
    filamentsConfirmed: true,
    tolerances: { slidingFitMm: null, pressFitMm: null, holeCompensationMm: null },
    connection: { type: "moonraker", host: "127.0.0.1", port: MOCK_PORT },
    enabled: true,
  })
  const probes = await stack.api<Any[]>("GET", "/api/agent/runtimes").catch(() => [])
  const specs: RuntimeSpec[] = []
  for (const runtime of RUNTIMES) {
    const probe = (probes as Any[]).find((p: Any) => p.runtime === runtime)
    const model = runtime === "claude" ? CLAUDE_MODEL : runtime === "codex" ? CODEX_MODEL : GROK_MODEL
    const body: Any = { name: `Parity ${runtime}`, runtime, model, auth: { kind: "subscription" }, ...(EFFORT[runtime] ? { effort: EFFORT[runtime] } : {}) }
    const p = await stack.api<Any>("POST", "/api/agent/profiles", body).catch((e) => {
      console.log(`[setup] ${runtime}: profile refused: ${e}`)
      return null
    })
    if (!p) continue
    console.log(`[setup] ${runtime}: profile ${p.id} (${model ?? "default model"}${EFFORT[runtime] ? `, effort ${EFFORT[runtime]}` : ""}); probe: ${probe ? `${probe.ready ? "ready" : "NOT ready"} ${probe.detail ?? ""}` : "?"}`)
    if (probe && probe.ready === false) {
      console.log(`[setup] ${runtime}: skipped (not ready)`)
      continue
    }
    specs.push({ runtime, profileId: p.id })
  }
  return specs
}

function renderPhoto(outDir: string): string {
  const png = join(outDir, "pipe.png")
  execFileSync(OPENSCAD, ["-o", png, "--imgsize=1200,800", "--projection=o", "--camera=110,40,0,0,0,0,400", "--colorscheme=Tomorrow", join(ROOT, "tools/evals/photos/pipe.scad")], { stdio: "ignore" })
  return readFileSync(png).toString("base64")
}

interface Row {
  scenario: string
  runtime: string
  checks: Checks
  pass: number
  fail: number
  wallS: number
  tokens: number
  costUsd: number | null
  nudges: number
  notes: string[]
  excerpt: string
  error?: string
}

const score = (c: Checks) => ({ pass: Object.values(c).filter((x: Check) => x.ok === true).length, fail: Object.values(c).filter((x: Check) => x.ok === false).length })

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const outDir = join(HERE, "results", stamp)
  mkdirSync(outDir, { recursive: true })
  const stack = new Stack()
  const rows: Row[] = []
  let spend = 0
  const cleanup = async () => {
    await stack.stop().catch(() => {})
    if (!KEEP) rmSync(stack.home, { recursive: true, force: true })
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void cleanup().then(() => process.exit(130)))
  try {
    console.log(`parity: home ${stack.home}, server :${PORT}, mock printer :${MOCK_PORT}${APP_ROOT !== ROOT ? `, app from ${APP_ROOT}` : ""}`)
    await stack.start()
    const specs = await setup(stack)
    let photo: string | null = null
    const scenarios = SCENARIOS ? SCENARIOS.map((id) => SCENARIOS_BY_ID.get(id)).filter((s): s is Scenario => !!s) : SCENARIOS_LIST
    for (const sc of scenarios) {
      if (spend >= BUDGET) {
        console.log(`[${sc.id}] skipped: budget $${BUDGET} reached ($${spend.toFixed(2)})`)
        continue
      }
      console.log(`\n=== ${sc.id}: ${sc.title}`)
      const arrived = new Map<string, number>()
      const gates = new Map<string, () => void>()
      const gatePromises = new Map<string, Promise<void>>()
      let active = specs.length
      const barrier = (name: string) => {
        if (!gatePromises.has(name)) gatePromises.set(name, new Promise<void>((r) => gates.set(name, r)))
        arrived.set(name, (arrived.get(name) ?? 0) + 1)
        if (arrived.get(name)! >= active) gates.get(name)!()
        return gatePromises.get(name)!
      }
      let restarted: Promise<void> | null = null
      const ctx: Ctx = {
        stack,
        barrier,
        restart: async () => {
          await barrier("restart")
          restarted ??= (async () => {
            console.log(`[${sc.id}] restarting the server`)
            await stack.restartServer()
          })()
          await restarted
        },
        photo: () => (photo ??= renderPhoto(outDir)),
      }
      await Promise.all(
        specs.map(async (spec) => {
          const project = await stack.api<Any>("POST", "/api/projects", { name: `parity ${sc.id} ${spec.runtime}` })
          await stack.api("POST", `/api/projects/${project.id}/agent/profile`, { profileId: spec.profileId, model: null })
          const d = new Driver(stack, spec.runtime, project.id, sc.id)
          let error: string | undefined
          try {
            await sc.run(d, ctx)
          } catch (e) {
            error = e instanceof Error ? (e.stack ?? e.message) : String(e)
            d.log(`ERROR ${error}`)
          } finally {
            active--
            // release anyone waiting at a barrier this runtime will never reach
            for (const [name, n] of arrived) if (n >= active) gates.get(name)?.()
          }
          if (d.running || d.pendingQs.size) await d.stop()
          const events = await d.refresh()
          // a scenario that stopped early still gets the timeline/question checks
          if (!("bubblesInOrder" in d.checks)) Object.assign(d.checks, commonChecks(events, d.sent, { answerLines: d.answerLines }))
          // end the live session: its designer process closes (the next scenario starts clean)
          const sid = d.sessionId ?? (await stack.api<Any>("GET", `/api/projects/${project.id}/agent/status`).catch(() => ({})))?.sessionId
          if (sid) await stack.api("POST", `/api/projects/${project.id}/agent/session`, { sessionId: sid }).catch(() => {})
          const u = usageOf(events, spec.runtime)
          if (u.costUsd) spend += u.costUsd
          const s = score(d.checks)
          rows.push({
            scenario: sc.id,
            runtime: spec.runtime,
            checks: d.checks,
            ...s,
            wallS: Math.round((Date.now() - d.startedAt) / 1000),
            tokens: u.tokens,
            costUsd: u.costUsd,
            nudges: d.nudges,
            notes: d.notes,
            excerpt: excerpt(events),
            ...(error ? { error } : {}),
          })
          writeFileSync(join(outDir, `${sc.id}-${spec.runtime}.events.json`), JSON.stringify(events, null, 1))
          d.log(`done: ${s.pass} pass, ${s.fail} fail, ${Math.round((Date.now() - d.startedAt) / 1000)} s, ${u.tokens} tokens${u.costUsd ? `, ≈$${u.costUsd.toFixed(2)}` : ""}`)
        })
      )
      writeFileSync(join(outDir, "results.json"), JSON.stringify({ spendUsd: spend, rows }, null, 2))
    }
  } finally {
    const leftover = stackProcesses(stack)
    await cleanup()
    if (leftover.length) console.log(`(stopped ${leftover.length} child process(es) with the server)`)
  }
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ spendUsd: spend, rows }, null, 2))
  writeFileSync(join(outDir, "report.md"), report(rows, spend))
  console.log("\n" + matrix(rows) + `\n\nAPI-equivalent spend ≈ $${spend.toFixed(2)} -> ${join(outDir, "report.md")}`)
}

const SCENARIOS_LIST = ["open", "interrupts", "answers", "resume", "errors", "multipart", "photo"].map((id) => ALL.find((s) => s.id === id)!).filter(Boolean)
const SCENARIOS_BY_ID = new Map(ALL.map((s) => [s.id, s]))

function matrix(rows: Row[]): string {
  const runtimes = [...new Set(rows.map((r) => r.runtime))]
  const scen = [...new Set(rows.map((r) => r.scenario))]
  const lines = [`| scenario | ${runtimes.join(" | ")} |`, `|---|${runtimes.map(() => "---").join("|")}|`]
  for (const s of scen) {
    lines.push(
      `| ${s} | ${runtimes
        .map((rt) => {
          const r = rows.find((x) => x.scenario === s && x.runtime === rt)
          if (!r) return "–"
          return `${r.fail ? "✗" : "✓"} ${r.pass}/${r.pass + r.fail} · ${Math.round(r.wallS / 60)} min · ${r.costUsd ? `$${r.costUsd.toFixed(2)}` : `${Math.round(r.tokens / 1000)}k tok`}${r.error ? " · ERROR" : ""}`
        })
        .join(" | ")} |`
    )
  }
  return lines.join("\n")
}

function report(rows: Row[], spend: number): string {
  const out = [`# Designer parity run`, "", `API-equivalent spend ≈ $${spend.toFixed(2)} (Claude reports cost; Codex/Grok report tokens only).`, "", matrix(rows), ""]
  for (const r of rows) {
    out.push(`## ${r.scenario} · ${r.runtime}`, "")
    out.push(`${r.pass} pass, ${r.fail} fail · ${r.wallS} s · ${r.tokens} tokens${r.costUsd ? ` · ≈$${r.costUsd.toFixed(2)}` : ""} · nudges ${r.nudges}${r.error ? `\n\nERROR: ${r.error.split("\n")[0]}` : ""}`, "")
    for (const [k, c] of Object.entries(r.checks)) out.push(`- ${c.ok === null ? "–" : c.ok ? "✓" : "✗"} ${k}${c.detail && c.ok === false ? `: ${c.detail.slice(0, 300)}` : ""}`)
    if (r.notes.length) out.push("", ...r.notes.map((n) => `> ${n}`))
    out.push("", "```", r.excerpt, "```", "")
  }
  return out.join("\n")
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => setTimeout(() => process.exit(), 1000))
