// Finding the external programs Crease drives: OpenSCAD, OrcaSlicer, Blender (optional: sculpted parts) and
// the Claude Code CLI.
//
// Order for OpenSCAD / OrcaSlicer / Blender: the path set in Settings (a binary or a .app bundle) if it exists, else the
// first match in the search folders: /Applications, ~/Applications (any "OpenSCAD*.app" / "OrcaSlicer*.app",
// so dated snapshots count), then Homebrew / PATH binaries. PRINTSTUDIO_TOOL_SEARCH_DIRS (colon-separated)
// replaces the folder list (tests point it at an empty folder to see the "missing" paths) and also turns off
// the PATH lookup.
//
// Claude Code: see "Claude Code CLI" below (the user's own install in public builds; the SDK's bundled one in dev).
import { execFile } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, userInfo } from "node:os"
import { basename, delimiter, join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

export type ToolId = "openscad" | "orcaslicer" | "blender"

export interface FoundTool {
  path: string
  /** "settings": the path chosen in Settings; "found": discovered automatically. */
  source: "settings" | "found"
}

interface ToolSpec {
  app: RegExp // .app bundle name in an Applications folder
  exe: string // binary inside Contents/MacOS/
  bins: string[] // command names on PATH / Homebrew
}

const SPECS: Record<ToolId, ToolSpec> = {
  openscad: { app: /^openscad.*\.app$/i, exe: "OpenSCAD", bins: ["openscad"] },
  orcaslicer: { app: /^orca-?slicer.*\.app$/i, exe: "OrcaSlicer", bins: ["orca-slicer", "OrcaSlicer"] },
  // Homebrew's `blender` is a small shell wrapper around /Applications/Blender.app (see blenderExecutable).
  blender: { app: /^blender.*\.app$/i, exe: "Blender", bins: ["blender"] },
}

function isFile(p: string) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** "/Applications/OpenSCAD.app" -> its binary; a binary path stays as is. Null when nothing runnable is there. */
export function resolveToolPath(tool: ToolId, p: string | null | undefined): string | null {
  const path = (p ?? "").trim().replace(/^~(?=\/|$)/, homedir()).replace(/\/+$/, "")
  if (!path) return null
  if (/\.app$/i.test(path)) {
    const macos = join(path, "Contents", "MacOS")
    const preferred = join(macos, SPECS[tool].exe)
    if (isFile(preferred)) return preferred
    try {
      const any = readdirSync(macos).find((f) => f.toLowerCase() === SPECS[tool].exe.toLowerCase())
      if (any) return join(macos, any)
    } catch {
      /* not a bundle */
    }
    return null
  }
  return isFile(path) ? path : null
}

function searchOverride(): string[] | null {
  const v = process.env.PRINTSTUDIO_TOOL_SEARCH_DIRS
  return v === undefined ? null : v.split(":").filter(Boolean)
}

/** Folders searched for .app bundles and loose binaries, in order. */
export function searchDirs(): { apps: string[]; bins: string[] } {
  const override = searchOverride()
  if (override) return { apps: override, bins: override }
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  return {
    apps: ["/Applications", join(homedir(), "Applications")],
    bins: [...new Set(["/opt/homebrew/bin", "/usr/local/bin", ...pathDirs])],
  }
}

/** Every candidate for a tool, best first (no Settings path). */
export function discoverAll(tool: ToolId): string[] {
  const spec = SPECS[tool]
  const { apps, bins } = searchDirs()
  const out: string[] = []
  for (const dir of apps) {
    let names: string[]
    try {
      names = readdirSync(dir).filter((n) => spec.app.test(n))
    } catch {
      continue
    }
    // Exact "OpenSCAD.app" first, then the rest (newest-looking name first: snapshots are dated).
    names.sort((a, b) => (a.length === spec.exe.length + 4 ? -1 : b.length === spec.exe.length + 4 ? 1 : b.localeCompare(a)))
    for (const n of names) {
      const p = resolveToolPath(tool, join(dir, n))
      if (p) out.push(p)
    }
  }
  for (const dir of bins)
    for (const b of spec.bins) {
      const p = join(dir, b)
      if (isFile(p)) out.push(p)
    }
  return [...new Set(out)]
}

/** The tool to run: the Settings path when it exists, else the first one found. Null when there is none. */
export function findTool(tool: ToolId, configured?: string | null): FoundTool | null {
  const fromSettings = resolveToolPath(tool, configured)
  if (fromSettings) return { path: fromSettings, source: "settings" }
  const found = discoverAll(tool)[0]
  return found ? { path: found, source: "found" } : null
}

/** The .app bundle a binary lives in (…/X.app/Contents/MacOS/X -> …/X.app), if any. */
export function appBundleOf(binPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/i.exec(binPath)
  return m ? m[1] : null
}

function plistVersion(binPath: string): string | null {
  const app = appBundleOf(binPath)
  if (!app) return null
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8")
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1].trim() ?? null
  } catch {
    return null
  }
}

