import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"
import { DESIGN_DISALLOWED_TOOLS, canonicalPath, checkBash, checkFetchUrl, checkTool, makeCanUseTool, policyHooks, protectedReason } from "./policy"
import { PROTECTED_PATHS, sandboxSettings } from "./sandbox"

let root: string
let outside: string
const PRINTER = { printerHosts: ["10.0.0.24", "sparkx.local"] }

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ps-policy-")))
  outside = realpathSync(mkdtempSync(join(tmpdir(), "ps-outside-")))
  for (const d of ["parts", "lib", "build", "renders", ".studio/sessions", ".git"]) mkdirSync(join(root, d), { recursive: true })
  writeFileSync(join(root, "build", "plate.gcode"), "; sliced\n")
  symlinkSync(join(root, "build"), join(root, "parts", "b")) // in-project symlink into a protected folder
  symlinkSync(outside, join(root, "lib", "ext")) // symlink escaping the project
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const bash = (command: string) => checkTool(root, "Bash", { command }, PRINTER)
const write = (file_path: string, tool = "Write") => checkTool(root, tool, { file_path, content: "x" }, PRINTER)

describe("Bash: protected artifacts", () => {
  it("refuses redirects into G-code and says to re-slice", () => {
    expect(bash("echo x > build/plate.gcode")).toMatch(/re-slice.*slice_plate.*parts\[\]\.overrides/)
    expect(bash("printf 'G28' >> ./build/plate.gcode")).toMatch(/slice/)
  })
  it("refuses interpreters writing G-code", () => {
    expect(bash(`python3 -c "open('build/a.gcode','w')"`)).toMatch(/slicer/)
    expect(bash(`node -e "require('fs').writeFileSync('build/a.gcode','x')"`)).toMatch(/slicer/)
  })
  it("refuses copy/move/sed -i into app-owned folders", () => {
    expect(bash("cp parts/a.scad build/")).toMatch(/build\//)
    expect(bash("sed -i '' 's/a/b/' build/plate.gcode")).toMatch(/slicer/)
    expect(bash("touch .studio/sessions/x.jsonl")).toMatch(/\.studio/)
    expect(bash("echo x > .claude/settings.json")).toMatch(/settings/)
  })
  it("refuses writes through a symlink into build/", () => {
    expect(bash("echo x > parts/b/c.gcode")).toMatch(/slicer/)
    expect(bash("echo x > parts/b/notes.txt")).toMatch(/build\//)
  })
  it("refuses writes outside the project and through escaping symlinks", () => {
    expect(bash(`echo x > ${outside}/a.txt`)).toMatch(/outside/)
    expect(bash("echo x > lib/ext/a.scad")).toMatch(/symlink/)
    expect(bash("rm -rf ../other")).toMatch(/outside/)
  })
  it("refuses git writes and points to save_checkpoint", () => {
    expect(bash("git commit -am wip")).toMatch(/save_checkpoint/)
    expect(bash("git reset --hard HEAD~1")).toMatch(/save_checkpoint/)
    expect(bash("git status && git log --oneline -5")).toBeNull()
  })
  it("refuses disabling the sandbox", () => {
    expect(checkTool(root, "Bash", { command: "ls", dangerouslyDisableSandbox: true })).toMatch(/sandbox/)
  })
})

describe("Bash: network and printers", () => {
  it.each([
    "curl http://10.0.0.24:7125/printer/print/start",
    "curl -X POST http://127.0.0.1:7125/printer/print/start",
    "wget -qO- https://example.com",
    `node -e "fetch('http://10.0.0.24:7125/printer/info')"`,
    `python3 -c "import urllib.request; urllib.request.urlopen('http://printer.invalid/printer/print/start')"`,
    `python3 -c "import socket; socket.create_connection(('10.0.0.24', 9999))"`,
    "nc 10.0.0.24 9999",
    "ls | xargs curl -s",
    "ping -c1 sparkx.local",
    "echo hi > /dev/tcp/10.0.0.24/8000",
  ])("refuses %s", (c) => {
    expect(bash(c)).toMatch(/no network access|request_print/)
  })
})

describe("Bash: normal design work still allowed", () => {
  it.each([
    "ls -la parts build renders",
    "cat build/plate.gcode | head -50",
    "grep -n 'G1 Z' build/plate.gcode | wc -l",
    `python3 -c "print(open('build/plate.gcode').read()[:100])"`,
    `python3 -c "import math; print(math.tan(math.radians(45)) * 12)"`,
    "echo 'cube(10);' > parts/box.scad",
    "mkdir -p lib/joints && cp parts/box.scad lib/joints/box.scad",
    "wc -l parts/*.scad 2>&1",
    "echo done > /dev/null",
  ])("allows %s", (c) => {
    expect(bash(c)).toBeNull()
  })
})

describe("Write/Edit/MultiEdit/NotebookEdit: protected at any depth", () => {
  it.each(["Write", "Edit", "MultiEdit"])("%s refuses G-code anywhere, with re-slice advice", (tool) => {
    expect(write("build/plate.gcode", tool)).toMatch(/slice_plate.*parts\[\]\.overrides/)
    expect(write("parts/copy.gcode", tool)).toMatch(/slicer/)
    expect(write(join(root, "build", "plate_1.3mf"), tool)).toMatch(/slicer/)
  })
  it("refuses nested .studio and .git", () => {
    expect(write(".studio/sessions/abc.jsonl")).toMatch(/\.studio/)
    expect(write("lib/vendor/.git/config")).toMatch(/save_checkpoint/)
    expect(write("lib/.studio/x.json")).toMatch(/\.studio/)
  })
  it("refuses build/, renders/, project.json, .claude and .mcp.json", () => {
    expect(write("build/box.render.json")).toMatch(/render_part/)
    expect(write("renders/front.png")).toMatch(/render_part/)
    expect(write("project.json")).toMatch(/set_parameters/)
    expect(write(".claude/settings.json")).toMatch(/managed by Crease/)
    expect(write(".mcp.json")).toMatch(/managed by Crease/)
  })
  it("keeps imported meshes and their source/licence records as imported (R23); imported .scad stays editable", () => {
    expect(write("parts/imported/benchy.stl")).toMatch(/set_orientation/)
    expect(write("parts/imported/benchy.json")).toMatch(/licence/)
    expect(write("parts/imported/clip.3mf")).toMatch(/Imported meshes/)
    expect(write("parts/imported/rounded-cube.scad")).toBeNull()
  })
  it("refuses CLAUDE.md at any depth (instructions persist across sessions; R09 import trust)", () => {
    expect(write("CLAUDE.md")).toMatch(/CLAUDE\.md/)
    expect(write("parts/CLAUDE.md")).toMatch(/CLAUDE\.md/)
    expect(write("CLAUDE.local.md")).toMatch(/CLAUDE\.md/)
    expect(checkTool(root, "Bash", { command: "echo hi > CLAUDE.md" })).toMatch(/CLAUDE\.md/)
    expect(write("parts/claude-notes.md")).toBeNull()
  })
  it("refuses NotebookEdit via notebook_path", () => {
    expect(checkTool(root, "NotebookEdit", { notebook_path: ".studio/n.ipynb" })).toMatch(/\.studio/)
  })
  it("refuses symlink escapes and paths outside", () => {
    expect(write("lib/ext/evil.scad")).toMatch(/symlink/)
    expect(write("parts/b/x.txt")).toMatch(/build\//)
    expect(write("../x.scad")).toMatch(/outside/)
    expect(write("~/x.scad")).toMatch(/outside/)
  })
  it("allows normal design files", () => {
    expect(write("parts/box.scad")).toBeNull()
    expect(write(join(root, "lib", "new", "joint.scad"))).toBeNull()
    expect(write("assembly.json")).toBeNull()
    expect(write("lib/project.json")).toBeNull()
  })
  it("canonicalises not-yet-existing paths through their existing parent", () => {
    expect(canonicalPath(root, "parts/b/new/deep.txt")).toBe(join(root, "build", "new", "deep.txt"))
    expect(protectedReason(root, "parts/new.scad")).toBeNull()
  })
})

describe("WebFetch: public web only", () => {
  it.each(["http://10.0.0.24:7125/printer/info", "http://127.0.0.1:5174/api/projects", "http://localhost:7125/", "http://sparkx.local/", "http://192.168.1.10/", "http://printer/"])(
    "refuses %s",
    (url) => expect(checkFetchUrl(url, PRINTER)).toMatch(/request_print/),
  )
  it("allows public docs", () => {
    expect(checkFetchUrl("https://github.com/BelfrySCAD/BOSL2/wiki", PRINTER)).toBeNull()
  })
  it("refuses the sandbox's network-permission prompt", () => {
    expect(checkTool(root, "SandboxNetworkAccess", { host: "10.0.0.24" })).toMatch(/no network/)
  })
})

describe("enforcement wiring", () => {
  const hook = (root_: string) => (policyHooks(root_, PRINTER).PreToolUse![0].hooks[0] as HookCallback)
  const input = (tool_name: string, tool_input: Record<string, unknown>) =>
    ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: root }) as PreToolUseHookInput

  it("the PreToolUse hook denies regardless of permission rules (it has no matcher: every tool)", async () => {
    // Hooks run before allow rules are consulted, so an inherited `allow: ["Bash", "Write"]` can't skip this.
    // tools/sandbox-check.ts runs it end to end with such allow rules set.
    const m = policyHooks(root).PreToolUse![0]
    expect(m.matcher).toBeUndefined()
    const out = await hook(root)(input("Bash", { command: "echo x > build/plate.gcode" }), "t1", { signal: new AbortController().signal })
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } })
    const w = await hook(root)(input("Write", { file_path: ".studio/sessions/x.json", content: "{}" }), "t1", { signal: new AbortController().signal })
    expect(w).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    const ok = await hook(root)(input("Write", { file_path: "parts/a.scad", content: "" }), "t1", { signal: new AbortController().signal })
    expect(ok).toEqual({})
  })

  it("canUseTool applies the same policy", async () => {
    const can = makeCanUseTool(root, {}, PRINTER)
    const o = { signal: new AbortController().signal, toolUseID: "t" } as Parameters<typeof can>[2]
    expect(await can("Bash", { command: "curl http://10.0.0.24:7125/printer/print/start" }, o)).toMatchObject({ behavior: "deny" })
    expect(await can("Edit", { file_path: "build/plate.gcode", old_string: "a", new_string: "b" }, o)).toMatchObject({ behavior: "deny" })
    expect(await can("Write", { file_path: "parts/a.scad", content: "" }, o)).toMatchObject({ behavior: "allow" })
  })

  it("the sandbox fails closed, has no escape hatch, no network and read-only app paths", () => {
    const s = sandboxSettings(root, { printerHosts: ["10.0.0.24"] })
    expect(s).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false })
    expect(s.network).toMatchObject({ allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false })
    expect(s.network!.deniedDomains).toContain("10.0.0.24")
    for (const p of ["build", ".studio", ".git", ".claude", "project.json"]) expect(s.filesystem!.denyWrite).toContain(join(root, p))
    expect(PROTECTED_PATHS.every((p) => protectedReason(root, p) !== null)).toBe(true)
  })

  it("the session loads only project settings and wires the hook + sandbox", () => {
    const src = readFileSync(fileURLToPath(new URL("./runtime/claude/adapter.ts", import.meta.url)), "utf8")
    expect(src).toMatch(/settingSources: \["project"\]/)
    expect(src).toMatch(/hooks: policyHooks\(dir/)
    expect(src).toMatch(/sandbox: sandboxSettings\(dir/)
    expect(src).toMatch(/permissionMode: "default"/)
  })
})

