// Claude transport for the app's tools: the registry (registry/) exposed as an in-process SDK MCP server. Nothing
// here decides anything; validation, identity, gates and bookkeeping are the registry's.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { studioTools, type BoundTools } from "../../registry"

export { applyParameters } from "../../registry"

export const MCP_SERVER_NAME = "studio"
export const STUDIO_TOOL_NAMES = studioTools.names()
export const STUDIO_MCP_TOOLS = STUDIO_TOOL_NAMES.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`)

/** `mcp__studio__slice_part` -> `slice_part` (other names unchanged). */
export const studioToolName = (name: string) => name.replace(/^mcp__studio__/, "")

export function createStudioMcpServer(bound: BoundTools) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "0.1.0",
    alwaysLoad: true,
    tools: bound.list().map((t) => tool(t.name, t.description, t.input, (args) => bound.call(t.name, args))),
  })
}
