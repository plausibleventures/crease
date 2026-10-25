// Running Blender part scripts (parts/<id>.blend.py) headless, sandboxed, cached. See sculpt.ts for the convention.
//
// Threat model. A part script is arbitrary Python with Blender's full API. The designer writes it (and could be
// steered by text in an imported file), and scripts can arrive from elsewhere (a shared build pack, a copied project
// folder). So Blender never runs a script outside this sandbox, and only the app starts it (the designer's shell is
// refused `blender`, policy.ts):
//   - macOS sandbox-exec profile (blenderSandboxProfile): no network at all (incl. localhost and DNS); no
//     process-exec except the Blender binary itself (no shells, curl, open); no mach-lookup (no LaunchServices /
//     pasteboard / Apple events, so nothing can be handed to another app); writes only into a fresh temp folder; reads
//     of /Users, /Volumes and the per-user temp folders are denied except the Blender app, that temp folder and the
//     project's parts/, lib/ and refs/ (read-only). STUDIO_HOME (settings, secrets, other projects) is unreadable.
//   - A minimal environment (no API keys, HOME = the temp folder), --factory-startup (no user prefs, add-ons or
//     startup scripts), --disable-autoexec, -noaudio, a thread cap.
//   - Limits: wall-clock timeout, CPU-time and output-file-size ulimits, and a resident-memory watchdog.
//   - One Blender at a time.
//   - Scripts that came in a build pack don't run until the user allows them (sculpt-trust.ts).
// What a script can still do: burn CPU until the timeout and write a mesh. The mesh is data, checked like any other.
// Other platforms: not supported yet (no sandbox wired up), so Blender parts refuse to build there.
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir, totalmem } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { STUDIO_HOME } from "../config"
import { appBundleOf } from "../tools/discovery"
import { blenderBin } from "../tools/index"
import { effectiveScript, sculptLibDeps, sculptView, sculptWrapperRel, type SculptBody } from "./sculpt"
import { blockedReason } from "./sculpt-trust"

/** Bump when runner.py / printstudio.py change what they produce (invalidates cached meshes). */
export const RUNNER_VERSION = "2"
export const SCULPT_PY_DIR = fileURLToPath(new URL("./sculpt-py/", import.meta.url))
const HELPERS = ["runner.py", "printstudio.py"] as const

export const MAX_FACES = 300_000
const timeoutMs = () => Number(process.env.PRINTSTUDIO_BLENDER_TIMEOUT_MS) || 240_000
/** Resident memory cap: 8 GB, or half the machine's memory if that's less (at least 2 GB). */
const memCapBytes = () => Number(process.env.PRINTSTUDIO_BLENDER_MAX_RSS_MB) * 1024 * 1024 || Math.max(2 * 1024 ** 3, Math.min(8 * 1024 ** 3, totalmem() / 2))
const THREADS = 4
const KEEP_BUILDS = 3

export class SculptError extends Error {
  constructor(
    message: string,
    public code: "SCRIPT" | "TIMEOUT" | "MEMORY" | "BLOCKED" | "UNSUPPORTED" | "TOOL_MISSING" | "BLENDER" = "BLENDER",
    public log = "",
  ) {
    super(message)
  }
}

const sq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export interface ProfileOptions {
  /** the real Blender binary (the only program allowed to start) */
  bin: string
  /** the only writable folder (also holds the script and helpers) */
  outDir: string
  /** folders the script may read (the project's parts/, lib/, refs/) */
  readDirs: string[]
}

/** The sandbox-exec (SBPL) profile for one Blender run. Later rules win over earlier ones. */
export function blenderSandboxProfile(o: ProfileOptions): string {
  const bin = real(o.bin)
  const app = appBundleOf(bin) ?? dirname(bin)
  const out = real(o.outDir)
  const reads = o.readDirs.filter((d) => existsSync(d)).map(real)
  const hidden = ["/Users", "/Volumes", "/private/var/folders", "/private/tmp", "/var/folders", "/tmp", real(STUDIO_HOME)]
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-exec)",
    `(allow process-exec (literal ${sq(bin)}))`,
    "(deny mach-lookup)",
    "(deny mach-register)",
    "(deny appleevent-send)",
    "(deny lsopen)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${sq(out)}) (literal "/dev/null"))`,
    `(deny file-read* ${[...new Set(hidden)].map((h) => `(subpath ${sq(h)})`).join(" ")})`,
    `(allow file-read* (literal "/Users") (subpath ${sq(app)}) (subpath ${sq(out)})${reads.map((d) => ` (subpath ${sq(d)})`).join("")})`,
    "",
  ].join("\n")
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  memoryKilled: boolean
  durationMs: number
}

const CAP = 1024 * 1024
let active: Promise<unknown> = Promise.resolve()
/** One Blender at a time (each can use several GB). */
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = active.catch(() => {}).then(fn)
  active = next
  return next
}

