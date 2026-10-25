// `codex app-server` as a child process: own process group + parent-death watchdog (spawn.ts, shared with Claude),
// so the server and every command it runs die with the app. stdio is the JSON-RPC transport.
import type { ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { redactSecrets } from "../../../secrets"
import { spawnAgentProcess } from "../../spawn"
import type { RpcTransport } from "./rpc"

/** Where to look for the codex CLI: PRINTSTUDIO_CODEX_BIN, PATH, then the usual install places. */
export function findCodexBinary(): string | null {
  const env = process.env.PRINTSTUDIO_CODEX_BIN
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".codex", "packages", "standalone", "current", "bin"),
  ].filter(Boolean)
  for (const p of [env, ...dirs.map((d) => join(d, "codex"))]) {
    if (!p) continue
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      /* next */
    }
  }
  return null
}

export interface CodexProcess extends RpcTransport {
  readonly child: ChildProcess
}

export function spawnCodex(opts: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined>; debug?: boolean }): CodexProcess {
  const abort = new AbortController()
  const child = spawnAgentProcess(
    { command: opts.bin, args: ["app-server", ...opts.args], cwd: opts.cwd, env: opts.env, signal: abort.signal },
    (d) => {
      if (opts.debug || process.env.PRINTSTUDIO_AGENT_DEBUG) process.stderr.write(`[codex:stderr] ${redactSecrets(d)}`)
    }
  ) as unknown as ChildProcess
  const lines: ((l: string) => void)[] = []
  const closers: ((e?: string) => void)[] = []
  let ended = false
  const end = (e?: string) => {
    if (ended) return
    ended = true
    for (const c of closers) c(e)
  }
  if (child.stdout) createInterface({ input: child.stdout }).on("line", (l) => lines.forEach((f) => f(l)))
  child.once("exit", (code, signal) => end(code === 0 || signal === "SIGTERM" ? undefined : `Codex stopped unexpectedly (${signal ?? `exit ${code}`}).`))
  child.once("error", (e) => end(`Couldn't start Codex: ${e.message}`))
  child.stdin?.on("error", () => {}) // EPIPE after exit: reported through exit
  return {
    child,
    write: (l) => {
      if (!ended) child.stdin?.write(l + "\n")
    },
    onLine: (cb) => lines.push(cb),
    onClose: (cb) => closers.push(cb),
    close: () => {
      try {
        child.stdin?.end() // the app-server exits on stdin EOF
      } catch {
        /* gone */
      }
      // then the whole group (commands it started), after a short grace
      const t = setTimeout(() => {
        try {
          if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM")
        } catch {
          /* gone */
        }
        abort.abort()
      }, 1500)
      t.unref()
    },
  }
}
