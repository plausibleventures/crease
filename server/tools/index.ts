// The external programs to run: OpenSCAD / OrcaSlicer / Blender (the Settings path if it exists, else discovered)
// and the Claude Code CLI that runs the designer (see discovery.ts for the search order).
import { getSettings } from "../config"
import { blenderExecutable, findClaude, findTool, homebrewPath, type FoundClaude, type FoundTool } from "./discovery"

export function openscadTool(): FoundTool | null {
  return findTool("openscad", getSettings().openscadPath)
}

export function orcaSlicerTool(): FoundTool | null {
  return findTool("orcaslicer", getSettings().orcaSlicerPath)
}

/** Blender (optional): runs sculpted parts' scripts (server/cad/blender.ts). The path is the real binary. */
export function blenderTool(): FoundTool | null {
  let configured: string | undefined
  try {
    configured = getSettings().blenderPath
  } catch {
    /* defaults */
  }
  const t = findTool("blender", configured)
  return t ? { ...t, path: blenderExecutable(t.path) } : null
}

/** How to get Blender, in one line: Homebrew when it's there, else the download page. Never installed for the user. */
export function blenderInstallHint(): string {
  return homebrewPath() ? "Get it free at blender.org, or in Terminal: brew install --cask blender" : "Get it free at blender.org, then drag it into Applications."
}

/** The `claude` binary design sessions run: Settings > the SDK's bundled one (dev) > the user's Claude Code. */
export function claudeTool(): FoundClaude | null {
  let configured: string | undefined
  try {
    configured = getSettings().claudePath
  } catch {
    /* defaults */
  }
  return findClaude(configured)
}

/**
 * The app's own "Sign in to Claude" (Terminal running `claude auth login`) is a developer convenience only. Public
 * builds never offer it (docs/licenses/INVENTORY.md B1): people use an API key, or sign in to their own Claude Code.
 */
export const devClaudeLoginEnabled = () => process.env.PRINTSTUDIO_DEV_CLAUDE_LOGIN === "1"

const MISSING = {
  openscad: "OpenSCAD isn't installed (or wasn't found). Install it from openscad.org, or set its location in Settings.",
  orcaslicer: "OrcaSlicer isn't installed (or wasn't found). Install it from orcaslicer.com, or set its location in Settings.",
  blender: "Blender isn't installed (or wasn't found). Sculpted parts (parts/*.blend.py) need it: install it free from blender.org (or `brew install --cask blender`), or set its location in Settings.",
}

/** Binary path, or throws a plain-language error. */
export function openscadBin(): string {
  const t = openscadTool()
  if (!t) throw Object.assign(new Error(MISSING.openscad), { code: "TOOL_MISSING" })
  return t.path
}

export function blenderBin(): string {
  const t = blenderTool()
  if (!t) throw Object.assign(new Error(MISSING.blender), { code: "TOOL_MISSING" })
  return t.path
}

export function orcaSlicerBin(): string {
  const t = orcaSlicerTool()
  if (!t) throw Object.assign(new Error(MISSING.orcaslicer), { code: "TOOL_MISSING" })
  return t.path
}
