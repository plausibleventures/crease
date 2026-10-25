// OWNER: agent agent. The design agent: one session coordinator (coordinator.ts) over runtime adapters
// (runtime/: Claude Code via the Agent SDK today) and the app's tool registry (registry/).
//
// Transcripts: normalized events in <project>/.studio/sessions/<sessionId>.jsonl (legacy raw-SDK transcripts are
// migrated on read), native runtime messages in .studio/sessions/native/<sessionId>.jsonl. See transcript.ts.
import { join } from "node:path"
import type { AgentEnvelope, AgentEventEnvelope, AgentInputImage, HandoffReason, PointAnnotation, Project, RuntimeLoginStatus } from "../../shared/types"
import { getSettings, STUDIO_HOME } from "../config"
import { getMachines } from "../machines"
import { DISABLED_DIR, prepareAgentConfig } from "../projects/agent-config"
import { SessionCoordinator, type HandoffStart, type PreparedSession } from "./coordinator"
import { collectHandoffSummary } from "./handoff-collect"
import { machineLine, machinesWithStatus, targetMachine } from "./machines"
import { APP_SKILLS_DIR, buildAppendedPrompt, installProjectSkills } from "./prompt"
import { readRoots } from "./readscope"
import { studioTools } from "./registry"
import { resolveProfile } from "./profiles"
import { claudeRuntime } from "./runtime/claude/adapter"
import type { AgentRuntime } from "./runtime/types"

/**
 * Runtimes this build can run. A runtime listed here is usable by agent profiles and gets its own card on the
 * Agents screen (with its probe, capabilities and connection test); see runtime/catalog.ts. R11d: Codex (app-server). R11e: Grok Build (ACP). R11f: the direct API loop.
 */
export const RUNTIMES: AgentRuntime[] = [claudeRuntime, codexRuntime, grokRuntime, apiRuntime]
import { apiRuntime } from "./runtime/api/adapter"
import { codexRuntime } from "./runtime/codex/adapter"
import { grokRuntime } from "./runtime/grok/adapter"

export type InputImage = AgentInputImage

/** Optional per-call overrides (used by tests to keep runs cheap). */
export const agentTestOptions: { maxTurns?: number; model?: string } = {}

/** App-side session setup, the same for every runtime: agent config trust, skills, the brief, policy, model. */
async function prepareSession(projectId: string, project: Project, dir: string): Promise<PreparedSession> {
  // R09 import trust: project agent config the user hasn't turned on (settings/hooks, .mcp.json, CLAUDE.md, other
  // skills) is moved aside before the runtime loads the project's settings; then the app's skills go in.
  const { disabled: configDisabled } = prepareAgentConfig(projectId, dir, APP_SKILLS_DIR)
  installProjectSkills(dir)
  const settings = getSettings()
  const target = targetMachine(project)
  const otherMachines = (await machinesWithStatus().catch(() => []))
    .filter((x) => x.machine.id !== target.id)
    .map((x) => machineLine(x.machine, x.status))
  // Printer hosts the agent must never reach directly (the sandbox denies all hosts anyway; this names them).
  const printerHosts = [
    settings.printer?.host,
    ...(() => {
      try {
        return getMachines()
      } catch {
        return []
      }
    })().map((m) => (m.connection.type === "moonraker" ? m.connection.host : undefined)),
  ].filter((h): h is string => !!h)
  const denyRead = [join(STUDIO_HOME, "settings.json"), join(STUDIO_HOME, "secrets.json")]
  return {
    instructions: buildAppendedPrompt(project, otherMachines),
    policy: { printerHosts, denyRead, readRoots: readRoots(dir) },
    model: agentTestOptions.model ?? null, // tests/evals only: else the effective profile's model (profiles.ts)
    maxTurns: agentTestOptions.maxTurns,
    notices: configDisabled.length
      ? [
          `Turned off assistant settings that came with this project folder (${configDisabled.join(", ")}). They are kept in ${DISABLED_DIR}; turn them on only if you trust where the project came from.`,
        ]
      : [],
  }
}

export const coordinator = new SessionCoordinator({
  runtimes: RUNTIMES,
  resolveProfile,
  tools: studioTools,
  prepare: prepareSession,
  summarize: collectHandoffSummary,
  // Idle sessions have their runtime closed; the next message resumes them.
  idleMs: Number(process.env.PRINTSTUDIO_AGENT_IDLE_MS ?? 15 * 60_000),
})

const fmtV = (v: number[]) => `(${v.map((x) => Math.round(x * 10) / 10).join(", ")})`
function normalWords(n: number[]): string {
  const [x, y, z] = n
  const ax = [Math.abs(x), Math.abs(y), Math.abs(z)]
  const i = ax.indexOf(Math.max(...ax))
  return `${[x, y, z][i] >= 0 ? "+" : "-"}${"XYZ"[i]}`
}

