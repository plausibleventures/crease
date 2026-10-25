// The tool registry: one place that validates input, builds the caller's identity, runs gates, calls the handler and
// shapes the result, whatever runtime asked. Adapters get BoundTools (list + call) and never pick the context.
import { z } from "zod"
import { deps } from "../deps"
import { designRevision } from "../revision"
import { STUDIO_TOOLS } from "./studio"
import type { BoundTools, ToolCaller, ToolContext, ToolDef, ToolResult } from "./types"

export * from "./types"
export { STUDIO_TOOLS, applyParameters } from "./studio"

const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true })

/**
 * Tool outputs the agent (and, through the timeline, the user) sees use project-relative paths: no username or
 * scratch dirs, and shorter. Rewrites the text blocks of a result.
 */
export function relativizeResult(root: string, r: ToolResult): ToolResult {
  const base = root.replace(/\/+$/, "")
  const rel = (t: string) => t.split(base + "/").join("").split(base).join(".")
  return { ...r, content: r.content.map((c) => (c.type === "text" ? { ...c, text: rel(c.text) } : c)) }
}

/** JSON Schema of a tool definition's input object. */
export function inputJsonSchema(t: ToolDef): Record<string, unknown> {
  return z.toJSONSchema(z.object(t.input), { io: "input", unrepresentable: "any" }) as Record<string, unknown>
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDef>()

  constructor(readonly tools: readonly ToolDef[]) {
    for (const t of tools) {
      if (this.byName.has(t.name)) throw new Error(`duplicate tool ${t.name}`)
      this.byName.set(t.name, t)
    }
  }

  list(): readonly ToolDef[] {
    return this.tools
  }

  get(name: string): ToolDef | undefined {
    return this.byName.get(name)
  }

  names(): string[] {
    return this.tools.map((t) => t.name)
  }

  /** JSON Schema of a tool's input (for runtimes that take tool definitions as JSON: MCP, native tool calls). */
  jsonSchema(name: string): Record<string, unknown> {
    const t = this.byName.get(name)
    if (!t) throw new Error(`unknown tool ${name}`)
    return inputJsonSchema(t)
  }

  /**
   * Run one call. Never throws: unknown tools, invalid input, gate refusals and handler errors come back as tool
   * errors the model can read. Text is made project-relative.
   */
  async call(caller: Omit<ToolContext, "revision">, name: string, input: unknown): Promise<ToolResult> {
    const t = this.byName.get(name)
    if (!t) return fail(`Unknown tool ${name}.`)
    const parsed = z.object(t.input).safeParse(input ?? {})
    if (!parsed.success) return fail(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`)
    // Identity comes from the app (the coordinator's binding), never from the input.
    const ctx: ToolContext = Object.freeze({ ...caller, revision: designRevision(caller.projectId) })
    let root: string
    try {
      root = deps.projectDir(ctx.projectId)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    let result: ToolResult
    try {
      let refusal: string | null = null
      for (const gate of t.gates ?? []) if ((refusal = await gate(ctx))) break
      result = refusal ? fail(refusal) : await t.handler(ctx, parsed.data)
    } catch (e) {
      result = fail(e instanceof Error ? e.message : String(e))
    }
    result = relativizeResult(root, result)
    if (!result.isError && t.after) {
      try {
        t.after(ctx, parsed.data, result)
      } catch (e) {
        console.error(`[tools] ${name} bookkeeping failed`, e)
      }
    }
    return result
  }

  /** Bind to a caller: the adapter-facing view. `caller` is read at each call (the run changes per turn). */
  bind(caller: ToolCaller): BoundTools {
    return {
      list: () => this.tools,
      call: (name, input) => this.call(caller(), name, input),
    }
  }
}

/** Crease's tools. */
export const studioTools = new ToolRegistry(STUDIO_TOOLS)
