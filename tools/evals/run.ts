// Crease agent evals: naive beginner prompts + simulated personas, deterministic metrics, and an LLM judge.
//
//   npm run eval -- [--model sonnet] [--only id,id] [--concurrency 2] [--budget 8] [--no-judge]
//
// Starts one isolated stack per worker (temp PRINTSTUDIO_HOME, server on --port+i, mock printer on --mock-port+i), drives each
// scenario over the public API + WebSocket like the UI does (answers questions per persona, approves the print
// dialog), then scores the transcript and project files. Writes tools/evals/results/<timestamp>/{results.json,report.md}.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { query } from "@anthropic-ai/claude-agent-sdk"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..", "..")

// ---------------------------------------------------------------------------------------------
// CLI + config
// ---------------------------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name: string, def?: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? "") : def
}
const MODEL = flag("model", "sonnet")!
const ONLY = flag("only")?.split(",").filter(Boolean)
const CONCURRENCY = Number(flag("concurrency", "2"))
const BUDGET = Number(flag("budget", "8"))
const JUDGE = !argv.includes("--no-judge")
const JUDGE_MODEL = flag("judge-model", "haiku")!
const PORT = Number(flag("port", "5190"))
const MOCK_PORT = Number(flag("mock-port", "7190"))
const CAPS = { turns: 40, costUsd: 1.2, wallMs: 12 * 60_000 }
const OPENSCAD = process.env.OPENSCAD ?? "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const MAX_FOLLOWUPS = 3

