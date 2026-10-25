// How Crease configures `codex app-server` (R11d): which Codex home (sign-in), the sandbox boundary, and the
// overrides that keep the user's own Codex setup out of design sessions.
//
// Isolation (R01 parity), verified with `codex sandbox -P` (macOS seatbelt) and live turns on Codex CLI 0.161:
// - A named permission profile (default_permissions = "printstudio") extending ":workspace": the project folder
//   (the thread's workspace root) is writable; build/, renders/, .studio/, .git/, .claude/, .codex/, .agents/,
//   project.json, CLAUDE*.md/AGENTS*.md are read-only; *.gcode/*.bgcode anywhere are denied (no hand-edited G-code);
//   the app's settings/secret files and Codex's own auth.json are unreadable. Network disabled: no host, including
//   127.0.0.1 and every printer. Like Claude's sandbox, the OS temp dirs stay writable.
// - Approvals: on-request, reviewed by the app (never an auto-reviewer). Requests to leave the sandbox are refused
//   by the app's policy before the user is asked (adapter.ts).
// - Config: Codex has no "ignore my config" switch. With login "app" the Codex home is the app's own
//   (<STUDIO_HOME>/codex), so ~/.codex (config, rules, skills, plugins, memories) is never read. With login "user"
//   the home is ~/.codex for its sign-in; every setting that matters is overridden here, but Codex still loads that
//   home's command rules (rules/*.rules), which can't be overridden or vetted. (Live check, CLI 0.161: a bare `curl`
//   matching a user "allow" rule stayed sandboxed and failed; that's Codex behaviour, not something the app enforces.)
//   So "user" is partial isolation, refused unless the user accepts it. API-key profiles use their own empty home
//   with an in-memory ("ephemeral") credential store: full isolation, the key never written to disk.
// - Both: project AGENTS.md / .codex layers are ignored (project_doc_max_bytes = 0, project untrusted), plugins,
//   apps (connectors), hooks, memories, browser/computer use, image generation, multi-agent are off, and every skill
//   that isn't one of the app's is disabled (skills.config, computed by a preflight skills/list).
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CodexRuntimeSettings } from "../../../../shared/types"
import { getSettings, STUDIO_HOME } from "../../../config"
import { shellHome, shellToolchainDirs } from "../../readscope"
import { PROTECTED_PATHS } from "../../sandbox"

export type CodexLogin = "app" | "user"

export function codexSettings(): CodexRuntimeSettings {
  try {
    return getSettings().codex ?? {}
  } catch {
    return {}
  }
}

export const codexLogin = (s: CodexRuntimeSettings = codexSettings()): CodexLogin => (s.login === "user" ? "user" : "app")

/** The app's own Codex home (login "app"): created on demand, private to the user. */
export const appCodexHome = () => process.env.PRINTSTUDIO_CODEX_HOME ?? join(STUDIO_HOME, "codex")
export const userCodexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex")

/**
 * Codex home for API-key profiles: no sign-in is ever stored here (cli_auth_credentials_store = "ephemeral"; the key
 * is given to the app-server with account/login/start and kept in its memory). Separate from the app home so a
 * ChatGPT sign-in and an API key never mix.
 */
export function apiCodexHome(): string {
  const h = join(STUDIO_HOME, "codex-api")
  mkdirSync(h, { recursive: true, mode: 0o700 })
  return h
}

export function codexHomeFor(login: CodexLogin): string {
  if (login === "user") return userCodexHome()
  const h = appCodexHome()
  mkdirSync(h, { recursive: true, mode: 0o700 })
  return h
}

/** Project paths the agent must not write, beyond the shared R01 list: Codex's own config/instruction locations. */
export const CODEX_PROTECTED_PATHS = [...PROTECTED_PATHS, ".codex", ".agents", "AGENTS.md", "AGENTS.override.md"] as const

/** TOML string (JSON string escapes are valid TOML basic-string escapes). */
const ts = (s: string) => JSON.stringify(s)

export interface ProfileOptions {
  /** Absolute files the agent must not read (the app's settings/secrets). */
  denyRead?: string[]
  /** The Codex home in use (its auth.json is denied to the agent). */
  codexHome: string
  /** Folders outside the project commands may read (readscope.ts). Set = the rest of the home folder is unreadable. */
  readRoots?: string[]
}