// Real OS sandbox, real Claude Code session (haiku, a few cents): opt in with PRINTSTUDIO_SANDBOX_E2E=1.
// Runs boundary-crossing commands against a fake printer on 127.0.0.1:<free port>; never the real printer.
describe.skipIf(!process.env.PRINTSTUDIO_SANDBOX_E2E)("OS sandbox end to end", () => {
  const script = fileURLToPath(new URL("../../tools/sandbox-check.ts", import.meta.url))
  it.each([["--raw"], []])("blocks writes to protected files and all network (%s)", (...args) => {
    const r = spawnSync("npx", ["tsx", script, ...args], { encoding: "utf8", timeout: 400_000 })
    expect(r.stdout).toMatch(/fake printer requests: none/)
    expect(r.stdout).toMatch(/protected files written: none/)
    expect(r.status).toBe(0)
  }, 420_000)
})

it("checkBash keeps working standalone", () => {
  expect(checkBash(root, "sudo rm -rf /")).toMatch(/sudo/)
})

it("Blender runs only through the app (render_part), never from the designer's shell", () => {
  for (const cmd of ["blender -b -P parts/king.blend.py", "/Applications/Blender.app/Contents/MacOS/Blender -b --python x.py", "cd parts && Blender --background", "/opt/homebrew/bin/blender"])
    expect(checkBash(root, cmd)).toMatch(/Blender runs only through Crease/)
  for (const cmd of ["cat parts/king.blend.py", "cat .claude/skills/blender-sculpting/SKILL.md", "python3 -c 'print(1)'", "grep -n blender_x parts/a.scad"])
    expect(checkBash(root, cmd)).toBeNull()
})