interface Scenario {
  id: string
  prompt: string
  persona: string
  answer: "recommended" | "decide" | "preference" | "dontknow"
  preference?: { match: string; answer: string }
  review: string[]
  stated: string[]
  machines?: (Record<string, unknown> & { name: string; target?: boolean })[] // created before the run (see scenarios.json)
  photo?: string // OpenSCAD scene (relative to tools/evals) rendered to a PNG and attached to the first message
  expect: {
    moving?: boolean
    mustCover?: string[]
    maxQuestionRounds?: number
    smallParts?: boolean
    measure?: { param: string; truth: number; tolerance: number } // a Customizer parameter matching `param` must be within ±tolerance of truth
    recommendMachine?: string // machine name the agent should recommend switching to
    quality?: { intent: string } // sliced with this intent, no starts_mid_air, previewed after the last slice
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------
const children: ChildProcess[] = []
function start(cmd: string, args: string[], env: Record<string, string>, label: string, ready: RegExp): Promise<void> {
  const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true })
  children.push(c)
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${label} did not start`)), 60_000)
    const on = (d: Buffer) => {
      if (process.env.EVAL_DEBUG) process.stderr.write(`[${label}] ${d}`)
      if (ready.test(d.toString())) {
        clearTimeout(t)
        res()
      }
    }
    c.stdout!.on("data", on)
    c.stderr!.on("data", on)
    c.on("exit", (code) => rej(new Error(`${label} exited ${code}`)))
  })
}
function stopAll() {
  for (const c of children) {
    try {
      // SIGTERM to the group: the server's shutdown handler closes agent sessions (and their CLI processes)
      if (c.pid) process.kill(-c.pid, "SIGTERM")
    } catch {
      /* gone */
    }
  }
}
process.on("exit", stopAll)
process.on("SIGINT", () => process.exit(130))

// ---------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------
type Listener = (e: Any) => void

/** One isolated app instance per worker: own PRINTSTUDIO_HOME, server port and mock printer (no shared printer state). */
interface Stack {
  i: number
  port: number
  mockPort: number
  home: string
  listeners: Set<Listener>
  api: <T = Any>(method: string, path: string, body?: unknown) => Promise<T>
}

async function startStack(i: number): Promise<Stack> {
  const port = PORT + i
  const mockPort = MOCK_PORT + i
  const base = `http://127.0.0.1:${port}`
  const home = mkdtempSync(join(tmpdir(), `printstudio-eval-${i}-`))
  writeFileSync(join(home, "settings.json"), JSON.stringify({ model: MODEL, printer: { host: "127.0.0.1", port: mockPort } }, null, 2))
  const env = { PRINTSTUDIO_HOME: home, PORT: String(port), LOG_LEVEL: "warn", MOCK_PORT: String(mockPort), MOCK_PRINT_SECONDS: "5" }
  const tsx = join(ROOT, "node_modules/tsx/dist/cli.mjs")
  await start(process.execPath, [tsx, "tools/mock-moonraker.ts"], env, `mock${i}`, /listening/)
  void start(process.execPath, [tsx, "server/index.ts"], env, `server${i}`, /listening/i).catch(() => {})
  for (let k = 0; k < 120; k++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  const api = async <T = Any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(base + path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`)
    return data as T
  }
  const listeners = new Set<Listener>()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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
    for (const l of listeners) l(e)
  }
  console.log(`stack ${i}: server :${port}, mock printer :${mockPort}, home ${home}`)
  return { i, port, mockPort, home, listeners, api }
}

// ---------------------------------------------------------------------------------------------
// Persona: answering questions and reviews
// ---------------------------------------------------------------------------------------------
const REVIEW_Q = /how does (this|it) look/i
const recommended = (q: Any) => q.options.find((o: Any) => /\(recommended\)/i.test(o.label)) ?? q.options[0]

function answerFor(sc: Scenario, req: Any, state: Run): { answers: Record<string, string>; notes?: Record<string, string> } {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  const isReview = req.questions.some((q: Any) => REVIEW_Q.test(q.question))
  if (isReview) {
    const fb = sc.review[state.reviewsSeen]
    state.reviewsSeen++
    for (const q of req.questions) {
      if (REVIEW_Q.test(q.question) && fb) answers[q.question] = fb
      else answers[q.question] = /looks great/i.test(q.options.map((o: Any) => o.label).join("|")) ? q.options.find((o: Any) => /looks great/i.test(o.label)).label : recommended(q).label
    }
    if (!fb) state.approvedAt = state.events.length
    return { answers }
  }
  state.discoveryRounds++
  for (const q of req.questions) {
    let a = recommended(q).label
    if (sc.answer === "decide") notes[q.question] = "The user chose “You decide”: go with your recommendation."
    if (sc.answer === "dontknow" && state.discoveryRounds === 1) a = "I don't know"
    if (sc.answer === "preference" && sc.preference && new RegExp(sc.preference.match, "i").test(q.question + " " + q.header)) a = sc.preference.answer
    answers[q.question] = a
  }
  return { answers, notes: Object.keys(notes).length ? notes : undefined }
}

// ---------------------------------------------------------------------------------------------
// Run one scenario
// ---------------------------------------------------------------------------------------------
interface Run {
  scenario: Scenario
  projectId: string
  events: Any[]
  reviewsSeen: number
  discoveryRounds: number
  approvedAt: number | null
  followups: number
  printApproved: boolean
  capHit: string | null
  costUsd: number
  startedAt: number
  endedAt: number
  machineIds: Record<string, string> // scenario machines created for this run, by name
}

let totalSpend = 0

/** Create the scenario's machines; returns their ids by name and a function restoring the previous default. */
async function setupMachines(sc: Scenario, stack: Stack): Promise<{ ids: Record<string, string>; targetId: string | null; restore: () => Promise<void> }> {
  const ids: Record<string, string> = {}
  let targetId: string | null = null
  if (!sc.machines?.length) return { ids, targetId, restore: async () => {} }
  const before = await stack.api<Any[]>("GET", "/api/machines")
  const prevDefault = before.find((m) => m.isDefault)?.id
  for (const spec of sc.machines) {
    const { target, ...m } = spec
    const body = JSON.parse(JSON.stringify(m).replace(/"\$MOCK_PORT"/g, String(stack.mockPort)))
    const created = await stack.api<Any>("POST", "/api/machines", body)
    ids[spec.name] = created.id
    if (target) {
      targetId = created.id
      await stack.api("POST", `/api/machines/${created.id}/default`)
    }
  }
  return {
    ids,
    targetId,
    restore: async () => {
      for (const id of Object.values(ids)) await stack.api("DELETE", `/api/machines/${id}`).catch(() => {})
      if (prevDefault) await stack.api("POST", `/api/machines/${prevDefault}/default`).catch(() => {})
    },
  }
}

async function runScenario(sc: Scenario, stack: Stack, photoB64?: string): Promise<Run> {
  const { api, listeners } = stack
  const machinesSetup = await setupMachines(sc, stack)
  const project = await api("POST", "/api/projects", { name: `eval ${sc.id}` })
  // the project's target machine (new projects don't follow the default machine yet)
  if (machinesSetup.targetId) await api("PUT", `/api/projects/${project.id}/machine`, { machineId: machinesSetup.targetId })
  const run: Run = {
    scenario: sc,
    projectId: project.id,
    events: [],
    reviewsSeen: 0,
    discoveryRounds: 0,
    approvedAt: null,
    followups: 0,
    printApproved: false,
    capHit: null,
    costUsd: 0,
    startedAt: Date.now(),
    endedAt: 0,
    machineIds: machinesSetup.ids,
  }
  const log = (s: string) => console.log(`[${sc.id}] ${s}`)
  let resolveDone!: () => void
  const done = new Promise<void>((r) => (resolveDone = r))
  const msgIds = new Set<string>()
  let finished = false
  const finish = (why: string) => {
    if (finished) return
    finished = true
    log(`done: ${why}`)
    resolveDone()
  }
  const stopFor = async (why: string) => {
    run.capHit = why
    log(`cap: ${why}`)
    await api("POST", `/api/projects/${run.projectId}/agent/stop`).catch(() => {})
    setTimeout(() => finish(why), 3000)
  }

  const onEvent: Listener = (e) => {
    if (finished) return
    if (e.type === "agent.event" && e.projectId === run.projectId) {
      // Normalized events (R11a): model steps for the turn cap, run ends for the persona's next move. The raw
      // messages the metrics read come from GET …/agent/timeline (native log), refreshed at each turn end.
      const ev = e.event
      if ((ev.type === "message.completed" || ev.type === "tool.started") && ev.stepId && !(ev.type === "message.completed" && ev.role === "user")) msgIds.add(ev.stepId)
      if (msgIds.size > CAPS.turns && !run.capHit) void stopFor(`turns>${CAPS.turns}`)
      if ((ev.type === "run.completed" || ev.type === "run.failed" || ev.type === "run.interrupted") && ev.result) void onTurnEnd()
    } else if (e.type === "agent.status" && e.projectId === run.projectId) {
      run.costUsd = Math.max(run.costUsd, e.costUsd ?? 0)
      if (run.costUsd > CAPS.costUsd && !run.capHit) void stopFor(`cost>$${CAPS.costUsd}`)
    } else if (e.type === "agent.question" && e.request.projectId === run.projectId) {
      const a = answerFor(sc, e.request, run)
      log(`Q: ${e.request.questions.map((q: Any) => q.question).join(" | ")} → ${Object.values(a.answers).join(" | ")}`)
      setTimeout(() => void api("POST", `/api/projects/${run.projectId}/agent/answer`, { requestId: e.request.requestId, ...a }).catch((err) => log(String(err))), 200)
    } else if (e.type === "print.request" && e.request.projectId === run.projectId) {
      log(`print requested (${e.request.gcodeName}) → approving`)
      run.printApproved = true
      void api("POST", `/api/print-requests/${e.request.requestId}`, { approved: true, bedClear: true }).catch((err) => log(String(err)))
    }
  }

  const onTurnEnd = async () => {
    if (finished || run.capHit) return
    run.events = (await api<Any[]>("GET", `/api/projects/${run.projectId}/agent/timeline`).catch(() => [])).map((x) => x.message)
    if (run.printApproved) return finish("print requested")
    const pending = await api<Any[]>("GET", `/api/projects/${run.projectId}/agent/questions`).catch(() => [])
    if (pending.length) return
    if (run.followups >= MAX_FOLLOWUPS) return finish("no more follow-ups")
    run.followups++
    // The persona nudges forward like a beginner would.
    const rendered = run.events.some((m) => m.type === "assistant" && m.message.content.some((b: Any) => b.type === "tool_use" && /render_part$/.test(b.name)))
    const text = !rendered ? "You decide, just make it." : run.approvedAt != null ? "Yes, print it." : "Looks good, print it please."
    if (text.includes("print") && run.approvedAt == null) run.approvedAt = run.events.length
    log(`user: ${text}`)
    await api("POST", `/api/projects/${run.projectId}/agent/message`, { text })
  }

  listeners.add(onEvent)
  const wall = setTimeout(() => void stopFor(`wall>${CAPS.wallMs / 60000}min`), CAPS.wallMs)
  log(`user: ${sc.prompt}`)
  await api("POST", `/api/projects/${run.projectId}/agent/message`, {
    text: sc.prompt,
    ...(photoB64 ? { images: [{ mediaType: "image/png", data: photoB64 }] } : {}),
  })
  await done
  clearTimeout(wall)
  listeners.delete(onEvent)
  run.endedAt = Date.now()
  // authoritative transcript (persisted envelopes) + final cost
  const tl = await api<Any[]>("GET", `/api/projects/${run.projectId}/agent/timeline`)
  run.events = tl.map((e) => e.message)
  const st = await api("GET", `/api/projects/${run.projectId}/agent/status`)
  run.costUsd = Math.max(run.costUsd, st.costUsd ?? 0)
  totalSpend += run.costUsd
  await machinesSetup.restore()
  return run
}

// ---------------------------------------------------------------------------------------------
// Metrics (deterministic)
// ---------------------------------------------------------------------------------------------
function toolUses(events: Any[]) {
  const out: { name: string; input: Any; id: string; idx: number }[] = []
  events.forEach((m, idx) => {
    if (m.type === "assistant" && !m.parent_tool_use_id)
      for (const b of m.message.content) if (b.type === "tool_use") out.push({ name: b.name.replace(/^mcp__studio__/, ""), input: b.input, id: b.id, idx })
  })
  return out
}
function toolResults(events: Any[]) {
  const out = new Map<string, { text: string; isError: boolean; idx: number }>()
  events.forEach((m, idx) => {
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: Any) => c.text ?? "").join("\n")
          out.set(b.tool_use_id, { text, isError: !!b.is_error, idx })
        }
  })
  return out
}

function metrics(run: Run, home: string) {
  const sc = run.scenario
  const ev = run.events
  const uses = toolUses(ev)
  const results = toolResults(ev)
  const asks = uses.filter((u) => u.name === "AskUserQuestion")
  const discovery = asks.filter((u) => !(u.input.questions ?? []).some((q: Any) => REVIEW_Q.test(q.question)))
  const reviews = asks.filter((u) => (u.input.questions ?? []).some((q: Any) => REVIEW_Q.test(q.question)))
  const allQs: Any[] = discovery.flatMap((u) => u.input.questions ?? [])
  const everyRecommended = allQs.every((q) => (q.options ?? []).some((o: Any) => /\(recommended\)/i.test(o.label)))
  // Re-asking = a question about a fact the user already gave that isn't just refining HOW to do it
  // ("How should it hold your keys and mail?" / "What kind of latch?" are fine; "What size is the pipe?" is not).
  const REFINE = /^\s*(how\b|what (kind|type|style|sort|shape)\b|which (kind|type|style|shape)\b)/i
  const askedStated = allQs
    .filter((q) => !REFINE.test(q.question) && sc.stated.some((re) => new RegExp(re, "i").test(`${q.header} ${q.question}`)))
    .map((q) => q.question)
  const mustCover = sc.expect.mustCover
  const coverOk = mustCover
    ? allQs.every((q) => {
        if (!mustCover.some((w) => new RegExp(w, "i").test(q.question))) return true
        const rec = recommended(q)
        return mustCover.every((w) => new RegExp(w, "i").test(`${rec.label} ${rec.description}`))
      })
    : null

  // checks: last check_part result per part
  const lastCheck = new Map<string, Any>()
  for (const u of uses.filter((u) => u.name === "check_part")) {
    const r = results.get(u.id)
    if (!r || r.isError) continue
    try {
      lastCheck.set(u.input.partId, JSON.parse(r.text.slice(0, r.text.lastIndexOf("}") + 1)))
    } catch {
      /* not json */
    }
  }
  // Prefer the saved final check of each part (.studio/checks/<part>.json): the state the user would print.
  const checksDir = join(home, "projects", run.projectId, ".studio", "checks")
  if (existsSync(checksDir)) {
    for (const f of readdirSync(checksDir).filter((f) => f.endsWith(".json"))) {
      try {
        lastCheck.set(f.slice(0, -5), JSON.parse(readFileSync(join(checksDir, f), "utf8")))
      } catch {
        /* unreadable */
      }
    }
  }
  const checks = [...lastCheck.values()]
  const checksPass = checks.length ? checks.every((c) => c.summary !== "fail") : null
  const fitsBed = checks.length ? checks.every((c) => !(c.items ?? []).some((i: Any) => i.rule === "fits_bed" && i.severity === "fail")) : null

  // project files
  const dir = join(home, "projects", run.projectId)
  const pj = existsSync(join(dir, "project.json")) ? JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) : { parts: [] }
  const asm = existsSync(join(dir, "assembly.json")) ? JSON.parse(readFileSync(join(dir, "assembly.json"), "utf8")) : null
  const parts = pj.parts?.length ?? 0
  const hardware = asm?.hardware?.length ?? 0
  const motions = asm?.motions?.length ?? 0
  const guideNeeded = parts > 1 || hardware > 0 || motions > 0
  const guidePresent = existsSync(join(dir, "build", "assembly-guide.html"))
  const checkMotionRun = uses.some((u) => u.name === "check_motion")

  // approval ordering: first successful slice must come after an approval signal
  const approvalIdx = (() => {
    let i = ev.findIndex((m, idx) => {
      if (m.type === "user_input" && /print|slice/i.test(m.text) && idx > 0) return true
      return false
    })
    for (const u of reviews) {
      const r = results.get(u.id)
      if (r && /looks great/i.test(r.text)) i = i < 0 ? r.idx : Math.min(i, r.idx)
    }
    return i
  })()
  const slices = uses.filter((u) => u.name === "slice_part" || u.name === "slice_plate")
  const okSlices = slices.filter((u) => !results.get(u.id)?.isError)
  const sliceRefusals = slices.filter((u) => /hasn't approved/.test(results.get(u.id)?.text ?? "")).length
  const sliceAfterApproval = okSlices.length ? approvalIdx >= 0 && okSlices[0].idx > approvalIdx : null
  const printReq = uses.filter((u) => u.name === "request_print")
  const printRequested = printReq.some((u) => /"approved": true/.test(results.get(u.id)?.text ?? ""))
  const toolErrors = uses.filter((u) => results.get(u.id)?.isError).length
  const turns = ev.filter((m) => m.type === "result").reduce((a, m) => a + (m.num_turns ?? 0), 0)

  return {
    questions: allQs.length,
    questionRounds: discovery.length,
    reviewQuestions: reviews.length,
    everyQuestionRecommended: allQs.length ? everyRecommended : null,
    askedAboutStated: askedStated,
    recommendationCoversRequest: coverOk,
    planShared: uses.some((u) => u.name === "share_plan"),
    checksPass,
    fitsBed,
    parts,
    hardware,
    motions,
    guideNeeded,
    guidePresent,
    checkMotionRun: motions ? checkMotionRun : null,
    sliceAfterApproval,
    sliceRefusals,
    printRequested,
    turns,
    costUsd: +run.costUsd.toFixed(3),
    wallS: Math.round((run.endedAt - run.startedAt) / 1000),
    toolErrors,
    capHit: run.capHit,
  }
}

/** Machine scenarios: did the agent recommend (or use) the better-suited machine? */
function machineMetric(sc: Scenario, run: Run) {
  const name = sc.expect.recommendMachine // regex
  if (!name) return {}
  const ids = Object.entries(run.machineIds ?? {}).filter(([n]) => new RegExp(name, "i").test(n)).map(([, id]) => id)
  const re = new RegExp(name, "i") // regex on machine names
  const uses = toolUses(run.events)
  const offered = uses.some(
    (u) =>
      u.name === "AskUserQuestion" &&
      (u.input.questions ?? []).some((q: Any) => (q.options ?? []).some((o: Any) => /\(recommended\)/i.test(o.label) && (re.test(`${o.label} ${o.description}`) || re.test(q.question)))),
  )
  const mentioned = run.events.some((m) => m.type === "assistant" && m.message.content.some((b: Any) => b.type === "text" && re.test(b.text)))
  const used = uses.some((u) => /^(slice_part|slice_plate|request_print|set_target_machine)$/.test(u.name) && (ids.includes(u.input.machineId) || re.test(String(u.input.machineId ?? ""))))
  return { machineRecommended: offered || used, machineMentioned: mentioned, machineUsed: used }
}

/** Print-quality scenarios: intent chosen, nothing starting mid-air, preview reviewed after the last slice. */
function qualityMetric(sc: Scenario, run: Run) {
  const want = sc.expect.quality
  if (!want) return {}
  const uses = toolUses(run.events)
  const results = toolResults(run.events)
  const parse = (t: string) => {
    try {
      return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1))
    } catch {
      return null
    }
  }
  const slices = uses.filter((u) => /^(slice_part|slice_plate)$/.test(u.name) && !results.get(u.id)?.isError)
  const last = slices.at(-1)
  const lastResult = last ? parse(results.get(last.id)?.text ?? "") : null
  const intent = (last?.input.intent as string | undefined) ?? lastResult?.intent ?? lastResult?.plates?.[0]?.intent ?? null
  const previews = uses.filter((u) => u.name === "preview_slice" && !results.get(u.id)?.isError)
  const previewed = !!last && previews.some((p) => p.idx > last.idx)
  const lastPreview = previews.at(-1) ? parse(results.get(previews.at(-1)!.id)?.text ?? "") : (lastResult?.preview ?? null)
  const issues: Any[] = lastPreview?.issues ?? []
  const midAir = issues.some((i) => i.code === "starts_mid_air")
  return {
    intent,
    intentOk: intent === want.intent,
    previewed,
    startsMidAir: midAir,
    qualityWarnings: issues.filter((i) => i.severity === "warn").map((i) => i.code),
  }
}

/** Photo scenarios: did the agent's measured dimension (a Customizer parameter) land within tolerance of the truth? */
async function measureMetric(sc: Scenario, run: Run, stack: Stack) {
  const want = sc.expect.measure
  if (!want) return {}
  const project = await stack.api<Any>("GET", `/api/projects/${run.projectId}`).catch(() => ({ parts: [] }))
  const re = new RegExp(want.param, "i")
  let best: { name: string; value: number; err: number } | null = null
  for (const p of project.parts ?? []) {
    const params = await stack.api<Any[]>("GET", `/api/projects/${run.projectId}/parts/${p.id}/parameters`).catch(() => [])
    for (const q of params) {
      if (typeof q.value !== "number" || !re.test(q.name)) continue
      const err = Math.abs(q.value - want.truth) / want.truth
      if (!best || err < best.err) best = { name: `${p.id}.${q.name}`, value: q.value, err }
    }
  }
  return {
    measured: best ? `${best.name}=${best.value}` : null,
    measureOk: best ? best.err <= want.tolerance : false,
  }
}

// ---------------------------------------------------------------------------------------------
// LLM judge (user-visible transcript only)
// ---------------------------------------------------------------------------------------------
/** Tool inputs from the model can arrive as a JSON string instead of an array. */
function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String)
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      if (Array.isArray(p)) return p.map(String)
    } catch {
      /* plain text */
    }
    return [v]
  }
  return []
}

function visibleTranscript(run: Run): string {
  const lines: string[] = []
  const results = toolResults(run.events)
  for (const m of run.events) {
    if (m.type === "user_input") lines.push(`USER: ${m.text}`)
    if (m.type === "assistant" && !m.parent_tool_use_id) {
      for (const b of m.message.content) {
        if (b.type === "text" && b.text.trim()) lines.push(`ASSISTANT: ${b.text.trim()}`)
        if (b.type === "tool_use") {
          const name = b.name.replace(/^mcp__studio__/, "")
          if (name === "AskUserQuestion") {
            for (const q of Array.isArray(b.input.questions) ? b.input.questions : []) lines.push(`QUESTION [${q.header}]: ${q.question}\n${(q.options ?? []).map((o: Any) => `  - ${o.label}: ${o.description}${o.preview ? " [has picture]" : ""}`).join("\n")}`)
            const r = results.get(b.id)
            if (r) lines.push(`USER ANSWERED: ${r.text.replace(/You can now continue.*$/s, "").trim()}`)
          } else if (name === "share_plan") lines.push(`PLAN CARD "${b.input.title ?? ""}":\n${asList(b.input.bullets).map((x) => `  • ${x}`).join("\n")}`)
          else if (name === "render_part") lines.push(`[the app shows a 3D render of the part]`)
          else if (name === "build_assembly_guide") lines.push(`[the app shows an assembly guide + shopping list]`)
          else if (name === "request_print") lines.push(`[the app shows a print confirmation dialog]`)
        }
      }
    }
  }
  return lines.join("\n").slice(0, 30_000)
}

const RUBRIC = `You are evaluating a 3D-printing design assistant used by everyday people (ages 10-100, no CAD or printing knowledge).
Read the user-visible conversation and score 1-5 (5 = excellent) on:
- plain_language: short, friendly, no jargon (or jargon explained); units friendly to a US user.
- question_quality: asked only what mattered, with sensible recommended answers; didn't ask about things the user already said; didn't over-ask a specific request.
- fit_to_request: the design described matches what the user asked for and their answers.
- explains_assumptions: says what it assumed/decided for them and what to expect (size, mounting, colours, print time, anything to do after).
- partnership: felt like a helpful expert partner, not a form; celebrated progress lightly; never condescending.
Reply with ONLY a JSON object: {"plain_language":n,"question_quality":n,"fit_to_request":n,"explains_assumptions":n,"partnership":n,"rationale":"one line"}`

async function judge(run: Run): Promise<Any> {
  const prompt = `${RUBRIC}\n\nThe user's persona: ${run.scenario.persona}\n\nCONVERSATION:\n${visibleTranscript(run)}`
  let text = ""
  let cost = 0
  for await (const m of query({
    prompt,
    options: { model: JUDGE_MODEL, tools: [], settingSources: [], maxTurns: 1, persistSession: false } as Any,
  })) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") text += b.text
    if (m.type === "result") cost = m.total_cost_usd ?? 0
  }
  totalSpend += cost
  const j = text.match(/\{[\s\S]*\}/)
  try {
    return { ...JSON.parse(j ? j[0] : text), judgeCostUsd: +cost.toFixed(4) }
  } catch {
    return { error: "unparseable", raw: text.slice(0, 300), judgeCostUsd: cost }
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const yn = (v: boolean | null | undefined) => (v == null ? "–" : v ? "✓" : "✗")
function table(rows: Any[]) {
  const head = ["scenario", "Qs", "rnd", "rec", "stated", "plan", "checks", "bed", "guide", "motion", "slice>appr", "print", "measure", "machine", "quality", "turns", "$", "s", "judge", "cap"]
  const lines = [head.join(" | ")]
  for (const r of rows) {
    const m = r.metrics
    const j = r.judge && !r.judge.error ? ((r.judge.plain_language + r.judge.question_quality + r.judge.fit_to_request + r.judge.explains_assumptions + r.judge.partnership) / 5).toFixed(1) : "–"
    lines.push(
      [
        r.id,
        m.questions,
        m.questionRounds,
        yn(m.everyQuestionRecommended),
        m.askedAboutStated.length,
        yn(m.planShared),
        yn(m.checksPass),
        yn(m.fitsBed),
        m.guideNeeded ? yn(m.guidePresent) : "–",
        yn(m.checkMotionRun),
        yn(m.sliceAfterApproval),
        yn(m.printRequested),
        m.measured !== undefined ? `${yn(m.measureOk)} ${m.measured ?? ""}` : "–",
        m.machineRecommended !== undefined ? `${yn(m.machineRecommended)}${m.machineUsed ? " used" : ""}` : "–",
        m.intent !== undefined ? `${m.intent ?? "?"} ${yn(m.intentOk)} prev${yn(m.previewed)} midair${m.startsMidAir ? "✗" : "✓"}` : "–",
        m.turns,
        m.costUsd.toFixed(2),
        m.wallS,
        j,
        m.capHit ?? "",
      ].join(" | "),
    )
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  const all: Scenario[] = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8")).scenarios
  const scenarios = ONLY ? all.filter((s) => ONLY.includes(s.id)) : all
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const outDir = join(HERE, "results", stamp)
  mkdirSync(outDir, { recursive: true })
  console.log(`eval: ${scenarios.length} scenarios, model=${MODEL}, judge=${JUDGE ? JUDGE_MODEL : "off"}, workers=${CONCURRENCY}`)
  delete process.env.ANTHROPIC_API_KEY // use the claude login, like the app

  // Test photos: OpenSCAD scenes rendered top-down (orthographic) to PNG, deterministic.
  const photos = new Map<string, string>()
  for (const sc of scenarios.filter((s) => s.photo)) {
    const png = join(outDir, `${sc.id}.png`)
    await new Promise<void>((res, rej) => {
      const c = spawn(OPENSCAD, ["-o", png, "--imgsize=1200,800", "--projection=o", "--camera=110,40,0,0,0,0,400", "--colorscheme=Tomorrow", join(HERE, sc.photo!)], { stdio: "ignore" })
      c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`photo render failed for ${sc.id}`))))
    })
    photos.set(sc.id, readFileSync(png).toString("base64"))
  }

