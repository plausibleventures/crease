// R09: plain words for the assistant settings a project brought with it (shown before the user turns them on).

export interface AgentConfigItem {
  path: string
  /** what it is, in plain words */
  what: string
  /** it can run programs on this computer (hooks, tool servers, scripts) */
  runsCommands: boolean
}

const base = (p: string) => p.split("/").pop() ?? p

export function describeAgentConfigItem(path: string): AgentConfigItem {
  const p = path.replace(/\\/g, "/")
  const name = base(p)
  if (/(^|\/)\.mcp\.json$/i.test(p)) return { path, what: "Extra tools: programs the assistant would start", runsCommands: true }
  if (/^CLAUDE(\.local)?\.md$/i.test(name)) return { path, what: "Written instructions for Claude", runsCommands: false }
  if (/^AGENTS(\.override)?\.md$/i.test(name)) return { path, what: "Written instructions for Codex", runsCommands: false }
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/i.test(p))
    return { path, what: "Claude settings: can run commands on your computer and change what it's allowed to do", runsCommands: true }
  if (/(^|\/)\.claude\/skills\//i.test(p) || /(^|\/)\.agents(\/|$)/i.test(p)) return { path, what: "Extra skills: instructions, sometimes with scripts", runsCommands: true }
  if (/(^|\/)\.claude\/(agents|commands|rules|output-styles)(\/|$)/i.test(p)) return { path, what: "Extra helpers and commands for Claude", runsCommands: false }
  if (/(^|\/)\.codex(\/|$)/i.test(p)) return { path, what: "Codex settings (Crease's Codex designer ignores these)", runsCommands: true }
  if (/(^|\/)\.claude(\/|$)/i.test(p)) return { path, what: "Claude settings folder", runsCommands: true }
  return { path, what: "Assistant settings", runsCommands: true }
}
