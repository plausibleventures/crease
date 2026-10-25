// How Crease runs `grok agent stdio` (R11e): which Grok home (sign-in), the environment, and the config files
// that keep the user's own Grok/Claude/Cursor setup out of design sessions.
//
// Isolation layers (outermost first):
// 1. Effects run by the app: shell commands arrive as ACP terminal/* requests and run under the app's own macOS
//    sandbox profile (shell.ts); file writes arrive as fs/write_text_file and are written (or refused) by the app with
//    the same policy as Claude's Write/Edit (policy.ts protectedReason).
// 2. Permission gate: Grok runs in ask mode; the adapter answers every session/request_permission by policy.
// 3. Grok's own Seatbelt profile (GROK_SANDBOX="printstudio", sandbox.toml below, extends "strict") for what stays in
//    Grok's process (read_file, grep, list_dir): reads limited to the project and system paths; G-code and the app's
//    secret files denied. (Its read_only grant doesn't hold inside the workspace and its network switch is a no-op on
//    macOS, which is why layer 1 exists.)
// 4. Config: an app-owned GROK_HOME (<STUDIO_HOME>/grok for the Grok sign-in, grok-api for API keys) and an empty
//    HOME for the Grok process, so ~/.grok, ~/.claude, ~/.agents and ~/.cursor (skills, rules, MCP servers, hooks)
//    are never loaded. Compat scanning, telemetry, memory, subagents, workflows, web fetch, auto-update: off.
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { STUDIO_HOME } from "../../../config"
import { PROTECTED_PATHS } from "../../sandbox"

/** How a session signs in: Crease's own Grok home (`grok login` inside the app) or an xAI API key. */
export type GrokAccessMode = "app" | "api-key"

/** Crease's own Grok home (sign-in with the Grok account). */
export const appGrokHome = () => process.env.PRINTSTUDIO_GROK_HOME ?? join(STUDIO_HOME, "grok")
/** Grok home for API-key profiles: never holds a sign-in (the key is only in the process environment). */
export const apiGrokHome = () => join(STUDIO_HOME, "grok-api")

export const grokHomeFor = (mode: GrokAccessMode) => (mode === "api-key" ? apiGrokHome() : appGrokHome())

/** The empty HOME the Grok process sees (no ~/.claude, ~/.agents, ~/.cursor, shell rc files). */
export const fakeHomeOf = (grokHome: string) => join(grokHome, "home")

/** Project paths the agent must not write, beyond the shared R01 list: Grok's own config/instruction locations. */
export const GROK_PROTECTED_PATHS = [...PROTECTED_PATHS, ".grok", ".agents", "AGENTS.md", "AGENTS.override.md"] as const

export const SANDBOX_PROFILE = "printstudio"

/** TOML string (JSON string escapes are valid TOML basic-string escapes). */
const ts = (s: string) => JSON.stringify(s)
const arr = (xs: string[]) => `[${xs.map(ts).join(", ")}]`

export interface GrokConfigOptions {
  /** The Grok home in use (its auth.json is denied to the agent's read tools). */
  home: string
  /** Absolute files the agent must not read (the app's settings/secrets). */
  denyRead?: string[]
  /** Extra TOML appended to config.toml (tests: a local fake model endpoint). Never user input. */
  extra?: string
}

/** <GROK_HOME>/config.toml for a design session (rewritten at every start). Documented keys only. */
export function grokConfigToml(o: GrokConfigOptions): string {
  const deny = [join(o.home, "auth.json"), ...(o.denyRead ?? [])].map((p) => `Read(${p})`)
  const compat = ["skills", "rules", "agents", "mcps", "hooks"].map((k) => `${k} = false`).join("\n")
  return `# Written by Crease for its design sessions; changes are overwritten.
[cli]
auto_update = false

[features]
telemetry = false
feedback = false
codebase_indexing = false

[session]
load_envrc = false

[ui]
remember_tool_approvals = false

[toolset.ask_user_question]
timeout_enabled = false

[compat.claude]
${compat}

[compat.cursor]
${compat}

[permission]
deny = ${arr(deny)}
${o.extra ? `\n${o.extra.trim()}\n` : ""}`
}

export interface SandboxProfileOptions {
  denyRead?: string[]
  /** Folders outside the project the agent may read (bundled OpenSCAD libraries). */
  readOnly?: string[]
}

/** <GROK_HOME>/sandbox.toml: Grok's own Seatbelt profile for its in-process tools. */
export function grokSandboxToml(o: SandboxProfileOptions): string {
  return `# Written by Crease; changes are overwritten.
[profiles.${SANDBOX_PROFILE}]
extends = "strict"
restrict_network = true
read_only = ${arr(o.readOnly ?? [])}
deny = ${arr(["**/*.gcode", "**/*.bgcode", ...(o.denyRead ?? [])])}
`
}

