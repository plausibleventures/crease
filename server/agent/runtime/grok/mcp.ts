// The app's tools for a Grok session (R11e): a tiny MCP server (streamable HTTP, JSON responses) on 127.0.0.1, one per
// session, handed to Grok in session/new `mcpServers` with a per-session bearer token. Identity is the coordinator's
// binding (BoundTools) by construction: the token selects the session's bound tools and the model only sends tool
// names and arguments. Grok exposes them through its meta-tools (search_tool / use_tool as `studio__<name>`).
//
// Images in results go to the model as images (Grok attaches MCP image content after the tool result). Because the
// app performs every file read (ACP fs capability), Grok's read_file is text-only, so the bridge adds `view_image`
// (project images, e.g. a photo the user attached, which the adapter saves under .studio/agent-images/).
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { extname, join } from "node:path"
import { canonicalPath, isInside, realRoot } from "../../../projects/paths"
import { inputJsonSchema, type BoundTools, type ToolResult } from "../../registry"

export const MCP_SERVER_NAME = "studio"
const MAX_BODY = 8 * 1024 * 1024
const PROTOCOL = "2025-06-18"
export const AGENT_IMAGES_DIR = join(".studio", "agent-images")

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Save an image for the agent to look at (view_image); returns the project-relative path. */
export function saveAgentImage(root: string, data: string, mimeType: string): string {
  const ext = /png/.test(mimeType) ? "png" : /jpe?g/.test(mimeType) ? "jpg" : /webp/.test(mimeType) ? "webp" : /gif/.test(mimeType) ? "gif" : "img"
  const buf = Buffer.from(data, "base64")
  const rel = join(AGENT_IMAGES_DIR, `${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`)
  mkdirSync(join(root, AGENT_IMAGES_DIR), { recursive: true })
  writeFileSync(join(root, rel), buf)
  return rel
}

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }

/** A registry result as MCP content (text and images as they are). */
export function toMcpResult(r: ToolResult): { content: McpContent[]; isError: boolean } {
  const content: McpContent[] = r.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", data: c.data, mimeType: c.mimeType }))
  return { content: content.length ? content : [{ type: "text", text: "(no output)" }], isError: !!r.isError }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }
export const VIEW_IMAGE_TOOL = "view_image"
const VIEW_IMAGE = {
  name: VIEW_IMAGE_TOOL,
  description: "Look at an image file in the project (PNG/JPEG/WebP/GIF), e.g. a photo the user attached or a render. read_file can't show images; use this.",
  inputSchema: { type: "object", properties: { path: { type: "string", description: "Project-relative path of the image." } }, required: ["path"] },
}

/** view_image: an image inside the project (symlinks resolved), at most 8 MB. */
export function viewImage(root: string, path: unknown): { content: McpContent[]; isError: boolean } {
  const p = String(path ?? "")
  const abs = canonicalPath(root, p)
  const type = IMAGE_TYPES[extname(abs).toLowerCase()]
  const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true })
  if (!isInside(realRoot(root), abs)) return fail(`Only images inside the project can be viewed; ${p} is outside it.`)
  if (!type) return fail(`${p} isn't a PNG, JPEG, WebP or GIF image.`)
  try {
    const buf = readFileSync(abs)
    if (buf.length > 8 * 1024 * 1024) return fail(`${p} is too large to view (over 8 MB).`)
    return { content: [{ type: "text", text: p }, { type: "image", data: buf.toString("base64"), mimeType: type }], isError: false }
  } catch {
    return fail(`Couldn't read ${p}.`)
  }
}

function clean(schema: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, ...rest } = schema
  return rest
}

export interface McpBridge {
  /** For session/new `mcpServers`. */
  server: { type: "http"; name: string; url: string; headers: { name: string; value: string }[] }
  close(): void
}

/** Start the bridge for one session. */
export async function startMcpBridge(o: { root: string; tools: BoundTools; onCall?: (name: string) => void }): Promise<McpBridge> {
  const token = randomBytes(24).toString("hex")
  const handle = async (m: any): Promise<unknown> => {
    switch (m.method) {
      case "initialize":
        return { protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER_NAME, title: "Crease", version: "0.1.0" } }
      case "ping":
        return {}
      case "tools/list":
        return { tools: [...o.tools.list().map((t) => ({ name: t.name, description: t.description, inputSchema: clean(inputJsonSchema(t)) })), VIEW_IMAGE] }
      case "tools/call": {
        const name = String(m.params?.name ?? "")
        o.onCall?.(name)
        if (name === VIEW_IMAGE_TOOL) return viewImage(o.root, m.params?.arguments?.path)
        return toMcpResult(await o.tools.call(name, m.params?.arguments ?? {}))
      }
      default:
        throw Object.assign(new Error(`Method not found: ${m.method}`), { code: -32601 })
    }
  }
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      req.resume()
      return
    }
    if (req.method === "DELETE") return void res.writeHead(200).end()
    if (req.method !== "POST") return void res.writeHead(405, { allow: "POST" }).end()
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (d: Buffer) => {
      size += d.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(d)
    })
    req.on("end", async () => {
      let m: any
      try {
        m = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return void res.writeHead(400).end()
      }
      if (Array.isArray(m) || m?.id === undefined || m?.id === null) return void res.writeHead(202).end() // notifications
      let body: unknown
      try {
        body = { jsonrpc: "2.0", id: m.id, result: await handle(m) }
      } catch (e: any) {
        body = { jsonrpc: "2.0", id: m.id, error: { code: typeof e?.code === "number" ? e.code : -32000, message: e?.message ?? String(e) } }
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
    })
  })
  await new Promise<void>((r, j) => {
    server.once("error", j)
    server.listen(0, "127.0.0.1", () => r())
  })
  const port = (server.address() as { port: number }).port
  return {
    server: { type: "http", name: MCP_SERVER_NAME, url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "Authorization", value: `Bearer ${token}` }] },
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}
