// OS-level boundaries for the design agent's shell (R01). Claude Code runs every Bash command inside the OS
// sandbox (macOS seatbelt, bubblewrap on Linux) configured here; policy.ts is the in-harness layer on top.
//
// What the sandbox enforces for Bash (and everything Bash starts: python, node, openscad, curl, ...):
// - Writes: only the project folder (Claude Code's default: the session cwd) plus the sandbox's own temp dir.
//   App-owned paths inside the project are read-only: build/ (renders, STLs, sliced G-code/3MF), renders/,
//   .studio/, .git/, .claude/ (skills + settings the app loads), .mcp.json, project.json and CLAUDE(.local).md.
// - Network: none. No allowed domains and a strict allowlist, so every host is denied without a prompt, including
//   localhost (the app server, the mock printer) and every printer. Design work needs no network: OpenSCAD
//   libraries ship with the app/project and skills are local. Printers are reached only through the app's own
//   tools (request_print, printer status), which run in the server process outside the sandbox.
// - No escape hatch: allowUnsandboxedCommands=false makes Claude Code ignore `dangerouslyDisableSandbox`, and
//   failIfUnavailable=true makes the session fail at startup instead of silently running unsandboxed.
import { homedir } from "node:os"
import { join } from "node:path"
import { shellToolchainDirs } from "./readscope"
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk"

/** Project-relative paths the agent must never write (any tool, any depth below them). */
export const PROTECTED_PATHS = ["build", "renders", ".studio", ".git", ".claude", ".mcp.json", "project.json", "CLAUDE.md", "CLAUDE.local.md"] as const

export interface SandboxOptions {
  /** Printer hosts from machines.json; added to deniedDomains as a second line behind the empty allowlist. */
  printerHosts?: string[]
  /** Files Bash must not read (e.g. the app's settings.json, which can hold the API key). */
  denyRead?: string[]
  /**
   * Folders outside the project Bash may read (readscope.ts readRoots). Set = the home folder is unreadable except the
   * project, these and the toolchains installed under it (readscope.ts shellToolchainDirs).
   */
  readRoots?: string[]
}

export function sandboxSettings(root: string, opts: SandboxOptions = {}): SandboxSettings {
  const hosts = [...new Set((opts.printerHosts ?? []).map((h) => h.trim()).filter(Boolean))]
  return {
    enabled: true,
    failIfUnavailable: true,
    // Bash still goes through the PreToolUse hook and canUseTool (policy.ts): defence in depth.
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    network: {
      allowedDomains: [],
      deniedDomains: ["localhost", "127.0.0.1", "::1", ...hosts],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
    },
    filesystem: {
      allowWrite: [],
      denyWrite: PROTECTED_PATHS.map((p) => join(root, p)),
      denyRead: [...(opts.denyRead ?? []), ...(opts.readRoots ? [homedir()] : [])],
      ...(opts.readRoots ? { allowRead: [...new Set([root, ...opts.readRoots, ...shellToolchainDirs()])] } : {}),
    },
    // The API key (if the app passes one) is for the CLI itself, not for commands the agent runs.
    credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }] },
  }
}

/** Shown when the sandbox can't start (the session must not run without it). */
export const SANDBOX_UNAVAILABLE_MESSAGE =
  "The design assistant couldn't start its safety sandbox, so it won't run. On macOS this needs the built-in " +
  "sandbox-exec; on Linux install bubblewrap and socat. Restart Crease and try again."
