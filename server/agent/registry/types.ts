// Runtime-neutral tool contract (R11a). Every app tool is defined once (name, description, zod input shape,
// handler) and any agent runtime exposes it: the Claude adapter through an in-process SDK MCP server, later runtimes
// through standard MCP or native tool calls. The runtime only supplies the tool name and its input; the identity a
// handler acts for (project, session, run, design revision) comes from the app in ToolContext and can't be spoofed
// by the model or the runtime.
import type { z } from "zod"

/** One block of a tool result: text (JSON results are text) or an image. Same shape as MCP CallToolResult content. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

// A type alias (not an interface) so it fits MCP's CallToolResult, which has an index signature.
export type ToolResult = {
  content: ToolContent[]
  isError?: boolean
}

/**
 * App-generated identity for one tool call. Built by the registry from the coordinator's binding, frozen, never
 * read from tool input.
 */
export interface ToolContext {
  readonly projectId: string
  /** App session id (for Claude: the Claude Code session id, which the app pins). */
  readonly sessionId: string
  /** The app run (one user turn) this call belongs to; null outside a run (tests, scripts). */
  readonly runId: string | null
  /** Design revision when the call started (server/projects/revision.ts); null if the project can't be read. */
  readonly revision: string | null
  /** Which runtime made the call ("claude", "fake", …): for logs and diagnostics only. */
  readonly runtime: string
}

/** The coordinator's side of the binding: who is calling right now. The registry adds the revision. */
export type ToolCaller = () => Omit<ToolContext, "revision">

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ZodShape = Record<string, z.ZodType<any>>
export type ShapeInput<S extends ZodShape> = z.infer<z.ZodObject<S>>

/** A hard precondition checked by the registry before the handler runs: a refusal message for the agent, or null. */
export type ToolGate = (ctx: ToolContext) => Promise<string | null> | string | null

export interface ToolDef<S extends ZodShape = ZodShape> {
  name: string
  description: string
  /** Zod raw shape of the input object (MCP-style). JSON Schema for other transports: registry.jsonSchema(). */
  input: S
  /** Gates run in order before the handler; the first refusal is returned as a tool error. */
  gates?: ToolGate[]
  // Method syntax (bivariant) so a ToolDef<SpecificShape> fits a ToolDef[] list.
  handler(ctx: ToolContext, input: ShapeInput<S>): Promise<ToolResult>
  /**
   * Bookkeeping after a successful call, on the result exactly as the agent sees it (paths project-relative).
   * Never changes the result.
   */
  after?(ctx: ToolContext, input: ShapeInput<S>, result: ToolResult): void
}

/** Identity helper that keeps the handler's input type tied to its shape. */
export function defineTool<S extends ZodShape>(def: ToolDef<S>): ToolDef<S> {
  return def
}

/** Tools bound to one caller: what an adapter gets. It can list and call, never choose the context. */
export interface BoundTools {
  list(): readonly ToolDef[]
  call(name: string, input: unknown): Promise<ToolResult>
}