  const workers = Math.max(1, Math.min(CONCURRENCY, scenarios.length))
  const stacks = await Promise.all(Array.from({ length: workers }, (_, i) => startStack(i)))

  const rows: Any[] = []
  const queue = [...scenarios]
  const worker = async (stack: Stack) => {
    for (let sc = queue.shift(); sc; sc = queue.shift()) {
      if (totalSpend >= BUDGET) {
        console.log(`[${sc.id}] skipped: budget $${BUDGET} reached`)
        rows.push({ id: sc.id, skipped: "budget" })
        continue
      }
      try {
        const run = await runScenario(sc, stack, photos.get(sc.id))
        const m = { ...metrics(run, stack.home), ...(await measureMetric(sc, run, stack)), ...machineMetric(sc, run), ...qualityMetric(sc, run) }
        const j = JUDGE ? await judge(run).catch((e) => ({ error: String(e) })) : null
        rows.push({ id: sc.id, metrics: m, judge: j, transcript: visibleTranscript(run) })
        console.log(`[${sc.id}] $${m.costUsd} (total spend $${totalSpend.toFixed(2)})`)
      } catch (e) {
        console.error(`[${sc.id}] failed`, e)
        rows.push({ id: sc.id, error: String(e) })
      }
    }
  }
  await Promise.all(stacks.map(worker))

