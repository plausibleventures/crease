// Manual check of a design session's tool list (costs a fraction of a cent: haiku, one short turn).
//   npx tsx tools/tools-check.ts
//
// Starts a throwaway project with the app's skills installed, opens a Claude Code session with the app's tool
// options (claude_code preset, DESIGN_DISALLOWED_TOOLS, project settings only) and reads the init message.
// Pass = none of the disallowed tools is offered, the tools the design agent needs are, and the app skills load.
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { DESIGN_DISALLOWED_TOOLS, makeCanUseTool, policyHooks } from "../server/agent/policy"
import { installProjectSkills } from "../server/agent/prompt"
import { readRoots } from "../server/agent/readscope"
import { sandboxSettings } from "../server/agent/sandbox"

const root = realpathSync(mkdtempSync(join(tmpdir(), "ps-tools-")))
installProjectSkills(root)
// The app's read boundary (readscope.ts): skills must still load with it.
const policy = { readRoots: readRoots(root) }
const NEEDED = ["Bash", "Read", "Write", "Edit", "Task", "Skill", "WebSearch", "WebFetch"]
const APP_SKILLS = ["printable-openscad", "assembly-guide", "beginner-intake", "print-finish"]

let tools: string[] = []
let skills: string[] = []
const q = query({
  prompt: "Reply OK.",
  options: {
    cwd: root,
    model: "haiku",
    maxTurns: 1,
    tools: { type: "preset", preset: "claude_code" },
    disallowedTools: [...DESIGN_DISALLOWED_TOOLS],
    permissionMode: "default",
    settingSources: ["project"],
    canUseTool: makeCanUseTool(root, {}, policy),
    hooks: policyHooks(root, policy),
    sandbox: sandboxSettings(root, policy),
    settings: { disableClaudeAiConnectors: true },
    stderr: (d) => process.env.DEBUG && process.stderr.write(d),
  },
})
try {
  for await (const m of q as AsyncIterable<SDKMessage>) {
    if (m.type === "system" && m.subtype === "init") {
      tools = m.tools
      skills = m.skills ?? []
    }
    if (m.type === "result") break
  }
} catch (e) {
  if (!tools.length) throw e
}

const offered = DESIGN_DISALLOWED_TOOLS.filter((t) => tools.includes(t))
const missing = NEEDED.filter((t) => !tools.includes(t))
const noSkills = APP_SKILLS.filter((s) => !skills.includes(s))
console.log(`tools (${tools.length}): ${tools.join(", ")}`)
console.log(`skills (${skills.length}): ${skills.join(", ")}`)
console.log(`disallowed but offered: ${offered.join(", ") || "none"}`)
console.log(`needed but missing: ${missing.join(", ") || "none"}`)
console.log(`app skills not loaded: ${noSkills.join(", ") || "none"}`)
const pass = tools.length > 0 && !offered.length && !missing.length && !noSkills.length
console.log(pass ? "PASS" : "FAIL")
rmSync(root, { recursive: true, force: true })
process.exit(pass ? 0 : 1)
