// First-run setup and the starter gallery: system checks, adding the first printer (or the practice
// printer), per-printer fit tolerances, and the bundled starter ideas.
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { Machine, SetupCheck, Starter } from "../shared/types"
import { getSettings } from "./config"
import { defaultProfile, profileApiKey } from "./agent/profiles"
import { createMachine, deleteMachine, ensurePracticeMachine, getMachine, getMachines, updateMachine } from "./machines"
import { testMachine } from "./printer/index"
import { CLAUDE_CODE_INSTALL_URL, claudeAuthStatus, DOWNLOAD_URLS, toolVersion } from "./tools/discovery"
import { blenderInstallHint, blenderTool, claudeTool, devClaudeLoginEnabled, openscadTool, orcaSlicerTool } from "./tools/index"
import { claudeProgramInfo, describeClaudeProgram } from "./agent/runtime/claude/adapter"

const run = promisify(execFile)

// Packaged Electron sets PRINTSTUDIO_STARTERS to <app resources>/starters (see electron/main.ts).
export const STARTERS_DIR =
  process.env.PRINTSTUDIO_STARTERS ?? join(dirname(fileURLToPath(import.meta.url)), "../resources/starters")

/* ---------- checking the computer ---------- */

/** Not signed in anywhere yet: an API key first; using one's own Claude Code login is the second way. */
export const CLAUDE_ACCESS_HINT =
  "Add an Anthropic API key (console.anthropic.com > API keys; you pay Anthropic per message). Already use Claude Code? Sign in to it yourself (open Terminal, type \u201cclaude\u201d and follow its steps), then press Check again."

const SETUP_PAGE = { kind: "open-url" as const, label: "Claude Code setup page", url: CLAUDE_CODE_INSTALL_URL }

/**
 * The designer: Claude Code must be installed (the Agent SDK runs it for every session, API key or not; public builds
 * don't bundle it), plus an API key or the user's own Claude Code sign-in (INVENTORY B1/B2).
 */
async function checkClaude(): Promise<SetupCheck> {
  const prof = defaultProfile()
  const info = await claudeProgramInfo(prof)
  if (!info.path || !existsSync(info.path))
    return {
      ok: false,
      detail: "Claude Code isn't installed. Crease's designer runs on it (free to install from Anthropic).",
      hint: "Install Claude Code from Anthropic's page, then press Check again. If it's installed somewhere unusual, set its location in Settings.",
      fix: { kind: "open-url", label: "Install Claude Code", url: CLAUDE_CODE_INSTALL_URL },
    }
  const program = describeClaudeProgram(info)
  const where = { path: info.path, version: info.version ?? undefined, source: info.source === "settings" || info.source === "profile" ? ("settings" as const) : ("found" as const) }
  const outdated = info.outdated ? ` It's older than ${info.outdated.wanted}: update it (in Terminal, run \u201cclaude update\u201d).` : ""
  if (prof.runtime === "claude" && prof.auth.kind === "api-key" && profileApiKey(prof))
    return { ok: info.outdated ? null : true, detail: `${program}. Using your Anthropic API key (billed per message).${outdated}`, ...where }
  // The user's own Claude Code login: `claude auth status` reads it locally (no model call, no credential files).
  const st = await claudeAuthStatus(info.path)
  if (prof.auth.kind === "subscription") {
    if (st.loggedIn)
      return { ok: info.outdated ? null : true, detail: `${program}. Using your Claude plan through your own Claude Code sign-in${st.plan ? ` (${st.plan})` : ""}.${outdated}`, ...where }
    return {
      ok: st.loggedIn === false ? false : null,
      detail: st.loggedIn === false ? `${program}, but it isn't signed in.` : `${program}. Couldn't check its sign-in${st.error ? ` (${st.error})` : ""}: press Check again.`,
      hint: CLAUDE_ACCESS_HINT,
      ...where,
      fix: devClaudeLoginEnabled() ? { kind: "claude-login", label: "Sign in to Claude" } : { kind: "anthropic-key", label: "Add an API key", profileId: prof.id },
      altFix: SETUP_PAGE,
    }
  }
  // An API-key designer without a key.
  return {
    ok: false,
    detail: `${program}. Add an Anthropic API key so the designer can work${st.loggedIn ? ", or use the Claude plan your Claude Code is signed in to" : ""}.`,
    hint: st.loggedIn ? "Paste a key from console.anthropic.com > API keys (billed per message), or press \u201cUse my Claude Code sign-in\u201d (your Claude plan; no per-message charge)." : CLAUDE_ACCESS_HINT,
    ...where,
    fix: { kind: "anthropic-key", label: "Add an API key", profileId: prof.id },
    altFix: st.loggedIn ? { kind: "claude-use-login", label: "Use my Claude Code sign-in", profileId: prof.id } : SETUP_PAGE,
  }
}

