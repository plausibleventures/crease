// The Grok agent's shell, run by the app (R11e). With the ACP `terminal` client capability, Grok sends every command
// (run_terminal_command, background commands, monitors) as terminal/create + terminal/output / wait_for_exit / kill /
// release. Crease runs it under macOS `sandbox-exec` with the profile below: the same boundary Claude's Bash has
// (sandbox.ts) and Codex's permission profile has:
// - no network at all (every host, including 127.0.0.1 and every printer);
// - writes only inside the project folder and the temp dirs; app-owned paths (build/, renders/, .studio/, .git/,
//   .claude/, .grok/, .agents/, .mcp.json, project.json, CLAUDE*.md, AGENTS.md) and G-code anywhere are denied;
// - the app's secret files and the Grok sign-in are unreadable;
// - an environment without names containing KEY/TOKEN/SECRET/PASSWORD.
// Seatbelt matches real (symlink-resolved) paths, so the project root is canonicalized first.
import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { shellHome, shellToolchainDirs } from "../../readscope"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

export function sandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
/** SBPL string literal. */
const lit = (s: string) => JSON.stringify(s)
/** Regex-escape a path for an SBPL `#"…"` regex. */
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"')

export interface ShellProfileOptions {
  /** Project folder (writable, except the app-owned paths). */
  root: string
  /** Files nobody's commands may read (app settings/secrets, the Grok sign-in). */
  denyRead?: string[]
  /** Extra writable folders (tests). The OS temp dirs are always writable. */
  writable?: string[]
  /**
   * Folders outside the project commands may read (readscope.ts). Set = file contents and listings under the home
   * folder are unreadable except the project, these and the toolchains installed there (metadata stays readable so
   * path lookups work).
   */
  readRoots?: string[]
  /** The home folder (tests). */
  home?: string
}

