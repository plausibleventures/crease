import { describe, expect, it } from "vitest"
import { describeAgentConfigItem as d } from "./agent-config"

describe("describeAgentConfigItem", () => {
  it("names each kind of project assistant setting in plain words and flags what can run commands", () => {
    expect(d(".claude/settings.json")).toMatchObject({ runsCommands: true, what: expect.stringMatching(/run commands/) })
    expect(d(".mcp.json")).toMatchObject({ runsCommands: true })
    expect(d("CLAUDE.md")).toMatchObject({ runsCommands: false, what: "Written instructions for Claude" })
    expect(d("parts/sub/CLAUDE.local.md").what).toBe("Written instructions for Claude")
    expect(d("AGENTS.md").what).toBe("Written instructions for Codex")
    expect(d("parts/AGENTS.override.md").what).toBe("Written instructions for Codex")
    expect(d(".claude/skills/their-skill").what).toMatch(/skills/)
    expect(d(".agents").what).toMatch(/skills/)
    expect(d(".codex").what).toMatch(/Codex settings/)
    expect(d("parts/lib/.codex").what).toMatch(/Codex settings/)
    expect(d(".claude/commands").runsCommands).toBe(false)
    expect(d(".claude").what).toBe("Claude settings folder")
  })
})