/** OpenSCAD releases before the 2024+ development snapshots lack the Manifold backend Crease uses. */
function openscadTooOld(version: string | null): boolean {
  const year = Number(/^(\d{4})\./.exec(version ?? "")?.[1])
  return !!year && year < 2024
}

async function checkOpenscad(): Promise<SetupCheck> {
  const configured = getSettings().openscadPath
  const t = openscadTool()
  const fix = { kind: "open-url" as const, label: "Download OpenSCAD", url: DOWNLOAD_URLS.openscad }
  if (!t)
    return {
      ok: false,
      detail: configured
        ? `OpenSCAD isn't at the location set in Settings (${configured}), and no other copy was found.`
        : "OpenSCAD wasn't found. Crease uses it (free) to build your 3D models.",
      hint: "Download the OpenSCAD development snapshot for your Mac, drag it into Applications, then press Check again. If you keep it somewhere else, choose it in Settings.",
      fix,
    }
  const version = await toolVersion("openscad", t.path)
  const where = t.source === "settings" ? "set in Settings" : "found automatically"
  if (openscadTooOld(version))
    return {
      ok: false,
      detail: `OpenSCAD ${version} is too old (${where}). Crease needs a 2024 or newer development snapshot.`,
      hint: "Download the latest development snapshot (not the 2021 release), put it in Applications, then press Check again.",
      path: t.path,
      version: version ?? undefined,
      source: t.source,
      fix,
    }
  return {
    ok: true,
    detail: `OpenSCAD ${version ?? ""} ${where}.`.replace(/\s+/g, " "),
    path: t.path,
    version: version ?? undefined,
    source: t.source,
  }
}

async function checkOrca(): Promise<SetupCheck> {
  const configured = getSettings().orcaSlicerPath
  const t = orcaSlicerTool()
  if (!t)
    return {
      ok: false,
      detail: configured
        ? `OrcaSlicer isn't at the location set in Settings (${configured}), and no other copy was found.`
        : "OrcaSlicer wasn't found. It turns models into print files (free).",
      hint: "Download OrcaSlicer for macOS, drag it into Applications, then press Check again. You can still design without it.",
      fix: { kind: "open-url", label: "Download OrcaSlicer", url: DOWNLOAD_URLS.orcaslicer },
    }
  const version = await toolVersion("orcaslicer", t.path)
  return {
    ok: true,
    detail: `OrcaSlicer ${version ?? ""} ${t.source === "settings" ? "set in Settings" : "found automatically"}: Crease can prepare print files for you.`.replace(/\s+/g, " "),
    path: t.path,
    version: version ?? undefined,
    source: t.source,
  }
}

