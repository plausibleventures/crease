// Grok device sign-in: the URL and the code come out of real `grok login --device-auth` output (Grok 1.0.5, stderr,
// ANSI colours; fixtures/device-auth.txt, code replaced), even when it arrives in pieces; the outcome follows the exit.
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { DeviceLogin, asksForEnter, parseDeviceAuth, stripAnsi } from "./login"

const FIXTURE = readFileSync(fileURLToPath(new URL("./fixtures/device-auth.txt", import.meta.url)), "utf8")
const URL_ = "https://accounts.x.ai/oauth2/device?user_code=7QXK-4TB2"

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  killed: string | null = null
  written = ""
  constructor() {
    super()
    this.stdin.on("data", (d) => (this.written += d.toString()))
  }
  kill(sig: string = "SIGTERM") {
    this.killed = sig
    setImmediate(() => this.emit("exit", null))
    return true
  }
}

describe("parseDeviceAuth", () => {
  it("reads the URL and the code from the real output", () => {
    expect(FIXTURE).toContain("\x1b[90m")
    expect(parseDeviceAuth(FIXTURE)).toEqual({ authUrl: URL_, code: "7QXK-4TB2" })
  })

  it("waits for the whole URL and the code", () => {
    expect(parseDeviceAuth("To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/dev")).toBeNull()
    // a URL without the code in it: the code line after it is used
    const t = "Open https://accounts.x.ai/device\n\nConfirm this code in your browser:\n\n  \x1b[1mAB12-CD34\x1b[0m\n"
    expect(parseDeviceAuth(t)).toEqual({ authUrl: "https://accounts.x.ai/device", code: "AB12-CD34" })
    expect(parseDeviceAuth("Open https://accounts.x.ai/device\n")).toBeNull()
  })

  it("strips colour codes and spots an Enter prompt", () => {
    expect(stripAnsi("\x1b[90mhi\x1b[0m")).toBe("hi")
    expect(asksForEnter("Press \x1b[1mEnter\x1b[0m to open the browser")).toBe(true)
    expect(asksForEnter(FIXTURE)).toBe(false)
  })
})

describe("DeviceLogin", () => {
  it("returns the code from output in pieces, then reports done on exit 0", async () => {
    const child = new FakeChild()
    let exited: boolean | null = null
    const login = new DeviceLogin(child, { onExit: (ok) => (exited = ok) })
    expect(login.status()).toMatchObject({ state: "waiting", code: null })
    for (let i = 0; i < FIXTURE.length; i += 17) child.stderr.write(FIXTURE.slice(i, i + 17))
    await expect(login.started).resolves.toEqual({ authUrl: URL_, code: "7QXK-4TB2" })
    expect(login.status()).toEqual({ state: "waiting", authUrl: URL_, code: "7QXK-4TB2", error: null })
    child.emit("exit", 0)
    expect(login.status().state).toBe("done")
    expect(exited).toBe(true)
  })

  it("presses Enter when asked", async () => {
    const child = new FakeChild()
    const login = new DeviceLogin(child)
    child.stdout.write("Press Enter to continue\n")
    child.stderr.write(FIXTURE)
    await login.started
    expect(child.written).toBe("\n")
  })

  it("a sign-in that ends badly or is cancelled is failed, with plain words", async () => {
    const a = new FakeChild()
    const la = new DeviceLogin(a)
    a.stderr.write(FIXTURE)
    await la.started
    a.stderr.write("\nError: device code expired\n")
    await new Promise((r) => setImmediate(r))
    a.emit("exit", 1)
    expect(la.status()).toMatchObject({ state: "failed", error: "The code expired. Start again." })

    const b = new FakeChild()
    const lb = new DeviceLogin(b)
    b.stderr.write(FIXTURE)
    await lb.started
    lb.cancel()
    expect(b.killed).toBe("SIGTERM")
    expect(lb.status()).toMatchObject({ state: "failed", error: "Sign-in cancelled." })
  })

  it("fails the start when Grok exits before printing a code", async () => {
    const child = new FakeChild()
    const login = new DeviceLogin(child)
    child.emit("exit", 2)
    await expect(login.started).rejects.toThrow(/exit 2/)
    expect(login.status().state).toBe("failed")
  })
})
