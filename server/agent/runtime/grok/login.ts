// Grok device-code sign-in (`grok login --device-auth`) for Crease's own Grok home. Grok 1.0.5 prints, on
// stderr, with ANSI colours:
//
//   To sign in, open this URL in your browser:
//     https://accounts.x.ai/oauth2/device?user_code=372M-5RE8
//   Confirm this code in your browser:
//     372M-5RE8
//   Only continue with a code you requested. ...
//   Waiting for authorization...
//
// and exits 0 once the user approves in the browser (non-zero on denial or expiry). The sign-in page asks the user to
// type or confirm the code, so the app must show it (the bug this module fixes: the code only flashed in a toast).
// Fixture: fixtures/device-auth.txt.
import type { RuntimeLoginStatus } from "../../../../shared/types"

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (s: string) => s.replace(ANSI, "")

/** The sign-in URL and code from `grok login --device-auth` output so far, or null until both are known. */
export function parseDeviceAuth(raw: string): { authUrl: string; code: string } | null {
  const text = stripAnsi(raw).replace(/\r/g, "")
  const url = /https:\/\/[^\s"'<>]+/.exec(text)?.[0]?.replace(/[.,;)]+$/, "")
  if (!url) return null
  let code: string | null = null
  try {
    code = new URL(url).searchParams.get("user_code")
  } catch {
    /* not a URL */
  }
  // the line after "... code ...:" (Grok prints it on its own line), else a XXXX-XXXX shape anywhere outside the URL
  const after = /code[^\n]*:\s*\n\s*([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})+)\s*(\n|$)/i.exec(text)?.[1]
  code = after ?? code ?? /(?:^|\s)([A-Z0-9]{4}-[A-Z0-9]{4})(?:\s|$)/.exec(text.replace(url, ""))?.[1] ?? null
  return code ? { authUrl: url, code } : null
}

/** The CLI waits for a key press before going on (not seen in 1.0.5; handled in case a version asks). */
export const asksForEnter = (raw: string) => /press\s+(enter|return)/i.test(stripAnsi(raw))

/** A short, plain reason from the output of a sign-in that ended badly. */
export function loginFailure(raw: string, exitCode: number | null): string {
  const t = stripAnsi(raw)
  if (/expired|timed? ?out/i.test(t)) return "The code expired. Start again."
  if (/denied|declined|rejected|cancel/i.test(t)) return "The sign-in was cancelled."
  return `Grok didn't finish the sign-in${exitCode !== null ? ` (exit ${exitCode})` : ""}. Start again.`
}

/** The parts of a child process the sign-in uses (tests pass a fake). */
export interface LoginChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  stdin: NodeJS.WritableStream | null
  once(ev: "exit", fn: (code: number | null) => void): unknown
  once(ev: "error", fn: (e: Error) => void): unknown
  kill(sig?: NodeJS.Signals): unknown
}

/**
 * One device sign-in: watches the output, resolves `started` with the URL and code, answers an Enter prompt, and
 * tracks the outcome (exit 0 = signed in). `status()` is what GET /api/agent/runtimes/grok/login returns.
 */
export class DeviceLogin {
  private out = ""
  private st: RuntimeLoginStatus = { state: "waiting", authUrl: null, code: null, error: null }
  private enterSent = false
  readonly started: Promise<{ authUrl: string; code: string }>

  constructor(
    private child: LoginChild,
    o: { startTimeoutMs?: number; maxMs?: number; onExit?: (ok: boolean) => void } = {},
  ) {
    const maxTimer = setTimeout(() => this.cancel("The code expired. Start again."), o.maxMs ?? 10 * 60_000)
    maxTimer.unref?.()
    this.started = new Promise((res, rej) => {
      const giveUp = setTimeout(() => {
        this.fail("Grok didn't start the sign-in. Try again.")
        child.kill("SIGTERM")
        rej(Object.assign(new Error("Grok didn't start the sign-in. Try again."), { statusCode: 502 }))
      }, o.startTimeoutMs ?? 30_000)
      giveUp.unref?.()
      const onData = (d: Buffer | string) => {
        this.out += d.toString()
        if (!this.enterSent && asksForEnter(this.out)) {
          this.enterSent = true
          child.stdin?.write("\n")
        }
        if (this.st.authUrl) return
        const got = parseDeviceAuth(this.out)
        if (!got) return
        clearTimeout(giveUp)
        this.st = { ...this.st, ...got }
        res(got)
      }
      child.stdout?.on("data", onData)
      child.stderr?.on("data", onData)
      child.once("error", (e) => {
        clearTimeout(giveUp)
        this.fail(`Couldn't start Grok: ${e.message}`)
        rej(Object.assign(new Error(`Couldn't start Grok: ${e.message}`), { statusCode: 502 }))
      })
      child.once("exit", (code) => {
        clearTimeout(giveUp)
        clearTimeout(maxTimer)
        const ok = code === 0 && this.st.state === "waiting"
        if (ok) this.st = { ...this.st, state: "done" }
        else this.fail(loginFailure(this.out, code))
        o.onExit?.(ok)
        if (!this.st.authUrl) rej(Object.assign(new Error(loginFailure(this.out, code)), { statusCode: 502 }))
      })
    })
    this.started.catch(() => {}) // the caller awaits it; status() carries the failure too
  }

  status(): RuntimeLoginStatus {
    return { ...this.st }
  }

  cancel(reason = "Sign-in cancelled.") {
    this.fail(reason)
    this.child.kill("SIGTERM")
  }

  private fail(error: string) {
    if (this.st.state === "waiting") this.st = { ...this.st, state: "failed", error }
  }
}
