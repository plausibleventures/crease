// Which designers (runtimes) the app knows about (R11c). A runtime registered with registerRuntime() is usable by
// profiles and shows up on the Agents screen automatically; known runtimes that aren't registered in this build show
// as "coming soon" cards. To plug a new runtime in (R11d Codex, …): implement AgentRuntime (./types.ts) with an
// optional `info`, and register it in server/agent/index.ts (`RUNTIMES = [claudeRuntime, codexRuntime, grokRuntime, apiRuntime]`).
import type { AgentRuntimeInfo } from "../../../shared/types"
import type { AgentRuntime } from "./types"

/** Display info for known runtimes. A registered runtime's own `info` overrides its entry. */
export const KNOWN_RUNTIMES: Omit<AgentRuntimeInfo, "available">[] = [
  {
    kind: "claude",
    label: "Claude",
    blurb: "Anthropic's Claude Code. Crease is built and tested with it.",
    authKinds: ["subscription", "api-key"],
    subscriptionLabel: "Your Claude plan via your own Claude Code",
    apiKeyLabel: "Anthropic API key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    homepage: "https://code.claude.com/docs/en/setup",
  },
  {
    kind: "codex",
    label: "Codex",
    blurb: "OpenAI's Codex. Uses your ChatGPT plan or an OpenAI key.",
    authKinds: ["subscription", "api-key"],
    subscriptionLabel: "Your ChatGPT plan",
    apiKeyLabel: "OpenAI API key",
    apiKeyUrl: "https://platform.openai.com/api-keys",
    homepage: "https://developers.openai.com/codex",
  },
  {
    kind: "grok",
    label: "Grok Build",
    blurb: "xAI's Grok Build. Uses your Grok account or an xAI key.",
    authKinds: ["subscription", "api-key"],
    subscriptionLabel: "Your Grok account",
    apiKeyLabel: "xAI API key",
    apiKeyUrl: "https://console.x.ai",
    homepage: "https://docs.x.ai/build/overview",
  },
  {
    kind: "api",
    label: "API connection",
    blurb: "Talks to a model with an API key. Nothing to install. For tinkerers.",
    authKinds: ["api-key"],
    apiKeyLabel: "API key",
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
  },
]

/** The runtime catalog: registered runtimes first (usable), then known ones not in this build. */
export function runtimeCatalog(registered: AgentRuntime[]): AgentRuntimeInfo[] {
  const out: AgentRuntimeInfo[] = []
  for (const r of registered) {
    const known = KNOWN_RUNTIMES.find((k) => k.kind === r.kind)
    out.push({
      kind: r.kind,
      label: r.kind,
      blurb: "",
      authKinds: ["subscription"],
      ...known,
      ...r.info,
      available: true,
    })
  }
  for (const k of KNOWN_RUNTIMES) if (!registered.some((r) => r.kind === k.kind)) out.push({ ...k, available: false })
  return out
}

export function runtimeLabel(kind: string, registered: AgentRuntime[] = []): string {
  return registered.find((r) => r.kind === kind)?.info?.label ?? KNOWN_RUNTIMES.find((k) => k.kind === kind)?.label ?? kind
}
