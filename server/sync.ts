// R08: full-state snapshot for WS reconciliation (GET /api/sync/snapshot). Pairs with the sequenced event log in
// events.ts: the client takes a snapshot when replay is impossible, then re-applies live events with eventSeq > the
// snapshot's (event handlers are idempotent, so overlap is harmless).
import type { PrintRecord, SyncSnapshot, UnratedPrint } from "../shared/types"
import { listPrints } from "./db/index"
import { eventLog } from "./events"
import { listAllQuestions } from "./agent/questions"
import { getStatus, listAgentStatuses } from "./agent/index"
import { isPracticePrint, listMachinesWithStatus, listPrintRequests } from "./printer/index"
import { getProject } from "./projects/store"
import { getAssemblyInfo } from "./assembly/index"
import { projectJobs } from "./jobs"

export async function buildSnapshot(projectId?: string | null): Promise<SyncSnapshot> {
  // Capture the cursor first, then read: the state then reflects at least every event <= eventSeq. Events landing
  // while the async reads run are re-applied by the client (idempotent), so nothing is lost.
  const eventSeq = eventLog.lastSeq
  const snap: SyncSnapshot = {
    instanceId: eventLog.instanceId,
    eventSeq,
    takenAt: new Date().toISOString(),
    printRequests: listPrintRequests(),
    questions: listAllQuestions(),
    agents: listAgentStatuses(),
    machines: listMachinesWithStatus(), // cached status only: never contacts a printer
    unratedPrints: (() => {
      try {
        // practice prints never bring up the rating card (nothing real to judge)
        return unratedPrints(listPrints(undefined, 50).filter((p) => !isPracticePrint(p)))
      } catch {
        return [] // the catalog is optional for a snapshot
      }
    })(),
    project: null,
  }
  if (projectId) {
    try {
      const [project, agent] = await Promise.all([getProject(projectId), getStatus(projectId)])
      const [assembly, jobs] = await Promise.all([
        getAssemblyInfo(projectId).catch(() => null),
        projectJobs(projectId).catch(() => null),
      ])
      snap.project = { project, agent: { projectId, ...agent }, assembly, jobs }
    } catch (e) {
      snap.projectError = e instanceof Error ? e.message : String(e)
    }
  }
  return snap
}

/** How far back a missed "How did it turn out?" card is still offered after a reconnect. */
export const UNRATED_WINDOW_MS = 48 * 3600_000

/** Finished, unrated prints from the last 48 h, newest first (≤ 5). Pure: tested in sync.test.ts. */
export function unratedPrints(prints: PrintRecord[], now = Date.now()): UnratedPrint[] {
  return prints
    .filter((p) => p.state !== "printing" && p.finishedAt && !p.outcome && p.result == null)
    .filter((p) => now - Date.parse(p.finishedAt!) <= UNRATED_WINDOW_MS)
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))
    .slice(0, 5)
    .map((p) => ({ printId: p.id, projectId: p.projectId, state: p.state, finishedAt: p.finishedAt! }))
}