/** The Seatbelt (SBPL) profile for one project's commands. */
export function shellProfile(o: ShellProfileOptions): string {
  const root = real(o.root)
  const R = rx(root)
  const temps = [...new Set([real(tmpdir()), "/private/tmp", "/private/var/tmp", ...(o.writable ?? []).map(real)])]
  const top = ["build", "renders", ".mcp.json", "project.json"].map((p) => `(subpath ${lit(join(root, p))})`)
  const anywhere = [".git", ".studio", ".claude", ".grok", ".agents"].map((d) => `(regex #"^${R}/(.*/)?${rx(d)}(/|$)")`)
  const names = `(regex #"^${R}/(.*/)?(CLAUDE|CLAUDE\\.local|AGENTS|AGENTS\\.override)\\.md$")`
  const gcode = `(regex #"\\.(gcode|bgcode|gco|g)$")`
  const denyRead = [...new Set((o.denyRead ?? []).flatMap((p) => [p, real(p)]))].map((p) => `(literal ${lit(p)})`)
  const home = o.home ?? homedir()
  const homeRead = o.readRoots
    ? [
        `(deny file-read-data (subpath ${lit(home)}) (subpath ${lit(real(home))}))`,
        `(allow file-read-data ${[...new Set([root, ...o.readRoots, ...shellToolchainDirs(process.env, home)].flatMap((p) => [p, real(p)]))].map((p) => `(subpath ${lit(p)})`).join(" ")})`,
      ]
    : []
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${lit(root)}) ${temps.map((t) => `(subpath ${lit(t)})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
    `(deny file-write* ${[...top, ...anywhere, names, gcode].join(" ")})`,
    ...homeRead,
    ...(denyRead.length ? [`(deny file-read* ${denyRead.join(" ")})`] : []),
    "",
  ].join("\n")
}

/** The environment commands get: the app's, minus anything that looks like a credential. */
export function shellEnv(base: NodeJS.ProcessEnv, extra: { name: string; value: string }[] = []): Record<string, string> {
  const secret = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !secret.test(k) && !k.startsWith("GROK_")) env[k] = v
  for (const e of extra) if (e && typeof e.name === "string" && !secret.test(e.name)) env[e.name] = String(e.value ?? "")
  return env
}

interface Term {
  child: ChildProcess
  out: Buffer[]
  bytes: number
  limit: number
  truncated: boolean
  exit: { exitCode: number | null; signal: string | null } | null
  waiters: ((e: { exitCode: number | null; signal: string | null }) => void)[]
}

export interface TerminalCreate {
  command: string
  args?: string[]
  env?: { name: string; value: string }[]
  cwd?: string | null
  outputByteLimit?: number | null
}

/** How a command is started (tests replace it to run without sandbox-exec). */
export type CommandSpawner = (argv: string[], o: { cwd: string; env: Record<string, string> }) => ChildProcess

export const defaultSpawner: CommandSpawner = (argv, o) =>
  spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" })

/** One session's terminals (ACP terminal/*). Every command runs sandboxed; the cwd must be inside the project. */
export class Terminals {
  private terms = new Map<string, Term>()
  private n = 0

  constructor(
    private o: ShellProfileOptions & { baseEnv?: NodeJS.ProcessEnv; spawner?: CommandSpawner; sandbox?: boolean }
  ) {}

  create(p: TerminalCreate): { terminalId: string } {
    const root = real(this.o.root)
    const cwd = p.cwd ? real(p.cwd) : root
    if (cwd !== root && !cwd.startsWith(root + "/")) throw new Error(`Commands run inside the project folder; ${p.cwd} is outside it.`)
    const cmd = Array.isArray(p.args) && p.args.length ? [p.command, ...p.args.map(String)] : ["/bin/sh", "-c", String(p.command)]
    const argv = this.o.sandbox === false ? cmd : [SANDBOX_EXEC, "-p", shellProfile(this.o), ...cmd]
    const env = shellEnv(this.o.baseEnv ?? process.env, p.env)
    // With the home folder unreadable, a login shell would complain about ~/.profile on every command: commands get an
    // empty home of their own (PATH still comes from the app, so toolchains are found).
    if (this.o.readRoots) env.HOME = shellHome()
    const child = (this.o.spawner ?? defaultSpawner)(argv, { cwd, env })
    const id = `t${++this.n}`
    const t: Term = { child, out: [], bytes: 0, limit: Math.max(1024, Number(p.outputByteLimit) || 1_000_000), truncated: false, exit: null, waiters: [] }
    const add = (d: Buffer) => {
      t.out.push(d)
      t.bytes += d.length
      while (t.bytes > t.limit && t.out.length > 1) {
        t.bytes -= t.out.shift()!.length
        t.truncated = true
      }
    }
    child.stdout?.on("data", add)
    child.stderr?.on("data", add)
    const finish = (exitCode: number | null, signal: string | null) => {
      if (t.exit) return
      t.exit = { exitCode, signal }
      for (const w of t.waiters.splice(0)) w(t.exit)
    }
    child.once("exit", (code, signal) => finish(code, signal))
    child.once("error", (e) => {
      add(Buffer.from(`Couldn't run the command: ${e.message}\n`))
      finish(127, null)
    })
    this.terms.set(id, t)
    return { terminalId: id }
  }

  private get(id: string): Term {
    const t = this.terms.get(String(id))
    if (!t) throw new Error(`No terminal ${id}`)
    return t
  }

  output(id: string) {
    const t = this.get(id)
    let output = Buffer.concat(t.out).toString("utf8")
    if (output.length > t.limit) output = output.slice(output.length - t.limit)
    return { output, truncated: t.truncated, exitStatus: t.exit }
  }

  waitForExit(id: string): Promise<{ exitCode: number | null; signal: string | null }> {
    const t = this.get(id)
    return t.exit ? Promise.resolve(t.exit) : new Promise((r) => t.waiters.push(r))
  }

  kill(id: string) {
    const t = this.get(id)
    if (!t.exit) killTree(t.child)
    return {}
  }

  release(id: string) {
    const t = this.terms.get(String(id))
    if (t && !t.exit) killTree(t.child)
    this.terms.delete(String(id))
    return {}
  }

  /** Stop every running command (turn stopped / session closed). */
  killAll() {
    for (const t of this.terms.values()) if (!t.exit) killTree(t.child)
  }
}

function killTree(c: ChildProcess) {
  try {
    if (c.pid && process.platform !== "win32") process.kill(-c.pid, "SIGTERM")
    else c.kill("SIGTERM")
  } catch {
    try {
      c.kill("SIGTERM")
    } catch {
      /* gone */
    }
  }
}