async function cliVersion(binPath: string): Promise<string | null> {
  let out: string
  try {
    const { stdout, stderr } = await run(binPath, ["--version"], { timeout: 15000 })
    out = stdout || stderr
  } catch (e) {
    // Some CLIs print the version but exit non-zero.
    out = String((e as { stdout?: string }).stdout || (e as { stderr?: string }).stderr || "")
  }
  return /\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? null
}

/**
 * Installed version. OpenSCAD: `--version` (snapshot dates matter: 2026.10.05), else Info.plist. OrcaSlicer has no
 * --version flag, so its Info.plist (no launch); Blender's Info.plist too (a launch takes seconds). Null when unknown.
 */
export async function toolVersion(tool: ToolId, binPath: string): Promise<string | null> {
  if (tool === "openscad") return (await cliVersion(binPath)) ?? plistVersion(binPath)
  if (tool === "blender") return plistVersion(blenderExecutable(binPath)) ?? (await cliVersion(blenderExecutable(binPath)))
  return plistVersion(binPath)
}

/**
 * The real Blender program behind a found path. Homebrew's `blender` command is a shell script that execs the app
 * bundle; the sandboxed runner (server/cad/blender.ts) only lets the real binary start, so read the script for it.
 */
export function blenderExecutable(binPath: string): string {
  if (appBundleOf(binPath)) return binPath
  try {
    const head = readFileSync(binPath).subarray(0, 4096).toString("utf8")
    if (head.startsWith("#!")) {
      const m = /(\/[^\s"']*?\.app\/Contents\/MacOS\/Blender)\b/i.exec(head)
      if (m && isFile(m[1])) return m[1]
    }
  } catch {
    /* unreadable: use it as is */
  }
  return binPath
}

/** Homebrew's brew, when installed (the "Not found" hint then offers `brew install --cask blender`). */
export function homebrewPath(): string | null {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) if (isFile(p)) return p
  return null
}

/* ---------- Claude Code CLI ---------- */

//
// The Agent SDK needs a native `claude` binary for every session, API key and plan login alike: SDK 0.3.x has no
// JavaScript fallback and throws "Native CLI binary for <platform> not found" without one. Public builds don't ship
// the SDK's bundled binary (electron-builder excludes @anthropic-ai/claude-agent-sdk-<platform>; see
// docs/licenses/INVENTORY.md B2), so they run the user's own Claude Code. Order:
//   1. the path set in Settings (claudePath)            source "settings"
//   2. PRINTSTUDIO_CLAUDE_EXECUTABLE (tests, e2e)        source "env"
//   3. the SDK's bundled binary, when installed         source "bundled"  (dev / run from source)
//   4. the user's Claude Code: PATH (the desktop app merges the login shell's PATH at start), ~/.local/bin,
//      ~/.claude/local, Homebrew, /usr/local/bin         source "found"
// PRINTSTUDIO_NO_BUNDLED_CLAUDE=1 skips 3, to try a public build's behaviour from source.

export type ClaudeSource = "settings" | "env" | "bundled" | "found"
export interface FoundClaude {
  path: string
  source: ClaudeSource
}

/** Anthropic's official install page for Claude Code (what the setup checks link to). */
export const CLAUDE_CODE_INSTALL_URL = "https://code.claude.com/docs/en/setup"

const CLAUDE_EXE = process.platform === "win32" ? "claude.exe" : "claude"

/** The CLI binary bundled with the Agent SDK for this platform, if installed (never in public builds). */
export function bundledClaudeExecutable(): string | null {
  if (process.env.PRINTSTUDIO_NO_BUNDLED_CLAUDE === "1") return null
  const req = createRequire(import.meta.url)
  const exe = CLAUDE_EXE
  const pkgs =
    process.platform === "linux"
      ? [`linux-${process.arch}`, `linux-${process.arch}-musl`]
      : [`${process.platform}-${process.arch}`]
  for (const p of pkgs) {
    try {
      const f = req.resolve(`@anthropic-ai/claude-agent-sdk-${p}/${exe}`)
      // Packaged with asar the file would sit in app.asar.unpacked; we ship without asar, but be safe.
      const unpacked = f.replace(`${"app.asar"}/`, "app.asar.unpacked/")
      if (isFile(unpacked)) return unpacked
      if (isFile(f)) return f
    } catch {
      /* not installed */
    }
  }
  return null
}

/** Folders a user-installed Claude Code lives in, best first. PRINTSTUDIO_TOOL_SEARCH_DIRS replaces them (tests). */
export function claudeSearchDirs(): string[] {
  const override = searchOverride()
  if (override) return override
  const home = homedir()
  return [
    ...new Set([
      ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
      join(home, ".local/bin"), // the native installer
      join(home, ".claude/local"), // older "local" installs
      "/opt/homebrew/bin", // Homebrew (Apple silicon)
      "/usr/local/bin", // Homebrew (Intel), npm -g
    ]),
  ]
}

/** The user's own Claude Code, if installed. */
export function userClaudeExecutable(): string | null {
  for (const d of claudeSearchDirs()) {
    const p = join(d, CLAUDE_EXE)
    if (isFile(p)) return p
  }
  return null
}

/** The claude binary design sessions and checks run (order above). Null when there is none. */
export function findClaude(configured?: string | null): FoundClaude | null {
  const set = (configured ?? "").trim().replace(/^~(?=\/|$)/, homedir())
  if (set && isFile(set)) return { path: set, source: "settings" }
  const env = process.env.PRINTSTUDIO_CLAUDE_EXECUTABLE
  if (env) return { path: env, source: "env" }
  const bundled = bundledClaudeExecutable()
  if (bundled) return { path: bundled, source: "bundled" }
  const user = userClaudeExecutable()
  return user ? { path: user, source: "found" } : null
}

/** `claude --version` ("2.1.295 (Claude Code)" -> "2.1.295"). Null when it doesn't answer. */
export const claudeVersion = (bin: string): Promise<string | null> => cliVersion(bin)

/** <0, 0, >0 for dotted numeric versions ("2.1.9" < "2.1.10"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export interface ClaudeAuth {
  /** true signed in, false signed out, null couldn't tell */
  loggedIn: boolean | null
  method?: string
  plan?: string
  error?: string
}

