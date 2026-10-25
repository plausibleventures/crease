// The app's tools as Codex dynamic tools (thread/start `dynamicTools`, called back with `item/tool/call`).
//
// Why dynamic tools rather than an MCP server: the call arrives on the same JSON-RPC connection the app owns, so no
// port, token or extra process, and identity is the coordinator's binding (BoundTools) by construction: Codex sends
// only the tool name and arguments. Codex stores the tool list with the thread and restores it on resume. The API is
// marked experimental (initialize capabilities.experimentalApi); the registry can be served over MCP instead if it
// changes (registry.jsonSchema is transport-neutral).
//
// AskUserQuestion is one of them: the same question shape as Claude's tool, answered through the app's question
// broker (host.askUser), so the brief and the question cards work unchanged.
import type { QuestionOutcome } from "../types"
import { answeredText } from "../../questions"
import { inputJsonSchema, type BoundTools, type ToolResult } from "../../registry"

export const ASK_TOOL = "AskUserQuestion"
/** Timeline name of an app tool (same convention as Claude's in-process MCP server: renders identically). */
export const timelineToolName = (name: string) => (name === ASK_TOOL ? name : `mcp__studio__${name}`)

export interface DynamicToolSpec {
  type: "function"
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const ASK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The full question, ending with a question mark." },
          header: { type: "string", description: "A very short label (max 12 characters), e.g. \"Size\"." },
          multiSelect: { type: "boolean", description: "true if several options can be picked." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "1-5 words. The recommended option comes first and ends with \"(Recommended)\"." },
                description: { type: "string", description: "What this choice means, in plain words." },
                preview: { type: "string", description: "Optional self-contained HTML/SVG picture of this option (no scripts)." },
              },
              required: ["label", "description"],
            },
          },
        },
        required: ["question", "header", "options", "multiSelect"],
      },
    },
  },
  required: ["questions"],
}

export const ASK_DESCRIPTION =
  "Ask the user 1-4 multiple-choice questions and wait for the answers. The app shows them as big buttons; the user can " +
  "also type their own answer. Use this for every question to the user (never ask in chat text), including \"How does " +
  "this look?\". Put the recommended option first, its label ending \"(Recommended)\"."

/** JSON Schema without the draft marker (function-calling schemas don't take $schema). */
function clean(schema: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...rest } = schema
  return rest
}

export function dynamicToolSpecs(tools: BoundTools): DynamicToolSpec[] {
  return [
    ...tools.list().map((t) => ({ type: "function" as const, name: t.name, description: t.description, inputSchema: clean(inputJsonSchema(t)) })),
    { type: "function", name: ASK_TOOL, description: ASK_DESCRIPTION, inputSchema: ASK_SCHEMA },
  ]
}

export type DynamicToolOutputItem = { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }

export interface DynamicToolResponse {
  contentItems: DynamicToolOutputItem[]
  success: boolean
}

export function toDynamicResponse(r: ToolResult): DynamicToolResponse {
  const contentItems = r.content.map((c): DynamicToolOutputItem =>
    c.type === "text" ? { type: "inputText", text: c.text } : { type: "inputImage", imageUrl: `data:${c.mimeType};base64,${c.data}` }
  )
  return { contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "(no output)" }], success: !r.isError }
}

/** The answer text the model reads (Claude's AskUserQuestion wording, so the timeline's "You answered" row parses it). */
export function askResultText(o: QuestionOutcome): DynamicToolResponse {
  if (!o.answered) return { contentItems: [{ type: "inputText", text: o.message }], success: false }
  return { contentItems: [{ type: "inputText", text: answeredText(o) }], success: true }
}
