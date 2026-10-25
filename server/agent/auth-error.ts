// Turning "Not logged in · Please run /login" (and expired/revoked logins) into a plain sign-in fix.
// The CLI reports these as an assistant message with error "authentication_failed", an error result, or a thrown
// error; the timeline shows CLAUDE_AUTH_MESSAGE with a button to the Agents screen (app_error code "claude_auth").

export const CLAUDE_AUTH_CODE = "claude_auth"

export const CLAUDE_AUTH_MESSAGE =
  "The designer can’t reach Claude: the API key was refused, or your Claude Code isn’t signed in (or its sign-in expired). Add or replace your Anthropic API key in Designers, or sign in to your own Claude Code (open Terminal, type “claude”), then send your message again."

const AUTH_TEXT =
  /not logged in|please run \/login|invalid api key|oauth token (has )?expired|token (has )?expired|authentication[_ ]failed|invalid bearer token|x-api-key/i

function textOf(v: unknown): string {
  if (typeof v === "string") return v
  if (Array.isArray(v)) return v.map(textOf).join(" ")
  if (v && typeof v === "object" && "text" in v) return textOf((v as { text: unknown }).text)
  return ""
}

/** True when an SDK message (or a thrown error) means the Claude login is missing, expired or rejected. */
export function isClaudeAuthFailure(m: unknown): boolean {
  if (m instanceof Error) return AUTH_TEXT.test(m.message)
  if (!m || typeof m !== "object") return false
  const msg = m as { type?: string; error?: unknown; is_error?: boolean; result?: unknown; errors?: unknown; message?: { content?: unknown } }
  if (msg.type === "assistant") {
    if (msg.error === "authentication_failed") return true
    return !!msg.error && AUTH_TEXT.test(textOf(msg.message?.content))
  }
  if (msg.type === "result" && msg.is_error) return AUTH_TEXT.test(textOf(msg.result) + " " + textOf(msg.errors))
  if (msg.type === "auth_status") return !!msg.error && AUTH_TEXT.test(String(msg.error))
  return false
}