/** The readable block the agent gets for pinned spots ("Pointed at: 1) part lid, top face near …"). */
export function annotationsBlock(annotations: PointAnnotation[], withPicture: boolean): string {
  if (!annotations.length) return ""
  const lines = annotations.map((a) => {
    const where = a.partId ? `part ${a.partId}${a.instance ? ` (copy ${a.instance + 1})` : ""}` : "the model"
    const asm = a.assemblyPoint ? `, assembly ${fmtV(a.assemblyPoint)} mm` : ""
    return `${a.n}) ${where}, ${a.hint}, at ${fmtV(a.point)} mm in the part's coordinates${asm}, surface normal ${normalWords(a.normal)}${a.note ? ` — "${a.note}"` : ""}`
  })
  return `\n\nPointed at on the model${withPicture ? " (numbered pins in the attached picture)" : ""}:\n${lines.join("\n")}`
}

export async function sendMessage(projectId: string, text: string, images: InputImage[] = [], annotations: PointAnnotation[] = []): Promise<{ sessionId: string | null }> {
  const agentText = (text || (annotations.length ? "Please change the spots I pointed at." : "")) + annotationsBlock(annotations, images.length > 0)
  return coordinator.sendMessage(projectId, text, images, annotations, agentText)
}

export const switchSession = (projectId: string, sessionId: string | null) => coordinator.switchSession(projectId, sessionId)
export const stop = (projectId: string) => coordinator.stop(projectId)
export const pauseAtQuestion = (projectId: string, requestId: string) => coordinator.pause(projectId, requestId)
export const appendNotice = (projectId: string, text: string) => coordinator.appendNotice(projectId, text)
export const setModel = (projectId: string, model: string) => coordinator.setModel(projectId, model)
export const setProjectProfile = (projectId: string, profileId: string | null, model: string | null) => coordinator.setProjectProfile(projectId, profileId, model)
export const forkAgentSession = (projectId: string, fromSessionId: string, title?: string) => coordinator.fork(projectId, fromSessionId, title)
export const previewHandoff = (projectId: string, reason: HandoffReason, target?: { profileId?: string | null; model?: string | null }) =>
  coordinator.previewHandoff(projectId, reason, target)
export const startHandoff = (projectId: string, o: HandoffStart) => coordinator.startHandoff(projectId, o)
export const closeSession = (projectId: string) => coordinator.closeSession(projectId)
export const answerQuestion = (projectId: string, requestId: string, answers: Record<string, string>, notes?: Record<string, string>) =>
  coordinator.answerQuestion(projectId, requestId, answers, notes)

/**
 * End every live session and make sure the runtime processes die (server shutdown, Electron quit, fatal error).
 * Synchronous on purpose so it can run from 'exit'/signal handlers.
 */
export const shutdownAgents = () => coordinator.shutdown()

/** Normalized events of the active session (what the timeline renders). */
export const getEvents = (projectId: string): Promise<AgentEventEnvelope[]> => coordinator.getEvents(projectId)
/** Native/legacy envelopes of the active session (diagnostics, evals). */
export const getTimeline = (projectId: string): Promise<AgentEnvelope[]> => coordinator.getNativeTimeline(projectId)

/** Status of every open agent session (sync snapshot; projects without one read as idle via getStatus). */
export const listAgentStatuses = () => coordinator.listStatuses()
export const getStatus = (projectId: string) => coordinator.getStatus(projectId)

/** Runtimes the app can use, with install/auth/capabilities (no model call). */
export const probeRuntimes = () =>
  Promise.all(
    RUNTIMES.map((r) =>
      r.probe().catch((e) => ({
        runtime: r.kind,
        installed: false,
        version: null,
        auth: { method: "none" as const, status: "unknown" as const },
        models: [],
        capabilities: r.capabilities,
        detail: e instanceof Error ? e.message : String(e),
      }))
    )
  )

/** Answer a permission.requested card (R11d). */
export const answerPermission = (projectId: string, requestId: string, allow: boolean) => coordinator.answerPermission(projectId, requestId, allow)


/** Start the Codex sign-in for the app's own Codex home; returns the URL to open in a browser. */
export const startCodexLogin = () => codexRuntime.login()

/** Start the Grok device sign-in for the app's own Grok home; returns the URL and the code to show. */
export const startGrokLogin = () => grokRuntime.login()

/** Where the last browser sign-in started for a runtime stands (polled by the sign-in modal). */
export function loginStatus(kind: string): RuntimeLoginStatus | null {
  if (kind === "codex") return codexRuntime.loginStatus()
  if (kind === "grok") return grokRuntime.loginStatus()
  return null
}

export function cancelLogin(kind: string): boolean {
  if (kind === "codex") codexRuntime.cancelLogin()
  else if (kind === "grok") grokRuntime.cancelLogin()
  else return false
  return true
}
