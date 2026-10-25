// Import trust for a project's agent configuration (R09).
//
// The design agent runs Claude Code with settingSources ["project"], so whatever sits in the project folder as Claude
// Code configuration is live in the session (Codex's project files — AGENTS.md, .codex/, .agents/ — are treated the
// same way, although the Codex runtime is also configured to ignore them; R11d): .claude/settings.json (hooks and helpers run commands OUTSIDE the
// sandbox, allow rules, env), .mcp.json (MCP servers are processes), CLAUDE.md / CLAUDE.local.md at any depth and
// .claude/agents|commands|rules|skills (instructions). A project folder copied, cloned or restored from elsewhere must
// not get any of that just by being opened.
//
// Rule: the app owns the folders of the skills it ships (.claude/skills/<app skill>/), re-installed every session as an
// exact mirror of the shipped copy (extra files and links in them are removed: installProjectSkills).
// Everything else that Claude Code would load is "project agent config" and stays OFF until the user turns it on:
//   - At every session start, each such item whose content isn't trusted is moved to .studio/agent-config-disabled/
//     (same relative path), where Claude Code doesn't look. Nothing is deleted.
//   - Turning it on (enableAgentConfig, POST /api/projects/:id/agent-config/enable) moves the items back and records
//     a content hash per item in <STUDIO_HOME>/agent-trust.json. That file is outside every project, so a project
//     (or the sandboxed agent, which can only write inside the project) can't mark itself trusted.
//   - A trusted item that later changes (different hash) is untrusted again and gets moved aside at the next start.
// The agent itself can't write any of these paths (policy.ts + the sandbox's denyWrite), so in practice only files
// put there from outside the app are affected; projects the app creates have none.
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { STUDIO_HOME } from "../config"
import { assertAppDir } from "./paths"

export const DISABLED_DIR = join(".studio", "agent-config-disabled")
// Instruction files: Claude Code's CLAUDE.md / CLAUDE.local.md and Codex's AGENTS.md / AGENTS.override.md.
const INSTRUCTIONS_RE = /^(CLAUDE(\.local)?|AGENTS(\.override)?)\.md$/i
// Config folders other agents load from a project: Codex (.codex/: config.toml, rules, hooks) and .agents/ (skills).
const OTHER_AGENT_DIRS = new Set([".codex", ".agents"])
// Folders the app owns or that are never project configuration; not searched for nested CLAUDE.md / .claude.
const SKIP_DIRS = new Set([".git", ".studio", "build", "renders", "node_modules"])

// Claude Code's own runtime bookkeeping in the top-level .claude/ — never configuration it loads, so app-owned:
// .cc-writes/ (staging folder for its atomic file writes), "<file>.tmp.<hex>" leftovers of those writes, and
// *.lock files (e.g. scheduled_tasks.lock). Without this every new project "came with its own assistant
// settings" after its first session (E2E #2 P2-c). Only real files/folders count: a link is still config.
const CLAUDE_RUNTIME_DIRS = new Set([".cc-writes"])
const CLAUDE_RUNTIME_FILE_RE = /(\.tmp\.(?:[0-9a-f]{8}|\d+\.[0-9a-f]{12})|\.lock)$/

/** Is this top-level .claude/ entry Claude Code's runtime bookkeeping rather than project configuration? */
export function isClaudeRuntimeEntry(claudeDir: string, name: string): boolean {
  const st = lstat(join(claudeDir, name))
  if (!st || st.isSymbolicLink()) return false
  if (CLAUDE_RUNTIME_DIRS.has(name)) return st.isDirectory()
  return st.isFile() && CLAUDE_RUNTIME_FILE_RE.test(name)
}

const defaultTrustFile = () => join(STUDIO_HOME, "agent-trust.json")

export interface AgentConfigOptions {
  /** Where trust is recorded (default <STUDIO_HOME>/agent-trust.json). */
  trustFile?: string
}

type TrustStore = Record<string, Record<string, string>>

function readTrust(file: string): TrustStore {
  try {
    const t = JSON.parse(readFileSync(file, "utf8")) as unknown
    return t && typeof t === "object" ? (t as TrustStore) : {}
  } catch {
    return {}
  }
}

function writeTrust(file: string, t: TrustStore) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n", { mode: 0o600 })
  renameSync(tmp, file)
}