describe("Read/Grep/Glob: the app's key store", () => {
  const home = mkdtempSync(join(tmpdir(), "ps-home-"))
  const proj = join(home, "projects", "p")
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(home, "secrets.json"), "{}")
  const opts = { denyRead: [join(home, "settings.json"), join(home, "secrets.json")] }
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it("refuses reading the store or searching a folder that holds it", () => {
    expect(checkTool(proj, "Read", { file_path: join(home, "secrets.json") }, opts)).toMatch(/private settings/)
    expect(checkTool(proj, "Read", { file_path: "../../settings.json" }, opts)).toMatch(/private settings/)
    expect(checkTool(proj, "Grep", { pattern: "sk-", path: home }, opts)).toMatch(/private settings/)
  })
  it("still allows project files", () => {
    expect(checkTool(proj, "Read", { file_path: "parts/a.scad" }, opts)).toBeNull()
    expect(checkTool(proj, "Grep", { pattern: "x" }, opts)).toBeNull()
  })
})

describe("tools a design session never uses", () => {
  it("are denied (scheduling, remote triggers, worktrees, workflows, notifications, messaging)", () => {
    for (const t of ["CronCreate", "RemoteTrigger", "EnterWorktree", "Workflow", "PushNotification", "SendMessage", "ScheduleWakeup"]) {
      expect(DESIGN_DISALLOWED_TOOLS).toContain(t)
      expect(checkTool(root, t, {})).toMatch(/isn't available in a design session/)
    }
  })
  it("keep the tools the design agent works with", () => {
    for (const t of ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "Agent", "TodoWrite", "TaskCreate", "WebSearch", "WebFetch", "Skill", "AskUserQuestion", "ToolSearch", "Monitor"])
      expect(DESIGN_DISALLOWED_TOOLS as readonly string[]).not.toContain(t)
  })
})
