import { describe, expect, it } from "vitest"
import type { MotionCheck } from "./types"
import { motionCheckText } from "./motion-text"

const chk = (minClearanceMm: number | null, extra: Partial<MotionCheck> = {}) =>
  ({ status: "ok", stale: false, motions: [{ id: "lid", minClearanceMm }], ...extra }) as unknown as MotionCheck

describe("motionCheckText: the guide's words follow the collision check (E2E #2 P3)", () => {
  const m = { id: "lid", check: "Swings open to about 110° without rubbing." }
  it("drops a 'without rubbing' claim when the check says it may rub", () => {
    expect(motionCheckText(m, chk(0.12))).toBe("Swings open to about 110°. It may rub a little at first (the closest gap is 0.12 mm): work it back and forth a few times.")
  })
  it("keeps the written words when the gap is fine, unknown, or the check is stale", () => {
    expect(motionCheckText(m, chk(0.4))).toBe(m.check)
    expect(motionCheckText(m, chk(null))).toBe(m.check)
    expect(motionCheckText(m, chk(0.1, { stale: true }))).toBe(m.check)
    expect(motionCheckText(m, null)).toBe(m.check)
  })
})
