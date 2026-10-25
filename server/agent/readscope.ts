// Where the design agent may read (every runtime). Reads are limited to the project folder plus a few app folders:
// the app's skills (installed copies live in <project>/.claude/skills, inside the project), the bundled OpenSCAD
// libraries (BOSL2 …; OpenSCAD itself runs in the server, but the agent reads library docs/sources) and the
// runtime's own per-session folders (Claude Code's temp dir and the folder where it saves long tool output for the
// agent to Read back). Everything else on disk — the user's documents, other projects, the app's settings — is off
// limits.
//
// Two layers use this:
// - tool-level reads (Claude Read/Glob/Grep via the PreToolUse policy, Grok fs/read_text_file, API read_file/list_files):
//   exactly readRoots() + the project.
// - shell sandboxes (Claude Bash, Codex commands, Grok terminals): the user's home folder is unreadable except the
//   project, readRoots() and shellToolchainDirs() (toolchains installed under the home folder, e.g. ~/.nvm, so
//   `node`/`python3` still start). System folders (/usr, /Applications, /opt) stay readable.
import { mkdirSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { BUNDLED_LIBRARIES_DIR, LIBRARIES_DIR } from "../cad/libraries"
import { canonicalPath, expandHome, isInside, realRoot } from "../projects/paths"
import { fileURLToPath } from "node:url"

/** Same folder as prompt.ts APP_SKILLS_DIR (not imported: policy.ts stays light). */
const APP_SKILLS_DIR = fileURLToPath(new URL("./skills/", import.meta.url))

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const uniq = (xs: string[]) => [...new Set(xs.map((x) => resolve(x)))]

/** Claude Code's folder for a session's saved tool output: <config>/projects/<cwd with non-alphanumerics as "-">. */
export function claudeProjectDataDir(cwd: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string {
  return join(configDir, "projects", real(cwd).replace(/[^a-zA-Z0-9]/g, "-"))
}

/** Claude Code's sandbox temp dir (TMPDIR inside the sandbox): /tmp/claude-<uid>. */
function claudeTempDirs(): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0
  return uniq([join("/tmp", `claude-${uid}`), join("/private/tmp", `claude-${uid}`), join(real(tmpdir()), `claude-${uid}`)])
}

/** Folders outside the project the agent may read. */
export function readRoots(projectRoot: string): string[] {
  return uniq([APP_SKILLS_DIR, LIBRARIES_DIR, BUNDLED_LIBRARIES_DIR, claudeProjectDataDir(projectRoot), ...claudeTempDirs()])
}

/**
 * Folders under the home folder that shell commands need to start programs: PATH entries there (plus the sibling lib/
 * of a .../bin entry, e.g. ~/.nvm/versions/node/v24/lib), plus Claude Code's shell snapshots (sourced before each command).
 */
export function shellToolchainDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const out: string[] = []
  for (const p of (env.PATH ?? "").split(delimiter)) {
    if (!p || !isAbsolute(p) || !isInside(home, p) || p === home || /\/node_modules\//.test(p)) continue
    out.push(p)
    // A .../bin entry: its sibling lib/ too (node's global modules, a pyenv Python's stdlib), not the whole prefix
    // (~/.grok/bin's prefix holds a sign-in).
    if (basename(p) === "bin" && dirname(p) !== home) out.push(join(dirname(p), "lib"))
  }
  out.push(join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "shell-snapshots"))
  return uniq(out)
}

/** The static folder part of a glob pattern ("/Users/x/**\/*.scad" -> "/Users/x"). */
function globBase(pattern: string): string {
  const parts = expandHome(pattern).split("/")
  const fixed: string[] = []
  for (const s of parts) {
    if (/[*?[\]{}]/.test(s)) break
    fixed.push(s)
  }
  return fixed.join("/") || "."
}

export const READ_OUTSIDE_MSG = (p: string) =>
  `Blocked by Crease: the designer can read only this project's files (plus its skills and the bundled OpenSCAD libraries); ${p} is outside. ` +
  "Work with files in the project folder. If the user wants to share a file (a photo, a model), ask them to add it to the project (drop it into the chat or use Import)."

/**
 * An empty, writable home folder for sandboxed commands (under the OS temp dir). With the real home unreadable, a
 * login shell would complain about ~/.profile on every command; PATH still comes from the app, so toolchains are found.
 */
export function shellHome(): string {
  const d = join(real(tmpdir()), `printstudio-shell-home-${typeof process.getuid === "function" ? process.getuid() : 0}`)
  mkdirSync(d, { recursive: true, mode: 0o700 })
  return d
}

/** Why reading `raw` (a path or, for Glob, a pattern) is not allowed, or null. */
export function readOutsideReason(root: string, raw: string, roots: string[], opts: { glob?: boolean } = {}): string | null {
  const p = opts.glob ? globBase(raw) : raw
  const abs = canonicalPath(root, p)
  if (isInside(realRoot(root), abs)) return null
  if (roots.some((r) => isInside(real(r), abs) || isInside(resolve(r), abs))) return null
  return READ_OUTSIDE_MSG(raw)
}
