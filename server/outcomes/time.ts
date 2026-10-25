// OWNER: feedback (R15). Shown estimates scaled by the machine's measured time factor (reads the print log only, so
// jobs/printer can import it without a cycle).
import type { AdjustedTime, CalibrationScope, TimeCalibration } from "../../shared/types"
import { listPrints } from "../db"
import { adjustTime, timeCalibration } from "./calibration"

export function timeCalibrationFor(scope: CalibrationScope): TimeCalibration {
  try {
    return timeCalibration(listPrints(undefined, 200, scope.machineId), scope)
  } catch {
    return { factor: null, prints: 0, ignored: 0, scope: "none" }
  }
}

export function adjustedTimeFor(scope: CalibrationScope, estimatedS: number | null | undefined): AdjustedTime | null {
  return estimatedS ? adjustTime(estimatedS, timeCalibrationFor(scope)) : null
}