/**
 * Grok tools a design session must never run. Some of them never ask permission (scheduler_create, image_gen and the
 * other media tools, workflow), and refusing a permission ends Grok's turn, so they are blocked by a PreToolUse hook:
 * a hook "deny" fails just that call with the reason shown to the model, and the turn goes on.
 */
export const GROK_BLOCKED_TOOLS = [
  "scheduler_create",
  "scheduler_delete",
  "scheduler_list",
  "image_gen",
  "image_edit",
  "image_to_video",
  "reference_to_video",
  "workflow",
  "spawn_subagent",
  "web_fetch",
] as const

export const BLOCKED_TOOL_REASON =
  "Blocked by Crease: this tool isn't available in design sessions (no scheduled prompts, image or video generation, workflows or subagents). Use Crease's tools instead."

/**
 * <GROK_HOME>/hooks/printstudio.json: a global hook (always trusted, write-protected by Grok's own sandbox) denying the
 * blocked tools. The handler is an inline `printf` of a fixed decision: nothing to crash (hooks fail open).
 */
export function grokHooksJson(): string {
  const decision = JSON.stringify({ decision: "deny", reason: BLOCKED_TOOL_REASON })
  const shellQuoted = `'${decision.replace(/'/g, "'\\''")}'`
  return (
    JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: `^(${GROK_BLOCKED_TOOLS.join("|")})$`, hooks: [{ type: "command", command: `printf '%s' ${shellQuoted}`, timeout: 5 }] }] } },
      null,
      2
    ) + "\n"
  )
}

/** Create the Grok home (0700), its fake HOME, config.toml, sandbox.toml and the blocking hook. */
export function prepareGrokHome(home: string, o: GrokConfigOptions & SandboxProfileOptions) {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(fakeHomeOf(home), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, "config.toml"), grokConfigToml(o), { mode: 0o600 })
  writeFileSync(join(home, "sandbox.toml"), grokSandboxToml(o), { mode: 0o600 })
  mkdirSync(join(home, "hooks"), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, "hooks", "printstudio.json"), grokHooksJson(), { mode: 0o600 })
  linkRuntimeSockets(fakeHomeOf(home))
}

/** Container runtime sockets Grok's sandbox denies; macOS links them into the user's home (Docker Desktop). */
export const RUNTIME_SOCKETS = ["/var/run/docker.sock"]

/**
 * Grok 1.0.13+ refuses to start its sandbox when a runtime socket it denies (/var/run/docker.sock) is a link to a
 * path outside its deny list, and it builds that list from HOME (~/.docker/run/docker.sock). Our HOME is the empty
 * fake one, so with Docker Desktop installed every session failed to start ("could not apply the sandbox profile").
 * Mirroring the socket's folder at the same place under the fake HOME makes the denied path resolve to the real
 * socket again. Only the socket's own folder is linked, and Grok's sandbox still denies the socket itself.
 */
export function linkRuntimeSockets(fakeHome: string, realHome = homedir(), sockets = RUNTIME_SOCKETS) {
  for (const sock of sockets) {
    let target: string
    try {
      target = realpathSync(sock)
    } catch {
      try {
        target = resolve(dirname(sock), readlinkSync(sock)) // a link to a socket that isn't there now (Docker not running)
      } catch {
        continue // no such socket (no Docker)
      }
    }
    const under = (home: string) => {
      const r = relative(home, dirname(target))
      return r && !r.startsWith("..") && !isAbsolute(r) ? r : null
    }
    const rel = under(realHome) ?? under(realpathSync(realHome))
    if (!rel) continue // not under the home: Grok's list covers it as is
    const link = join(fakeHome, rel)
    try {
      lstatSync(link)
      continue // already there
    } catch {
      /* create it */
    }
    try {
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
      symlinkSync(dirname(target), link)
    } catch (e) {
      console.error("[grok] couldn't link the runtime socket folder", e)
    }
  }
}

/** Environment for the Grok process: built from scratch (no inherited keys), plus the API key when there is one. */
export function grokEnv(home: string, apiKey: string | null, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ["PATH", "LANG", "LC_ALL", "TMPDIR", "USER", "LOGNAME", "SHELL", "TERM"]) if (base[k]) env[k] = base[k]!
  Object.assign(env, {
    HOME: fakeHomeOf(home),
    GROK_HOME: home,
    GROK_SANDBOX: SANDBOX_PROFILE,
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
    GROK_WORKFLOWS: "0",
    GROK_WEB_FETCH: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
  })
  if (apiKey) env.XAI_API_KEY = apiKey
  return env
}
