// The agent's read boundary (project + app skills/libraries + its session folders) and WebFetch's DNS check.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { checkFetchUrlResolved, checkTool, isPrivateAddress, makeCanUseTool, policyHooks } from "./policy"
import { claudeProjectDataDir, readRoots, shellToolchainDirs } from "./readscope"
import { sandboxSettings } from "./sandbox"
import { shellProfile } from "./runtime/grok/shell"
import { permissionProfile } from "./runtime/codex/config"
import { BUNDLED_LIBRARIES_DIR, LIBRARIES_DIR } from "../cad/libraries"

let root: string
let lib: string
let outside: string
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ps-read-")))
  lib = realpathSync(mkdtempSync(join(tmpdir(), "ps-lib-")))
  outside = realpathSync(mkdtempSync(join(tmpdir(), "ps-outside-")))
  mkdirSync(join(root, "parts"), { recursive: true })
  mkdirSync(join(root, "lib"), { recursive: true })
  writeFileSync(join(lib, "std.scad"), "// lib\n")
  symlinkSync(outside, join(root, "lib", "ext"))
})
afterAll(() => {
  for (const d of [root, lib, outside]) rmSync(d, { recursive: true, force: true })
})

describe("Read/Grep/Glob: only the project, the app's skills/libraries and the session's own folders", () => {
  const read = (tool: string, input: Record<string, unknown>) => checkTool(root, tool, input, { readRoots: [lib] })

  it("refuses files elsewhere on disk, with a helpful message", () => {
    expect(read("Read", { file_path: join(homedir(), ".ssh", "id_ed25519") })).toMatch(/can read only this project's files.*add it to the project/)
    expect(read("Read", { file_path: "~/Documents/taxes.pdf" })).toMatch(/is outside/)
    expect(read("Read", { file_path: "../other-project/parts/a.scad" })).toMatch(/is outside/)
    expect(read("Read", { file_path: "lib/ext/x.txt" })).toMatch(/is outside/) // symlink escaping the project
    expect(read("Grep", { pattern: "password", path: "/etc" })).toMatch(/is outside/)
    expect(read("Glob", { pattern: "/Users/*/Desktop/**" })).toMatch(/is outside/)
    expect(read("Glob", { pattern: "**/*.scad", path: homedir() })).toMatch(/is outside/)
    expect(read("NotebookRead", { notebook_path: "/tmp/x.ipynb" })).toMatch(/is outside/)
  })
  it("allows the project and the read roots", () => {
    expect(read("Read", { file_path: "parts/a.scad" })).toBeNull()
    expect(read("Read", { file_path: join(root, ".claude/skills/printable-openscad/SKILL.md") })).toBeNull()
    expect(read("Glob", { pattern: "**/*.scad" })).toBeNull()
    expect(read("Grep", { pattern: "x" })).toBeNull()
    expect(read("Read", { file_path: join(lib, "std.scad") })).toBeNull()
    expect(read("Glob", { pattern: `${lib}/**/*.scad` })).toBeNull()
  })
  it("the session's read roots: skills, bundled libraries, Claude Code's session folders", () => {
    const roots = readRoots(root)
    expect(roots).toContain(BUNDLED_LIBRARIES_DIR)
    expect(roots).toContain(LIBRARIES_DIR)
    expect(roots.some((r) => r.endsWith("/server/agent/skills"))).toBe(true)
    expect(roots).toContain(claudeProjectDataDir(root))
    expect(claudeProjectDataDir("/Users/a b/p.x", "/cfg")).toBe("/cfg/projects/-Users-a-b-p-x")
    const src = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8")
    expect(src).toMatch(/readRoots: readRoots\(dir\)/)
  })
})

describe("shell sandboxes: the home folder is unreadable except the project, read roots and toolchains", () => {
  it("toolchain dirs from PATH", () => {
    const dirs = shellToolchainDirs({ PATH: "/usr/bin:/h/.nvm/versions/node/v24/bin:/h/bin:/h/proj/node_modules/.bin:/h/.grok/bin" }, "/h")
    expect(dirs).toEqual(expect.arrayContaining(["/h/.nvm/versions/node/v24/bin", "/h/.nvm/versions/node/v24/lib", "/h/bin", "/h/.grok/bin"]))
    expect(dirs).not.toContain("/h/.grok") // its sign-in stays unreadable
    expect(dirs.some((d) => d.includes("node_modules"))).toBe(false)
    expect(dirs).toContain("/h/.claude/shell-snapshots")
  })
  it("Claude Bash", () => {
    const s = sandboxSettings(root, { readRoots: [lib], denyRead: ["/x/secrets.json"] })
    expect(s.filesystem!.denyRead).toEqual(["/x/secrets.json", homedir()])
    expect(s.filesystem!.allowRead).toEqual(expect.arrayContaining([root, lib]))
    expect(sandboxSettings(root, {}).filesystem!.allowRead).toBeUndefined()
    const src = readFileSync(fileURLToPath(new URL("./runtime/claude/adapter.ts", import.meta.url)), "utf8")
    expect(src).toMatch(/readRoots: ctx\.policy\.readRoots/)
  })
  it("Codex permission profile", () => {
    const p = permissionProfile({ codexHome: "/c", readRoots: [lib] })
    expect(p).toContain(`${JSON.stringify(homedir())}="deny"`)
    expect(p).toContain(`${JSON.stringify(lib)}="read"`)
    expect(p).toContain(`"/c/auth.json"="deny"`)
    expect(permissionProfile({ codexHome: "/c" })).not.toContain(`${JSON.stringify(homedir())}=`)
  })
  it("Grok terminals", () => {
    const p = shellProfile({ root, readRoots: [lib], home: "/h" })
    expect(p).toMatch(/\(deny file-read-data \(subpath "\/h"\)/)
    const allow = p.split("\n").find((l) => l.startsWith("(allow file-read-data"))!
    expect(allow).toContain(`(subpath ${JSON.stringify(root)})`)
    expect(allow).toContain(`(subpath ${JSON.stringify(lib)})`)
    expect(shellProfile({ root })).not.toMatch(/file-read-data/)
  })
})

describe("WebFetch: DNS", () => {
  const dns = (map: Record<string, string[]>) => async (h: string) => {
    if (!map[h]) throw new Error("ENOTFOUND")
    return map[h]
  }
  const opts = {
    printerHosts: ["10.0.0.24", "my-printer.example.net"],
    resolveHost: dns({
      "docs.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
      "evil.example.com": ["10.0.0.24"],
      "loop.example.com": ["127.0.0.1"],
      "meta.example.com": ["169.254.169.254"],
      "v6.example.com": ["::1"],
      "ula.example.com": ["fd12:3456::1"],
      "mapped.example.com": ["::ffff:192.168.1.5"],
      "cgnat.example.com": ["100.100.1.1"],
      "mixed.example.com": ["93.184.215.14", "192.168.0.2"],
      "printer-alias.example.com": ["203.0.113.9"],
      "my-printer.example.net": ["203.0.113.9"],
    }),
  }
  it.each(["evil", "loop", "meta", "v6", "ula", "mapped", "cgnat", "mixed", "printer-alias"])(
    "refuses a public name resolving to a private or printer address (%s)",
    async (n) => {
      expect(await checkFetchUrlResolved(`https://${n}.example.com/x`, opts)).toMatch(/never contact a printer directly/)
    },
  )
  it("refuses names that don't resolve, allows public ones", async () => {
    expect(await checkFetchUrlResolved("https://nowhere.example.com/", opts)).toMatch(/couldn't look up/)
    expect(await checkFetchUrlResolved("https://docs.example.com/bosl2", opts)).toBeNull()
    expect(await checkFetchUrlResolved("http://[::ffff:7f00:1]/", opts)).toMatch(/printer/)
  })
  it("classifies addresses", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "224.0.0.1", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "64:ff9b::10.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false)
  })
  it("the hook and canUseTool run the DNS check", async () => {
    const can = makeCanUseTool(root, {}, opts)
    const o = { signal: new AbortController().signal, toolUseID: "t" } as Parameters<typeof can>[2]
    expect(await can("WebFetch", { url: "https://evil.example.com/", prompt: "x" }, o)).toMatchObject({ behavior: "deny" })
    expect(await can("WebFetch", { url: "https://docs.example.com/", prompt: "x" }, o)).toMatchObject({ behavior: "allow" })
    const hook = policyHooks(root, opts).PreToolUse![0].hooks[0] as HookCallback
    const input = { hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url: "https://loop.example.com/" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: root }
    const out = await hook(input as PreToolUseHookInput, "t", { signal: new AbortController().signal })
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  })
})
