import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { appBundleOf, blenderExecutable, bundledClaudeExecutable, claudeAuthStatus, claudeCheckEnv, claudeVersion, compareVersions, discoverAll, findClaude, findTool, resolveToolPath, toolVersion } from "./discovery"
import { mergePath } from "./shell-path"
import { isClaudeAuthFailure } from "../agent/auth-error"

const root = mkdtempSync(join(tmpdir(), "printstudio-discovery-test-"))
const empty = join(root, "empty")
const apps = join(root, "apps")
mkdirSync(empty)

function fakeApp(dir: string, name: string, exe: string, version: string, script = "#!/bin/sh\necho 'OpenSCAD version 2026.10.05'\n") {
  const macos = join(dir, name, "Contents", "MacOS")
  mkdirSync(macos, { recursive: true })
  writeFileSync(
    join(dir, name, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>${version}</string></dict></plist>`,
  )
  writeFileSync(join(macos, exe), script)
  chmodSync(join(macos, exe), 0o755)
  return join(macos, exe)
}

const scad = fakeApp(apps, "OpenSCAD-2026.10.05.app", "OpenSCAD", "2026.10")
const orca = fakeApp(apps, "OrcaSlicer.app", "OrcaSlicer", "2.4.2")
const prev = process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS

beforeEach(() => {
  process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = apps
})
afterAll(() => {
  if (prev === undefined) delete process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS
  else process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = prev
  rmSync(root, { recursive: true, force: true })
})

describe("tool discovery", () => {
  it("finds .app bundles (including dated snapshot names) in the search folders", () => {
    expect(discoverAll("openscad")).toEqual([scad])
    expect(findTool("orcaslicer")).toEqual({ path: orca, source: "found" })
  })

  it("reports nothing when the search folders are empty (missing-tool path)", () => {
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = empty
    expect(findTool("openscad")).toBeNull()
    expect(findTool("orcaslicer", "/nowhere/OrcaSlicer")).toBeNull()
  })

  it("prefers the Settings path, accepting the .app or the binary inside it", () => {
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = empty
    expect(findTool("openscad", join(apps, "OpenSCAD-2026.10.05.app"))).toEqual({ path: scad, source: "settings" })
    expect(resolveToolPath("openscad", scad)).toBe(scad)
    expect(resolveToolPath("openscad", join(root, "missing.app"))).toBeNull()
  })

  it("falls back to discovery when the Settings path is gone", () => {
    expect(findTool("openscad", "/Applications/Gone.app")).toEqual({ path: scad, source: "found" })
  })

  it("finds Blender (optional): the app bundle, its version from Info.plist, and the real binary behind Homebrew's wrapper", async () => {
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = empty
    expect(findTool("blender")).toBeNull() // "Not found": everything else still works
    const bl = fakeApp(join(root, "blender-apps"), "Blender.app", "Blender", "5.2.2", "#!/bin/sh\nexit 1\n")
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = join(root, "blender-apps")
    expect(findTool("blender")).toEqual({ path: bl, source: "found" })
    expect(await toolVersion("blender", bl)).toBe("5.2.2")
    // Homebrew's `blender` command is a shell script that execs the bundle: the sandbox only lets the real binary run
    const wrapper = join(root, "blender-wrapper")
    writeFileSync(wrapper, `#!/bin/bash\nexec "${bl}" "$@"\n`)
    chmodSync(wrapper, 0o755)
    expect(blenderExecutable(wrapper)).toBe(bl)
    expect(blenderExecutable(bl)).toBe(bl)
    expect(await toolVersion("blender", wrapper)).toBe("5.2.2")
  })

  it("reads versions: OpenSCAD from --version, OrcaSlicer from Info.plist", async () => {
    expect(appBundleOf(orca)).toBe(join(apps, "OrcaSlicer.app"))
    expect(await toolVersion("openscad", scad)).toBe("2026.10.05")
    expect(await toolVersion("orcaslicer", orca)).toBe("2.4.2")
  })
})

