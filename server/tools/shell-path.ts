// Apps opened from Finder/Dock on macOS get launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the
// one from the user's shell profile. Design sessions run Bash and look for tools on PATH, so the desktop app
// asks the login shell for its PATH once at startup and merges it in, plus the usual Homebrew/user folders.
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

const MARK = "__PRINTSTUDIO_PATH__"

/** PATH as the user's login shell sets it, or null (non-macOS/Linux, no shell, timeout). */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh"): string | null {
  if (process.platform === "win32") return null
  try {
    const out = execFileSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TERM: "dumb" },
    })
    const m = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(out)
    return m?.[1].trim() || null
  } catch {
    return null
  }
}

/** PATH with `extra` entries appended (deduplicated, order kept). */
export function mergePath(current: string | undefined, ...extra: (string | null | undefined)[]): string {
  const parts = [current, ...extra].filter(Boolean).flatMap((p) => p!.split(delimiter)).filter(Boolean)
  return [...new Set(parts)].join(delimiter)
}

/** Merge the login shell's PATH and common tool folders into process.env.PATH. Returns the new PATH. */
export function fixGuiPath(): string {
  if (process.platform === "win32") return process.env.PATH ?? ""
  const common = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", join(homedir(), ".local/bin")].join(delimiter)
  process.env.PATH = mergePath(process.env.PATH, loginShellPath(), common)
  return process.env.PATH
}
