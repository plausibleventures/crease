// Settings > About > "Report a problem": the summary shared with a report. App, tool and OS versions only; never
// paths (they hold the user's name), keys, settings or project names.
import type { AboutInfo, SetupCheck } from "@shared/types"

export type ToolChecks = { claude: SetupCheck; openscad: SetupCheck; orcaslicer: SetupCheck; blender?: SetupCheck }

/** `optional`: everything works without it except one kind of design (Blender: sculpted parts). */
export const TOOLS: { key: keyof ToolChecks; name: string; optional?: boolean }[] = [
  { key: "openscad", name: "OpenSCAD" },
  { key: "orcaslicer", name: "OrcaSlicer" },
  { key: "claude", name: "Claude Code" },
  { key: "blender", name: "Blender", optional: true },
]

/** "2026.10.05", "found" (no version known), "not found", or "…" while checking. */
export const toolVersion = (c: SetupCheck | undefined) => (!c ? "…" : c.version ? c.version : c.path ? "found" : "not found")

const osName = (p: string) => ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[p] ?? p

export function diagnostics(a: AboutInfo, checks: ToolChecks | null): string {
  // a version string never needs more than this; anything longer or path-like is dropped
  const safe = (v: string) => (/^[\w .:+()-]{1,40}$/.test(v) && !/[/\\]/.test(v) ? v : "?")
  return [
    `${a.name} ${safe(a.version)} (${a.runtime.electron ? `desktop app, Electron ${safe(a.runtime.electron)}` : "browser build"})`,
    `${osName(a.os.platform)} ${safe(a.os.release)} ${safe(a.os.arch)} · Node ${safe(a.runtime.node)}`,
    ...TOOLS.filter((t) => !t.optional || checks?.[t.key]).map((t) => `${t.name}: ${safe(toolVersion(checks?.[t.key]))}`),
  ].join("\n")
}

/** The issue body / clipboard text: two prompts, then the versions. */
export const reportBody = (diag: string) => `What happened:\n\n\nWhat you expected:\n\n\n---\n${diag}\n`