function rssBytes(pid: number): Promise<number> {
  return new Promise((res) =>
    execFile("/bin/ps", ["-o", "rss=", "-p", String(pid)], (err, out) => res(err ? 0 : (parseInt(String(out).trim(), 10) || 0) * 1024)),
  )
}

/**
 * Run Blender headless in the sandbox: `--python <python>` with `-- <args>`. Only for scripts in `outDir`.
 * Exported for the sandbox tests.
 */
export function runBlenderSandboxed(o: ProfileOptions & { python: string; args?: string[]; timeoutMs?: number; maxRssBytes?: number }): Promise<RunResult> {
  if (process.platform !== "darwin")
    return Promise.reject(new SculptError("Sculpted parts (Blender) need macOS for now: Crease only runs Blender inside macOS's sandbox.", "UNSUPPORTED"))
  const limit = o.timeoutMs ?? timeoutMs()
  const maxRss = o.maxRssBytes ?? memCapBytes()
  return oneAtATime(
    () =>
      new Promise<RunResult>((resolve, reject) => {
        const t0 = Date.now()
        const profile = blenderSandboxProfile(o)
        const blenderArgs = ["-b", "--factory-startup", "--disable-autoexec", "-noaudio", "--python-exit-code", "3", "-t", String(THREADS), "--python", o.python, "--", ...(o.args ?? [])]
        const cpuSeconds = Math.ceil((limit / 1000) * THREADS) + 30
        const child = spawn(
          "/bin/sh",
          ["-c", 'ulimit -t "$1"; ulimit -f "$2"; shift 2; exec /usr/bin/sandbox-exec -p "$@"', "ps-blender", String(cpuSeconds), String(2 * 1024 * 1024), profile, real(o.bin), ...blenderArgs],
          {
            cwd: o.outDir,
            // Nothing from the app's environment (API keys, tokens): just enough for Blender to start.
            env: { HOME: o.outDir, TMPDIR: o.outDir, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", BLENDER_USER_RESOURCES: join(o.outDir, ".blender") },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        let stdout = ""
        let stderr = ""
        let timedOut = false
        let memoryKilled = false
        child.stdout.on("data", (d) => stdout.length < CAP && (stdout += d))
        child.stderr.on("data", (d) => stderr.length < CAP && (stderr += d))
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, limit)
        const watch = setInterval(async () => {
          if (!child.pid || child.exitCode !== null) return
          if ((await rssBytes(child.pid)) > maxRss) {
            memoryKilled = true
            child.kill("SIGKILL")
          }
        }, 750)
        child.on("error", (e) => {
          clearTimeout(timer)
          clearInterval(watch)
          reject(new SculptError(`couldn't start Blender: ${e.message}`))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          clearInterval(watch)
          resolve({ code, stdout, stderr, timedOut, memoryKilled, durationMs: Date.now() - t0 })
        })
      }),
  )
}

export interface SculptBuild {
  /** build/<id>.blend.scad: what OpenSCAD renders / exports for this part */
  wrapperAbs: string
  bodies: (SculptBody & { faces: number })[]
  /** plain-words notes from the build (simplified, moved onto the bed), for the designer */
  notes: string[]
  cached: boolean
  hash: string
}

interface Report {
  bodies: { file: string; color: string | null; faces: number }[]
  notes: string[]
  seconds: number
}

let engineKey: string | null = null
/** The runner's version and helper files: a render made with an older runner is redone (cad/index.ts). */
export function sculptEngineKey(): string {
  if (!engineKey) {
    const h = createHash("sha256").update(`runner:${RUNNER_VERSION}\n`)
    for (const f of HELPERS) h.update(readFileSync(join(SCULPT_PY_DIR, f)))
    engineKey = h.digest("hex").slice(0, 12)
  }
  return engineKey
}

/** Hash of everything a build depends on: runner, helpers, the script with its values, the lib/ files it imports. */
export function sculptHash(effective: string, libFiles: string[], root: string): string {
  const h = createHash("sha256").update(`runner:${RUNNER_VERSION}\n`)
  for (const f of HELPERS) h.update(readFileSync(join(SCULPT_PY_DIR, f)))
  h.update(effective)
  for (const f of libFiles) h.update(`\n${relative(root, f)}\n`).update(readFileSync(f))
  return h.digest("hex").slice(0, 16)
}

/** The script's error, as the designer needs it: the traceback with the part's own file name and line numbers. */
function explain(r: RunResult, outDir: string, scriptRel: string): SculptError {
  if (r.timedOut) return new SculptError(`Blender took longer than ${Math.round(timeoutMs() / 1000)} s and was stopped. Use a larger voxel size in ps.fuse(), fewer subdivisions or fewer pieces.`, "TIMEOUT", r.stderr)
  if (r.memoryKilled) return new SculptError(`Blender used more than ${Math.round(memCapBytes() / 1024 ** 3)} GB of memory and was stopped. Use a larger voxel size in ps.fuse() or fewer subdivision levels.`, "MEMORY", r.stderr)
  const errFile = join(outDir, "error.txt")
  if (existsSync(errFile)) return new SculptError(`${scriptRel} failed in Blender:\n${readFileSync(errFile, "utf8").trim()}`, "SCRIPT", r.stderr)
  const tail = `${r.stderr}\n${r.stdout}`.trim().split("\n").slice(-25).join("\n")
  return new SculptError(`Blender stopped (exit code ${r.code}) while running ${scriptRel}:\n${tail}`, "BLENDER", r.stderr)
}

/** Keep the newest few builds of a part (an undo is then instant). */
function prune(partDir: string, keep: string) {
  let dirs: { d: string; t: number }[]
  try {
    dirs = readdirSync(partDir).map((d) => ({ d, t: statSync(join(partDir, d)).mtimeMs }))
  } catch {
    return
  }
  dirs.sort((a, b) => b.t - a.t)
  for (const { d } of dirs.filter((x) => x.d !== keep).slice(KEEP_BUILDS - 1)) rmSync(join(partDir, d), { recursive: true, force: true })
}

/**
 * Make (or reuse) a Blender part's mesh and write its OpenSCAD wrapper. `root` is the project folder (or an extracted
 * snapshot of it, for compare); `params` the part's saved values. Throws SculptError with a plain message.
 */
export async function buildSculpt(root: string, partId: string, scriptRel: string, params?: Record<string, number | string | boolean> | null): Promise<SculptBuild> {
  const scriptAbs = join(root, scriptRel)
  const src = readFileSync(scriptAbs, "utf8")
  const effective = effectiveScript(src, params)
  const libFiles = sculptLibDeps(scriptAbs, root)
  const hash = sculptHash(effective, libFiles, root)
  const partDir = join(root, "build", "sculpt", partId)
  const cacheDir = join(partDir, hash)
  const wrapperAbs = join(root, sculptWrapperRel(partId))
  let report: Report | null
  let cached = true
  try {
    report = JSON.parse(readFileSync(join(cacheDir, "report.json"), "utf8")) as Report
    if (!report.bodies.every((b) => existsSync(join(cacheDir, b.file)))) report = null
  } catch {
    report = null
  }
  if (!report) {
    cached = false
    const blocked = blockedReason([scriptAbs, ...libFiles].map((f) => ({ rel: relative(root, f), content: readFileSync(f) })))
    if (blocked) throw new SculptError(blocked, "BLOCKED")
    let bin: string
    try {
      bin = blenderBin()
    } catch (e) {
      throw new SculptError((e as Error).message, "TOOL_MISSING")
    }
    const tmp = real(mkdtempSync(join(tmpdir(), "printstudio-blender-")))
    try {
      for (const f of HELPERS) copyFileSync(join(SCULPT_PY_DIR, f), join(tmp, f))
      const script = join(tmp, "part.py")
      writeFileSync(script, effective)
      const job = {
        out: tmp,
        helpers: tmp,
        script,
        scriptName: scriptRel,
        maxFaces: MAX_FACES,
        project: real(root),
        ...(existsSync(join(root, "lib")) ? { lib: real(join(root, "lib")) } : {}),
      }
      writeFileSync(join(tmp, "job.json"), JSON.stringify(job))
      const readDirs = ["parts", "lib", "refs"].map((d) => join(root, d))
      const r = await runBlenderSandboxed({ bin, outDir: tmp, readDirs, python: join(tmp, "runner.py"), args: [join(tmp, "job.json")] })
      if (r.code !== 0 || r.timedOut || r.memoryKilled || !existsSync(join(tmp, "report.json"))) throw explain(r, tmp, scriptRel)
      report = JSON.parse(readFileSync(join(tmp, "report.json"), "utf8")) as Report
      // Only the files the report names, and only plain names (the script could have written anything in tmp).
      const staging = `${cacheDir}.tmp-${process.pid}`
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      for (const b of report.bodies) {
        if (!/^body-\d+\.stl$/.test(b.file)) throw new SculptError(`unexpected output file ${b.file}`)
        renameSync(join(tmp, b.file), join(staging, b.file))
      }
      writeFileSync(join(staging, "report.json"), JSON.stringify(report))
      rmSync(cacheDir, { recursive: true, force: true })
      renameSync(staging, cacheDir)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    prune(partDir, hash)
  }
  const bodies = report.bodies.map((b) => ({ file: `sculpt/${partId}/${hash}/${b.file}`, color: b.color, faces: b.faces }))
  const view = sculptView(src, bodies, scriptRel)
  mkdirSync(dirname(wrapperAbs), { recursive: true })
  let prev = ""
  try {
    prev = readFileSync(wrapperAbs, "utf8")
  } catch {
    /* first build */
  }
  if (prev !== view) {
    const t = `${wrapperAbs}.tmp-${process.pid}`
    writeFileSync(t, view)
    renameSync(t, wrapperAbs)
  }
  return { wrapperAbs, bodies, notes: report.notes ?? [], cached, hash }
}
