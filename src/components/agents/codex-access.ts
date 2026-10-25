// R11d follow-up: how a Codex designer signs in, as one choice on its card. Two settings sit behind it: the profile's
// auth (ChatGPT plan vs OpenAI API key) and Settings.codex.login (Crease's own Codex home vs the user's ~/.codex).
import type { AgentProfile, CodexRuntimeSettings } from "@shared/types"

export type CodexMode = "app" | "api-key" | "user"

export const CODEX_MODES: { mode: CodexMode; label: string; hint: string }[] = [
  { mode: "app", label: "ChatGPT plan", hint: "Sign in with ChatGPT." },
  { mode: "api-key", label: "OpenAI API key", hint: "Pay per message." },
  { mode: "user", label: "My Codex sign-in", hint: "Reuses Codex on this Mac." },
]

export function codexMode(auth: AgentProfile["auth"], s: CodexRuntimeSettings | undefined): CodexMode {
  if (auth.kind === "api-key") return "api-key"
  return s?.login === "user" ? "user" : "app"
}

/** What to change to switch to a mode: the profile's auth and/or Settings.codex.login. */
export function codexModeChange(
  to: CodexMode,
  cur: { auth: AgentProfile["auth"]; settings: CodexRuntimeSettings | undefined; keyRef: string },
): { auth?: AgentProfile["auth"]; login?: "app" | "user" } {
  const out: { auth?: AgentProfile["auth"]; login?: "app" | "user" } = {}
  if (to === "api-key") {
    if (cur.auth.kind !== "api-key") out.auth = { kind: "api-key", credentialRef: cur.keyRef }
    return out
  }
  if (cur.auth.kind !== "subscription") out.auth = { kind: "subscription" }
  const login = to === "user" ? "user" : "app"
  if ((cur.settings?.login === "user" ? "user" : "app") !== login) out.login = login
  return out
}