export const PROFILE_ID = "printstudio"

/** The permission profile (TOML inline table) for `-c permissions.printstudio=…`. */
export function permissionProfile(o: ProfileOptions): string {
  const roots: [string, string][] = [[".", "write"], ...CODEX_PROTECTED_PATHS.map((p): [string, string] => [p, "read"]), ["**/*.gcode", "deny"], ["**/*.bgcode", "deny"]]
  // Home folder unreadable except the read roots + toolchains (more specific entries win; the project is a workspace root).
  const home: [string, string][] = o.readRoots
    ? [[homedir(), "deny"], ...[...new Set([...o.readRoots, ...shellToolchainDirs()])].map((p): [string, string] => [p, "read"])]
    : []
  const fs: [string, string][] = [...home, ...[...(o.denyRead ?? []), join(o.codexHome, "auth.json")].map((p): [string, string] => [p, "deny"])]
  const table = (kv: [string, string][]) => kv.map(([k, v]) => `${ts(k)}=${ts(v)}`).join(", ")
  return `{extends=":workspace", filesystem={":workspace_roots"={${table(roots)}}${fs.length ? ", " + table(fs) : ""}}, network={enabled=false}}`
}

/** Codex features a design session never uses (connectors, plugins, hooks, memories, browser/computer use, …). */
export const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "hooks",
  "memories",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "worktrees",
  "realtime_conversation",
  // Not "code_mode_host": with it off the shell tool itself fails ("code-mode host is disabled", CLI 0.161).
] as const

export interface OverrideOptions extends ProfileOptions {
  cwd: string
  /** MCP server ids from the user's config layers (disabled). */
  mcpServers?: string[]
  /** SKILL.md paths of skills that aren't the app's (disabled). */
  disableSkills?: string[]
}

/** `-c key=value` overrides for `codex app-server`. */
export function configOverrides(o: OverrideOptions): string[] {
  const kv: string[] = [
    `default_permissions=${ts(PROFILE_ID)}`,
    `permissions.${PROFILE_ID}=${permissionProfile(o)}`,
    `approvals_reviewer="user"`,
    ...DISABLED_FEATURES.map((f) => `features.${f}=false`),
    // Instructions come from the app (developerInstructions); a project's AGENTS.md / .codex config isn't loaded.
    `project_doc_max_bytes=0`,
    `projects.${ts(o.cwd)}.trust_level="untrusted"`,
    `notify=[]`,
    `check_for_update_on_startup=false`,
    `analytics.enabled=false`,
    // Public web search (OpenAI-side, cached index) like Claude's WebSearch; the shell has no network.
    `web_search="cached"`,
    // Commands see the environment minus names containing KEY/SECRET/TOKEN.
    `shell_environment_policy.inherit="all"`,
    `shell_environment_policy.ignore_default_excludes=false`,
    // Home unreadable (readRoots): commands get an empty home, so login shells don't trip over ~/.profile.
    ...(o.readRoots ? [`shell_environment_policy.set.HOME=${ts(shellHome())}`] : []),
    ...(o.mcpServers ?? []).map((id) => `mcp_servers.${ts(id)}.enabled=false`),
    ...(o.disableSkills?.length ? [`skills.config=[${o.disableSkills.map((p) => `{path=${ts(p)}, enabled=false}`).join(", ")}]`] : []),
  ]
  return kv.flatMap((x) => ["-c", x])
}

/** Why login "user" isn't full isolation (shown on the Agents screen; the session needs the user's OK). */
export function userHomeIsolationReason(home = userCodexHome()): string {
  const rulesDir = join(home, "rules")
  let rules = 0
  try {
    rules = existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".rules")).length : 0
  } catch {
    /* unreadable: treat as none */
  }
  return (
    "Uses your own Codex sign-in (~/.codex). Crease turns off your Codex settings, plugins, skills and " +
    "connectors for design sessions, but Codex still applies your saved command rules" +
    (rules ? ` (${rules} rules file${rules > 1 ? "s" : ""} found)` : "") +
    ", which Crease can't turn off or check. In our tests the safety sandbox still held for an allowed command, " +
    "but that isn't something Crease controls. Sign in to Codex inside Crease for full isolation."
  )
}