/**
 * The environment for `claude auth status`. Claude Code finds its macOS Keychain login by the user name: without
 * USER it reports "not signed in" even when it is (E2E #2 P2-f), so fill USER/LOGNAME/HOME in when the app's own
 * environment lacks them (minimal launch environments, launchers that clear the env).
 */
export function claudeCheckEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  let who: { username: string; homedir: string } | null
  try {
    who = userInfo()
  } catch {
    who = null
  }
  if (!env.USER && who?.username) env.USER = who.username
  if (!env.LOGNAME && (env.USER || who?.username)) env.LOGNAME = env.USER || who!.username
  if (!env.HOME) env.HOME = who?.homedir || homedir()
  return env
}

/** The JSON object in `auth status` output, tolerating notices printed before or after it. */
export function parseAuthStatus(stdout: string): { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } | null {
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === "object" && "loggedIn" in v ? v : null
    } catch {
      return null
    }
  }
  const direct = tryParse(stdout.trim())
  if (direct) return direct
  const a = stdout.indexOf("{")
  const b = stdout.lastIndexOf("}")
  return a >= 0 && b > a ? tryParse(stdout.slice(a, b + 1)) : null
}

async function authStatusOnce(bin: string, timeoutMs: number): Promise<ClaudeAuth> {
  let stdout: string
  try {
    stdout = (await run(bin, ["auth", "status", "--json"], { timeout: timeoutMs, env: claudeCheckEnv() })).stdout
  } catch (e) {
    const err = e as { stdout?: string; killed?: boolean; signal?: string; code?: unknown; message?: string }
    stdout = String(err.stdout ?? "")
    if (!stdout.trim()) {
      const why = err.killed || err.signal === "SIGTERM" ? `no answer within ${Math.round(timeoutMs / 1000)} s` : err.code === "ENOENT" ? "the program wasn't found" : String(err.message ?? e).split("\n")[0]
      return { loggedIn: null, error: why }
    }
  }
  const st = parseAuthStatus(stdout)
  if (!st) return { loggedIn: null, error: `unexpected output from ${basename(bin)} auth status` }
  return { loggedIn: !!st.loggedIn, method: st.authMethod, plan: st.subscriptionType }
}

/**
 * `claude auth status --json`: reads the local login (no model call). It exits 1 when signed out. A first run of a
 * freshly installed/updated binary can be slow (macOS checks it), so an unclear answer is asked once more.
 */
export async function claudeAuthStatus(bin: string | null | undefined): Promise<ClaudeAuth> {
  if (!bin) return { loggedIn: null, error: "Claude Code CLI not found" }
  const first = await authStatusOnce(bin, 15000)
  if (first.loggedIn !== null) return first
  const again = await authStatusOnce(bin, 20000)
  return again.loggedIn !== null ? again : { ...again, error: again.error ?? first.error }
}

export const DOWNLOAD_URLS = {
  openscad: "https://openscad.org/downloads.html#snapshots",
  orcaslicer: "https://github.com/SoftFever/OrcaSlicer/releases/latest",
  blender: "https://www.blender.org/download/",
} as const
