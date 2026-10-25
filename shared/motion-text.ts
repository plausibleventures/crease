// Words about a motion that must agree with the on-screen collision check (server guide + app viewer).
import type { AssemblyMotion, MotionCheck } from "./types"

/** Below this gap the motion check warns that printed parts may rub. */
export const RUB_MM = 0.2

/** The motion's closest gap when the current check found it under RUB_MM (the check says "may rub"), else null. */
export function tightGap(m: Pick<AssemblyMotion, "id">, chk: MotionCheck | null | undefined): number | null {
  if (!chk || chk.stale || chk.status === "incomplete") return null
  const r = chk.motions.find((x) => x.id === m.id)
  return r && r.minClearanceMm !== null && r.minClearanceMm < RUB_MM ? r.minClearanceMm : null
}

/**
 * The motion's "check by hand" line, made to agree with the collision check (E2E #2 P3): when the check says the gap
 * is tight enough to rub, a written "without rubbing" / "freely" claim is replaced by what to expect.
 */
export function motionCheckText(m: Pick<AssemblyMotion, "id" | "check">, chk: MotionCheck | null | undefined): string {
  const text = m.check ?? ""
  const gap = tightGap(m, chk)
  if (!text || gap === null) return text
  const claim = /\s*,?\s*(without (any )?(rubbing|catching|scraping)|(moves|swings|slides|turns) freely|smoothly)\b/i
  const base = text.replace(claim, "").replace(/\s+([.,;])/g, "$1")
  return `${base.replace(/[.\s]*$/, ".")} It may rub a little at first (the closest gap is ${gap} mm): work it back and forth a few times.`
}