function lstat(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Content hash of a file, link (its target text, never followed) or folder (recursively). */
export function entryHash(abs: string): string {
  const st = lstat(abs)
  const h = createHash("sha256")
  if (!st) h.update("missing")
  else if (st.isSymbolicLink()) h.update("link\0" + readlinkSync(abs))
  else if (st.isFile()) h.update("file\0").update(readFileSync(abs))
  else if (st.isDirectory()) {
    h.update("dir\0")
    for (const name of readdirSync(abs).sort()) h.update(name + "\0" + entryHash(join(abs, name)) + "\0")
  } else h.update("other")
  return h.digest("hex")
}

/**
 * Project-relative paths of every item an agent would load as project configuration that the app doesn't own:
 * CLAUDE.md / CLAUDE.local.md / AGENTS.md / AGENTS.override.md and .claude/ / .codex/ / .agents/ folders at any
 * depth, .mcp.json, and everything under the top-level .claude/ except the folders of the app's own skills (`appSkillsDir`: the folder of skills the app installs).
 */
export function findAgentConfig(root: string, appSkillsDir: string): string[] {
  const out: string[] = []
  const appSkills = new Set(existsSync(appSkillsDir) ? readdirSync(appSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [])
  if (lstat(join(root, ".mcp.json"))) out.push(".mcp.json")

  const claude = join(root, ".claude")
  const cst = lstat(claude)
  if (cst && (cst.isSymbolicLink() || !cst.isDirectory())) out.push(".claude")
  else if (cst) {
    for (const name of readdirSync(claude).sort()) {
      const rel = join(".claude", name)
      if (isClaudeRuntimeEntry(claude, name)) continue
      if (name !== "skills") {
        out.push(rel)
        continue
      }
      const sst = lstat(join(claude, name))!
      if (sst.isSymbolicLink() || !sst.isDirectory()) {
        out.push(rel)
        continue
      }
      for (const skill of readdirSync(join(claude, name)).sort()) if (!appSkills.has(skill)) out.push(join(rel, skill))
    }
  }

  // CLAUDE.md files and nested .claude/ folders anywhere else in the project (Claude Code loads nested ones lazily).
  let budget = 20000
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || budget <= 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (--budget <= 0) return
      const abs = join(dir, e.name)
      const rel = relative(root, abs)
      if (depth === 0 && (SKIP_DIRS.has(e.name) || e.name === ".claude")) continue
      if (INSTRUCTIONS_RE.test(e.name)) out.push(rel)
      else if (e.name === ".claude" || OTHER_AGENT_DIRS.has(e.name)) out.push(rel)
      else if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(abs, depth + 1) // links aren't followed (isDirectory is false)
    }
  }
  walk(root, 0)
  return out
}

/** Items currently moved aside (project-relative paths as they'll be restored). */
export function listDisabledAgentConfig(root: string, appSkillsDir: string): string[] {
  // The disabled folder mirrors the project layout, so the same scan finds the same items in it.
  const base = join(root, DISABLED_DIR)
  return existsSync(base) ? findAgentConfig(base, appSkillsDir).sort() : []
}

function moveAside(root: string, rel: string) {
  const from = join(root, rel)
  const to = join(root, DISABLED_DIR, rel)
  mkdirSync(dirname(to), { recursive: true })
  if (lstat(to)) rmSync(to, { recursive: true, force: true }) // a newer copy replaces an older disabled one
  renameSync(from, to)
}

/**
 * Before a session starts: move every untrusted project agent config item aside. Returns what was moved now.
 * Throws (409) if .studio/ isn't a real folder, so the session doesn't start with config it couldn't check.
 */
export function prepareAgentConfig(projectId: string, root: string, appSkillsDir: string, opts: AgentConfigOptions = {}): { disabled: string[] } {
  assertAppDir(root, ".studio")
  const trusted = readTrust(opts.trustFile ?? defaultTrustFile())[projectId] ?? {}
  const disabled: string[] = []
  for (const rel of findAgentConfig(root, appSkillsDir)) {
    if (trusted[rel] && trusted[rel] === entryHash(join(root, rel))) continue
    moveAside(root, rel)
    disabled.push(rel)
  }
  return { disabled }
}

/** What is on and what is off right now. */
export function agentConfigStatus(projectId: string, root: string, appSkillsDir: string, opts: AgentConfigOptions = {}) {
  const trusted = readTrust(opts.trustFile ?? defaultTrustFile())[projectId] ?? {}
  const present = findAgentConfig(root, appSkillsDir)
  return {
    enabled: present.filter((rel) => trusted[rel] === entryHash(join(root, rel))),
    // present but not trusted: will be moved aside when the next session starts
    pending: present.filter((rel) => trusted[rel] !== entryHash(join(root, rel))),
    disabled: listDisabledAgentConfig(root, appSkillsDir),
  }
}

/**
 * The user's explicit "use this project's own assistant settings": move disabled items back (and trust them along
 * with any untrusted ones in place) by recording their hashes. `paths`: only these (default: all). Items whose
 * original place is taken again are skipped.
 */
export function enableAgentConfig(projectId: string, root: string, appSkillsDir: string, paths?: string[], opts: AgentConfigOptions = {}) {
  assertAppDir(root, ".studio")
  const file = opts.trustFile ?? defaultTrustFile()
  const store = readTrust(file)
  const trusted = (store[projectId] ??= {})
  const want = (rel: string) => !paths || paths.includes(rel)
  const enabled: string[] = []
  const skipped: string[] = []
  for (const rel of listDisabledAgentConfig(root, appSkillsDir)) {
    if (!want(rel)) continue
    const dest = join(root, rel)
    if (lstat(dest)) {
      skipped.push(rel)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    renameSync(join(root, DISABLED_DIR, rel), dest)
    enabled.push(rel)
  }
  for (const rel of findAgentConfig(root, appSkillsDir)) if (want(rel)) trusted[rel] = entryHash(join(root, rel))
  writeTrust(file, store)
  return { enabled, skipped }
}

/** Turn a project's own agent config back off (forget the trust; items move aside at the next session start). */
export function revokeAgentConfig(projectId: string, opts: AgentConfigOptions = {}) {
  const file = opts.trustFile ?? defaultTrustFile()
  const store = readTrust(file)
  delete store[projectId]
  writeTrust(file, store)
}
