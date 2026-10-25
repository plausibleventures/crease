import { describe, expect, it } from "vitest"
import { chromeLayout, MIN_GAP } from "./chrome-layout"

describe("workspace chrome layout", () => {
  it("narrows the panels on narrow windows and keeps the part's gap", () => {
    for (const w of [1024, 1280, 1440, 1920]) {
      const l = chromeLayout(w, 800)
      expect(w - l.l - l.r).toBeGreaterThanOrEqual(MIN_GAP - 1)
    }
    expect(chromeLayout(1024, 800).chat).toBeLessThan(chromeLayout(1440, 800).chat)
    expect(chromeLayout(1024, 800).compact).toBe(true)
    expect(chromeLayout(1920, 800).compact).toBe(false)
  })

  it("honours dragged widths within range, and never squeezes the gap", () => {
    expect(chromeLayout(1920, 800, { chat: 500 }).chat).toBe(500)
    expect(chromeLayout(1920, 800, { chat: 9999 }).chat).toBe(560)
    const l = chromeLayout(1024, 800, { sidebar: 360, chat: 560 })
    expect(1024 - l.l - l.r).toBeGreaterThanOrEqual(MIN_GAP - 1)
  })
})
