// Canonical path containment for project folders (R09), shared by the HTTP routes, the studio MCP tools and the agent
// tool policy (server/agent/policy.ts).
//
// Symlink policy: a path is judged by where it really lands. Links whose target stays inside the project folder are
// followed (e.g. lib/common -> ../shared); a link anywhere along the way that leads outside the project (or into
// .git/) is refused, for reads and writes alike. For a path that doesn't exist yet, the deepest existing ancestor is
// resolved, so `parts/x/new.scad` with `parts/x -> /tmp` is caught before anything is created. App-owned output
// folders (build/, renders/, .studio/) must be real directories, never links (assertAppDir).
//
// There is a window between the check and the use (a link swapped in between); the agent's shell runs in the OS
// sandbox, which can't write outside the project, so it can't win that race with an outside target it created.
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p
}

/**
 * Canonical absolute path: realpath of the deepest existing ancestor plus the not-yet-existing rest, so a symlink
 * anywhere along the way (parts/b -> ../build, lib -> /etc) resolves to where a read or write would really land.
 */
export function canonicalPath(root: string, p: string, depth = 0): string {
  let cur = resolve(root, expandHome(p))
  const rest: string[] = []
  for (;;) {
    if (existsSync(cur)) {
      try {
        return join(realpathSync(cur), ...rest)
      } catch {
        /* unreadable: fall through to the lexical path */
      }
      break
    }
    // A dangling symlink doesn't "exist" but still redirects a write: follow its target instead of skipping it.
    let target: string | null = null
    try {
      if (lstatSync(cur).isSymbolicLink()) target = resolve(dirname(cur), readlinkSync(cur))
    } catch {
      /* not there at all */
    }
    if (target !== null) return depth > 32 ? join(target, ...rest) : canonicalPath(root, join(target, ...rest), depth + 1)
    const parent = dirname(cur)
    if (parent === cur) break
    rest.unshift(basename(cur))
    cur = parent
  }
  return resolve(root, expandHome(p))
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** realpath of the project root (falls back to the lexical path if it doesn't exist yet). */
export const realRoot = (root: string): string => realpathOrSelf(root)

/** Project-relative segments of where `p` really lands, or null if it lands outside the project. */
export function canonicalSegments(root: string, p: string): string[] | null {
  const base = realRoot(root)
  const abs = canonicalPath(root, p)
  if (!isInside(base, abs)) return null
  return relative(base, abs).split(sep).filter(Boolean)
}

export class PathError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
  }
}

/**
 * Resolve a project-relative path for the app's own reads and writes. Refuses: absolute paths and `..` escapes,
 * .git/, paths whose real location (symlinks resolved, including the existing parent of a new path) is outside the
 * project or inside .git/ (dangling links included). `within`: the real path's top-level folder must be one of these.
 * Returns the lexical absolute path (stable for callers that compute project-relative names).
 */
export function resolveInside(root: string, relPath: string, opts: { within?: readonly string[] } = {}): string {
  if (typeof relPath !== "string" || !relPath || relPath.includes("\0")) throw new PathError("path is required", 400)
  const abs = resolve(root, relPath)
  const rel = relative(root, abs)
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || isAbsolute(relPath) || rel.split(sep)[0] === ".git")
    throw new PathError(`path outside project: ${relPath}`, 400)
  const segs = canonicalSegments(root, abs)
  if (!segs) throw new PathError(`${relPath} goes through a link that leads outside the project folder`, 403)
  if (segs.includes(".git")) throw new PathError(`path outside project: ${relPath}`, 400)
  if (opts.within) {
    const lexTop = rel.split(sep)[0]
    if (!opts.within.includes(lexTop) || !opts.within.includes(segs[0] ?? ""))
      throw new PathError(`only ${opts.within.map((d) => d + "/").join(" and ")} can be used here`, 403)
  }
  return abs
}

/**
 * Make sure an app-owned folder inside the project (build/, renders/, .studio/) is a real directory, not a link
 * (an imported or tampered project could point build/ at another folder and have the app write there).
 */
export function assertAppDir(root: string, name: string): void {
  const p = join(root, name)
  let st
  try {
    st = lstatSync(p)
  } catch {
    return // missing: the app creates it as a real directory
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PathError(`${name}/ in this project is not a normal folder; remove it and try again`, 409)
}
