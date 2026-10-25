// OpenSCAD CLI runner: bounded concurrency queue, timeout, -D param formatting, Customizer parsing.
import { spawn } from "node:child_process"
import { openscadEnv } from "./libraries"
import type { ParamValues } from "./index"
import { openscadBin } from "../tools/index"

export const MAX_CONCURRENT = 2
export const TIMEOUT_MS = 120_000

let active = 0
const waiting: (() => void)[] = []

export function queueState() {
  return { active, waiting: waiting.length }
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

export class OpenScadError extends Error {
  constructor(
    message: string,
    public stderr: string,
    public timedOut = false,
  ) {
    super(message)
  }
}

export interface RunResult {
  stdout: string
  stderr: string
  durationMs: number
}

/** Run OpenSCAD with the given args (queued, max 2 at once, 120 s timeout). Rejects on non-zero exit. */
export function runOpenscad(args: string[], cwd: string): Promise<RunResult> {
  return withSlot(
    () =>
      new Promise<RunResult>((resolveRun, reject) => {
        const t0 = Date.now()
        let bin: string
        try {
          bin = openscadBin()
        } catch (e) {
          reject(new OpenScadError((e as Error).message, ""))
          return
        }
        const child = spawn(bin, ["--backend", "Manifold", ...args], {
          cwd,
          env: openscadEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        child.stdout.on("data", (d) => (stdout += d))
        child.stderr.on("data", (d) => (stderr += d))
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGKILL")
        }, TIMEOUT_MS)
        child.on("error", (e) => {
          clearTimeout(timer)
          reject(new OpenScadError(`could not start OpenSCAD at ${bin}: ${e.message}`, stderr))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          const durationMs = Date.now() - t0
          if (timedOut) {
            return reject(
              new OpenScadError(
                `OpenSCAD timed out after ${TIMEOUT_MS / 1000}s. Hint: lower $fn, avoid or simplify minkowski()/hull() over many objects, reduce the number of boolean operations.`,
                stderr,
                true,
              ),
            )
          }
          const errs = scadErrors(stderr)
          if (code !== 0) {
            return reject(new OpenScadError(errs || `OpenSCAD exited with code ${code}: ${tail(stderr)}`, stderr))
          }
          resolveRun({ stdout, stderr, durationMs })
        })
      }),
  )
}

/** ERROR / WARNING lines from OpenSCAD stderr, for reporting back to the agent. */
export function scadErrors(stderr: string): string {
  return stderr
    .split("\n")
    .filter((l) => /^(ERROR|WARNING|TRACE)/.test(l.trim()) || /Current top level object is empty/.test(l))
    .join("\n")
    .trim()
}

const tail = (s: string, n = 800) => (s.length > n ? "…" + s.slice(-n) : s).trim()

/** Format params as OpenSCAD -D args. Strings are quoted; booleans/numbers literal. */
export function paramArgs(params?: ParamValues): string[] {
  if (!params) return []
  const out: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid parameter name: ${k}`)
    let lit: string
    if (typeof v === "boolean") lit = v ? "true" : "false"
    else if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`invalid number for ${k}`)
      lit = String(v)
    } else lit = JSON.stringify(String(v))
    out.push("-D", `${k}=${lit}`)
  }
  return out
}

export { parseCustomizer } from "./customizer"
