// Spawning the Claude Code CLI for a session, so that it never outlives us.
//
// Measured with CLI 2.1.292: if the server dies while the CLI is idle, the stdin EOF makes the CLI exit by
// itself. If it dies mid-tool (e.g. a Bash command running), the CLI is re-parented to launchd and keeps going,
// burning tokens. So:
//  - the CLI runs in its own process group (detached), so we can kill it together with its tool subprocesses;
//  - killAllAgentProcesses() kills every group synchronously (safe to call from 'exit' handlers);
//  - a tiny `sh` watchdog per session (about 1 MB) polls our pid every 2 s. If we're gone (even after SIGKILL,
//    which no handler can catch), it sends TERM to the CLI's group, then KILL after 3 s. It exits on its own
//    once the CLI exits.
import { spawn, type ChildProcess } from "node:child_process"
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

const live = new Set<ChildProcess>()

const WATCHDOG = `P=$1; C=$2
while kill -0 "$P" 2>/dev/null && kill -0 "$C" 2>/dev/null; do sleep 2; done
if kill -0 "$C" 2>/dev/null; then kill -TERM -"$C" 2>/dev/null; sleep 3; kill -KILL -"$C" 2>/dev/null; fi`

export function spawnAgentProcess(opts: SpawnOptions, onStderr?: (d: string) => void): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", // own process group (pgid = child.pid)
    signal: opts.signal, // the SDK's forwarded signal: fires after its graceful stdin-EOF window
  })
  child.stderr?.on("data", (d: Buffer) => onStderr?.(d.toString()))
  live.add(child)
  child.once("exit", () => live.delete(child))
  child.once("error", () => live.delete(child))

  if (child.pid && process.platform !== "win32") {
    try {
      spawn("/bin/sh", ["-c", WATCHDOG, "sh", String(process.pid), String(child.pid)], { detached: true, stdio: "ignore" }).unref()
    } catch (e) {
      console.error("[agent] watchdog spawn failed", e)
    }
  }
  return child as unknown as SpawnedProcess
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/** Synchronously signal every live CLI process group. SIGTERM first; callers on the way out may follow with SIGKILL. */
export function killAllAgentProcesses(signal: NodeJS.Signals = "SIGTERM") {
  for (const c of live) killGroup(c, signal)
}

export function liveAgentProcessCount() {
  return live.size
}

// Last line of defence on any normal exit path (process.exit, end of event loop, Electron quit).
process.on("exit", () => killAllAgentProcesses("SIGTERM"))
