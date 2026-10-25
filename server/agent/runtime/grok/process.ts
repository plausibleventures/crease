// `grok agent stdio` as a child process: own process group + parent-death watchdog (spawn.ts, shared with Claude and
// Codex), so the agent dies with the app. stdio is the ACP (JSON-RPC 2.0) transport.
import { execFile, type ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { redactSecrets } from "../../../secrets"
import { spawnAgentProcess } from "../../spawn"
import type { RpcTransport } from "../codex/rpc"

/** Where to look for the grok CLI: PRINTSTUDIO_GROK_BIN, PATH, then the installer's ~/.grok/bin. */
export function findGrokBinary(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".grok", "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean)
  for (const p of [process.env.PRINTSTUDIO_GROK_BIN, ...dirs.map((d) => join(d, "grok"))]) {
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

export function spawnGrok(opts: { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }): RpcTransport {
  const abort = new AbortController()
  let stderrTail = ""
  const child = spawnAgentProcess({ command: opts.bin, args: opts.args, cwd: opts.cwd, env: opts.env, signal: abort.signal }, (d) => {
    stderrTail = (stderrTail + d).slice(-4000)
    if (process.env.PRINTSTUDIO_AGENT_DEBUG) process.stderr.write(`[grok:stderr] ${redactSecrets(d)}`)
  }) as unknown as ChildProcess
  const lines: ((l: string) => void)[] = []
  const closers: ((e?: string) => void)[] = []
  let ended = false
  const end = (e?: string) => {
    if (ended) return
    ended = true
    for (const c of closers) c(e)
  }
  if (child.stdout) createInterface({ input: child.stdout }).on("line", (l) => lines.forEach((f) => f(l)))
  child.once("exit", (code, signal) => {
    if (code === 0 || signal === "SIGTERM") return end()
    const why = grokExitReason(stderrTail)
    end(`Grok stopped unexpectedly (${signal ?? `exit ${code}`})${why ? `: ${redactSecrets(why)}` : "."}`)
  })
  child.once("error", (e) => end(`Couldn't start Grok: ${e.message}`))
  child.stdin?.on("error", () => {})
  return {
    write: (l) => {
      if (!ended) child.stdin?.write(l + "\n")
    },
    onLine: (cb) => lines.push(cb),
    onClose: (cb) => closers.push(cb),
    close: () => {
      try {
        child.stdin?.end() // the agent exits on stdin EOF
      } catch {
        /* gone */
      }
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

/** The line that says why Grok quit (its last "error:" line, else the last line), from the end of its stderr. */
export function grokExitReason(stderr: string): string | null {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean)
  const line = [...lines].reverse().find((l) => /^error:/i.test(l)) ?? lines.at(-1)
  return line ? line.replace(/^error:\s*/i, "").slice(0, 300) : null
}

/** Run a short grok command (version, models). Never throws: {code: null} if it couldn't run. */
export function runGrok(bin: string, args: string[], env: Record<string, string>, timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null) : 0
      res({ code, out: `${stdout ?? ""}${stderr ?? ""}` })
    })
  })
}