describe("claude auth status", () => {
  const cli = (name: string, body: string) => {
    const f = join(root, name)
    writeFileSync(f, `#!/bin/sh\n${body}\n`)
    chmodSync(f, 0o755)
    return f
  }
  it("signed in", async () => {
    const f = cli("in", `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'`)
    expect(await claudeAuthStatus(f)).toEqual({ loggedIn: true, method: "claude.ai", plan: "max" })
  })
  it("signed out: the CLI exits 1 but still prints JSON", async () => {
    const f = cli("out", `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`)
    expect((await claudeAuthStatus(f)).loggedIn).toBe(false)
  })
  it("unknown when the CLI is missing or broken", async () => {
    expect((await claudeAuthStatus(join(root, "nope"))).loggedIn).toBeNull()
    expect((await claudeAuthStatus(cli("junk", "echo hi"))).loggedIn).toBeNull()
  })
  it("tolerates a notice printed around the JSON (E2E #2 P2-f)", async () => {
    const f = cli("noisy", `echo 'A new version is available'; echo '{"loggedIn":true,"authMethod":"claude.ai"}'; echo bye`)
    expect((await claudeAuthStatus(f)).loggedIn).toBe(true)
  })
  it("the check always has USER/LOGNAME/HOME (Claude Code finds its Keychain login by user name)", async () => {
    const env = claudeCheckEnv({ PATH: "/usr/bin:/bin" })
    expect(env.USER).toBeTruthy()
    expect(env.LOGNAME).toBe(env.USER)
    expect(env.HOME).toBeTruthy()
    expect(claudeCheckEnv({ USER: "x", HOME: "/h" })).toMatchObject({ USER: "x", LOGNAME: "x", HOME: "/h" })
    // a CLI that only finds the login with USER set
    const saved = process.env.USER
    delete process.env.USER
    try {
      const f = cli("needs-user", `if [ -n "$USER" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; exit 1; fi`)
      expect((await claudeAuthStatus(f)).loggedIn).toBe(true)
    } finally {
      process.env.USER = saved
    }
  })
})

describe("finding Claude Code (public builds run the user's own)", () => {
  const userBin = join(root, "userbin")
  mkdirSync(userBin, { recursive: true })
  const userClaude = join(userBin, "claude")
  writeFileSync(userClaude, "#!/bin/sh\necho '2.1.295 (Claude Code)'\n")
  chmodSync(userClaude, 0o755)
  const saved = { nb: process.env.PRINTSTUDIO_NO_BUNDLED_CLAUDE, exe: process.env.PRINTSTUDIO_CLAUDE_EXECUTABLE }
  beforeEach(() => {
    delete process.env.PRINTSTUDIO_CLAUDE_EXECUTABLE
    process.env.PRINTSTUDIO_NO_BUNDLED_CLAUDE = "1" // as in a public build (the SDK's binary isn't shipped)
  })
  afterAll(() => {
    for (const [k, v] of [["PRINTSTUDIO_NO_BUNDLED_CLAUDE", saved.nb], ["PRINTSTUDIO_CLAUDE_EXECUTABLE", saved.exe]] as const)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  })

  it("finds the user's Claude Code in the search folders, else nothing", () => {
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = `${empty}:${userBin}`
    expect(findClaude()).toEqual({ path: userClaude, source: "found" })
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = empty
    expect(findClaude()).toBeNull()
  })

  it("the Settings path wins when it exists; a stale one is ignored", () => {
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = empty
    expect(findClaude(userClaude)).toEqual({ path: userClaude, source: "settings" })
    expect(findClaude(join(root, "gone/claude"))).toBeNull()
  })

  it("dev: the SDK's bundled binary comes before the user's install", () => {
    delete process.env.PRINTSTUDIO_NO_BUNDLED_CLAUDE
    process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS = userBin
    // The SDK's platform package is an optional dependency (installed in a normal checkout; excluded from public builds).
    const bundled = bundledClaudeExecutable()
    expect(findClaude()).toEqual(bundled ? { path: bundled, source: "bundled" } : { path: userClaude, source: "found" })
  })

  it("reads the version and compares versions numerically", async () => {
    expect(await claudeVersion(userClaude)).toBe("2.1.295")
    expect(compareVersions("2.1.9", "2.1.10")).toBeLessThan(0)
    expect(compareVersions("2.1.295", "2.1.292")).toBeGreaterThan(0)
    expect(compareVersions("2.1.292", "2.1.292")).toBe(0)
  })
})

describe("auth failure detection", () => {
  it("recognizes the CLI's login errors", () => {
    expect(isClaudeAuthFailure({ type: "assistant", error: "authentication_failed", message: { content: [] } })).toBe(true)
    expect(
      isClaudeAuthFailure({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } }),
    ).toBe(true)
    expect(isClaudeAuthFailure({ type: "result", is_error: true, result: "OAuth token has expired. Please run /login" })).toBe(true)
    expect(isClaudeAuthFailure(new Error("Invalid API key · Fix external API key"))).toBe(true)
  })
  it("ignores everything else", () => {
    expect(isClaudeAuthFailure({ type: "assistant", message: { content: [{ type: "text", text: "Please run /login" }] } })).toBe(false)
    expect(isClaudeAuthFailure({ type: "assistant", error: "rate_limit", message: { content: [] } })).toBe(false)
    expect(isClaudeAuthFailure({ type: "result", is_error: false, result: "not logged in" })).toBe(false)
    expect(isClaudeAuthFailure(new Error("sandbox unavailable"))).toBe(false)
  })
})

describe("GUI PATH merge", () => {
  it("appends without duplicates, keeping order", () => {
    expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin", "/usr/local/bin")).toBe("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin")
    expect(mergePath(undefined, null, "/a")).toBe("/a")
  })
})