/** Blender is optional: without it everything works except sculpted parts (parts/*.blend.py). */
export async function checkBlender(): Promise<SetupCheck> {
  const configured = getSettings().blenderPath
  const t = blenderTool()
  if (!t)
    return {
      ok: false,
      detail: configured
        ? `Blender isn't at the location set in Settings (${configured}), and no other copy was found.`
        : "Blender wasn't found. It's optional: the designer uses it (free) to sculpt figures, animals and other flowing shapes.",
      hint: blenderInstallHint(),
      fix: { kind: "open-url", label: "Download Blender", url: DOWNLOAD_URLS.blender },
    }
  const version = await toolVersion("blender", t.path)
  return {
    ok: true,
    detail: `Blender ${version ?? ""} ${t.source === "settings" ? "set in Settings" : "found automatically"}: the designer can sculpt figures and flowing shapes.`.replace(/\s+/g, " "),
    path: t.path,
    version: version ?? undefined,
    source: t.source,
  }
}

export async function systemChecks(): Promise<{ claude: SetupCheck; openscad: SetupCheck; orcaslicer: SetupCheck; blender: SetupCheck }> {
  const [claude, openscad, orcaslicer, blender] = await Promise.all([checkClaude(), checkOpenscad(), checkOrca(), checkBlender()])
  return { claude, openscad, orcaslicer, blender }
}

/* ---------- signing in to Claude ---------- */

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * DEV ONLY (PRINTSTUDIO_DEV_CLAUDE_LOGIN=1): open Terminal running `claude auth login`. Public builds don't offer an
 * in-app Claude sign-in (docs/licenses/INVENTORY.md B1): people add an API key, or sign in to their own Claude Code.
 */
export async function openClaudeLogin(): Promise<{ ok: boolean; command: string; error?: string }> {
  if (!devClaudeLoginEnabled())
    return {
      ok: false,
      command: "claude",
      error: "Crease doesn't sign in to Claude for you. Add an Anthropic API key in Agents, or sign in to your own Claude Code (open Terminal, type “claude”).",
    }
  const bin = claudeTool()?.path
  if (!bin) return { ok: false, command: "claude auth login", error: "Claude Code wasn't found." }
  const command = `${shq(bin)} auth login`
  if (process.platform !== "darwin") return { ok: false, command, error: "Run this command in a terminal, then press Check again." }
  const dir = mkdtempSync(join(tmpdir(), "printstudio-login-"))
  const file = join(dir, "Sign in to Claude.command")
  const cfg = process.env.CLAUDE_CONFIG_DIR ? `export CLAUDE_CONFIG_DIR=${shq(process.env.CLAUDE_CONFIG_DIR)}\n` : ""
  writeFileSync(
    file,
    `#!/bin/sh\nclear\n${cfg}echo "Crease: signing in to Claude. Your browser will open; follow the steps there."\necho\n${command}\necho\necho "All set. Close this window and press Check again in Crease."\nrm -rf ${shq(dir)}\n`,
  )
  chmodSync(file, 0o755)
  try {
    await run("open", ["-a", "Terminal", file], { timeout: 10000 })
    return { ok: true, command }
  } catch (e) {
    return { ok: false, command, error: (e as Error).message }
  }
}

/* ---------- the first printer ---------- */

/**
 * Name + address of the first printer (or the built-in practice printer), saved as a Machine (made the default),
 * then test the connection. On first run the migrated placeholder machine is updated instead of adding a second.
 */
/**
 * Before onboarding finishes, the machine a fresh install migrates from the built-in default settings (the
 * "Creality SPARKX i7" at 127.0.0.1:7125, the dev mock's address) is a placeholder, not a printer the user set up.
 * A machine with a real address, confirmed filaments, or an install that finished setup is never a placeholder.
 */
export function placeholderMachine() {
  if (getSettings().onboardedAt) return undefined
  return getMachines().find(
    (m) =>
      m.id === "sparkx-i7" &&
      !m.isPractice &&
      !m.filamentsConfirmed &&
      (m.connection.type === "none" || ["127.0.0.1", "localhost", ""].includes(m.connection.host)),
  )
}