  const scored = rows.filter((r) => r.metrics)
  scored.sort((a, b) => scenarios.findIndex((s) => s.id === a.id) - scenarios.findIndex((s) => s.id === b.id))
  const summary = table(scored)
  const judgeLines = scored
    .filter((r) => r.judge && !r.judge.error)
    .map((r) => `- **${r.id}**: plain ${r.judge.plain_language}, questions ${r.judge.question_quality}, fit ${r.judge.fit_to_request}, assumptions ${r.judge.explains_assumptions}, partner ${r.judge.partnership}. ${r.judge.rationale}`)
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ model: MODEL, judgeModel: JUDGE ? JUDGE_MODEL : null, totalSpendUsd: totalSpend, caps: CAPS, rows }, null, 2))
  writeFileSync(
    join(outDir, "report.md"),
    `# Agent eval: ${stamp}\n\nModel: ${MODEL} · judge: ${JUDGE ? JUDGE_MODEL : "off"} · total spend ≈ $${totalSpend.toFixed(2)}\n\n` +
      "Columns: Qs = discovery questions, rnd = discovery rounds, rec = every question had a recommended option, stated = questions about things the user already said, plan = share_plan, checks/bed = last check pass / fits bed, guide = assembly guide when needed, motion = check_motion when motions exist, slice>appr = first slice after approval, print = print requested, judge = mean of 5 rubric scores.\n\n" +
      "```\n" + summary + "\n```\n\n## Judge\n\n" + judgeLines.join("\n") + "\n\n## Transcripts\n\n" +
      scored.map((r) => `### ${r.id}\n\n\`\`\`\n${r.transcript}\n\`\`\``).join("\n\n") + "\n",
  )
  console.log("\n" + summary + `\n\ntotal spend ≈ $${totalSpend.toFixed(2)} → ${join(outDir, "report.md")}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    stopAll()
    setTimeout(() => process.exit(), 1500)
  })
