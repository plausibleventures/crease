// The design revision: one hash of everything that decides what gets printed. Approval and slice reviews are tied
// to it, and the gates recompute it at the moment they run, so a change from any source counts: the agent's
// Write/Edit, Bash (sed, cp, git checkout), set_parameters, the user's code editor or Customizer, a restored
// checkpoint or a branch switch. Nothing has to report its edits.
//
// The hashing lives in server/projects/revision.ts (shared with print jobs, so a job's staleness and the agent's
// approval agree on what "the design changed" means). See there for what is covered.
import { designRevisionAt } from "../projects/revision"
import { deps } from "./deps"

/** Hash of the project's design sources at this moment (hex, 16 chars), or null if the project can't be read. */
export function designRevision(projectId: string): string | null {
  let root: string
  try {
    root = deps.projectDir(projectId)
  } catch {
    return null
  }
  return designRevisionAt(root)
}
