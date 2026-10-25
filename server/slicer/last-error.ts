// The last slice failure of a project (U1): kept in .studio/slice-error.json with the design revision it happened
// on, so the overview can keep saying what went wrong (in plain words) instead of a toast that fades. A successful
// slice clears it; a design change makes it moot (it is only shown while the design is still that revision).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { projectDir } from "../projects/store"
import { designRevisionAt } from "../projects/revision"
import { plainSliceError, type SliceErrorKind } from "../../shared/slice-errors"

export interface SliceErrorRecord {
  at: string
  revision: string
  message: string // plain words
  kind: SliceErrorKind
  detail: string // the slicer's own message
}

const file = (projectId: string) => join(projectDir(projectId), ".studio", "slice-error.json")

export function recordSliceError(projectId: string, raw: string) {
  try {
    const root = projectDir(projectId)
    const { message, kind } = plainSliceError(raw)
    const rec: SliceErrorRecord = { at: new Date().toISOString(), revision: designRevisionAt(root), message, kind, detail: raw.slice(0, 2000) }
    mkdirSync(join(root, ".studio"), { recursive: true })
    writeFileSync(file(projectId), JSON.stringify(rec, null, 2) + "\n")
  } catch {
    /* best effort: the caller still gets the error */
  }
}

export function clearSliceError(projectId: string) {
  try {
    const f = file(projectId)
    if (existsSync(f)) rmSync(f, { force: true })
  } catch {
    /* best effort */
  }
}

/** The last slice failure, if the design is still the revision it failed on. */
export function currentSliceError(projectId: string): SliceErrorRecord | null {
  try {
    const rec = JSON.parse(readFileSync(file(projectId), "utf8")) as SliceErrorRecord
    return rec.revision === designRevisionAt(projectDir(projectId)) ? rec : null
  } catch {
    return null
  }
}