export async function setupFirstMachine(opts: { name?: string; host?: string; port?: number; practice?: boolean; model?: string }) {
  if (opts.practice) {
    // First run: the placeholder isn't a printer the user has; drop it so the practice printer is the default
    // (E2E #2 P1-a). Real machines stay untouched; then the practice printer only becomes the default when no
    // other enabled machine is the default.
    const placeholder = placeholderMachine()
    if (placeholder) deleteMachine(placeholder.id)
    const m = ensurePracticeMachine({ makeDefault: false })
    const r = await testMachine(m)
    if (r.ok) return { ok: true, practice: true, machineId: m.id, info: r.info }
    return { ok: false, practice: true, machineId: m.id, error: `The practice printer didn't start: ${r.error ?? "unknown error"}` }
  }
  const host = (opts.host ?? "").trim()
  const port = Number(opts.port) || 7125
  if (!host) return { ok: false, error: "Type the printer's address, or choose the practice printer." }
  const name = opts.name?.trim().slice(0, 60)
  const list = getMachines()
  const sameAddress = list.find((m) => m.connection.type === "moonraker" && m.connection.host === host && m.connection.port === port)
  // First run: the machine migrated from the old single-printer settings is a placeholder; reuse it.
  const target = sameAddress ?? placeholderMachine()
  const connection = { type: "moonraker" as const, host, port }
  const machine = target
    ? updateMachine(target.id, { connection, isDefault: true, ...(name ? { name } : {}), ...(opts.model ? { model: opts.model } : {}) })
    : createMachine({ name: name || undefined, model: opts.model || "Creality SPARKX i7", connection })
  const r = await testMachine(machine)
  if (r.ok) return { ok: true, practice: false, machineId: machine.id, info: r.info }
  return {
    ok: false,
    practice: false,
    machineId: machine.id,
    error: `Couldn't reach a printer at ${host}:${port}. Check it's switched on and on the same Wi-Fi, and that the address is right. (${r.error ?? "no answer"})`,
  }
}

/* ---------- fit tolerances (per printer) ---------- */

export type Tolerances = Machine["tolerances"]

export function getMachineTolerances(machineId?: string): Tolerances {
  return getMachine(machineId).tolerances
}

/** Save measured fits for one printer. Only the given keys change; null clears a value. */
export function setMachineTolerances(machineId: string | undefined, patch: Partial<Tolerances>): Tolerances {
  const m = getMachine(machineId)
  const clean = (v: unknown) => (v === null ? null : typeof v === "number" && isFinite(v) && v >= -1 && v <= 2 ? Math.round(v * 100) / 100 : undefined)
  const next = { ...m.tolerances }
  for (const k of ["slidingFitMm", "pressFitMm", "holeCompensationMm"] as const) {
    const v = clean(patch[k])
    if (v !== undefined) next[k] = v
  }
  return updateMachine(m.id, { tolerances: next }).tolerances
}

/* ---------- starters ---------- */

const STARTER_ID = /^[a-z0-9-]+$/

export function starterDir(id: string): string | null {
  if (!STARTER_ID.test(id)) return null
  const d = join(STARTERS_DIR, id)
  return existsSync(join(d, "project.json")) ? d : null
}

export function listStarters(): Starter[] {
  if (!existsSync(STARTERS_DIR)) return []
  const out: (Starter & { order: number })[] = []
  for (const id of readdirSync(STARTERS_DIR)) {
    const d = starterDir(id)
    if (!d) continue
    let meta: Partial<Starter & { order: number }> = {}
    try {
      meta = JSON.parse(readFileSync(join(d, "starter.json"), "utf8"))
    } catch {
      /* defaults */
    }
    out.push({
      id,
      title: meta.title ?? id,
      blurb: meta.blurb ?? "",
      tags: meta.tags ?? [],
      firstMessage: meta.firstMessage ?? null,
      thumbnailUrl: existsSync(join(d, "thumbnail.png")) ? `/api/starters/${id}/thumbnail.png` : null,
      order: meta.order ?? 99,
    })
  }
  return out.sort((a, b) => a.order - b.order).map(({ order: _o, ...s }) => (void _o, s))
}
