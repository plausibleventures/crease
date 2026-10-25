import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "lessons-"))
vi.mock("../machines", () => ({ machineLessonsPath: (id: string) => join(dir, id, "lessons.md") }))
const { addLesson, readLessons } = await import("./lessons")

describe("printer lessons", () => {
  it("starts empty, then appends dated one-line lessons with evidence", () => {
    expect(readLessons("i7")).toBe("")
    const line = addLesson("i7", "Garage i7", "Plate side is the cleanest face on textured PEI.", "apple logo v3, 2026-10-08", new Date("2026-10-08T12:00:00Z"))
    expect(line).toBe("- 2026-10-08: Plate side is the cleanest face on textured PEI (apple logo v3, 2026-10-08)")
    const text = readLessons("i7")
    expect(text).toMatch(/^# What Garage i7 has taught us/)
    expect(text).toContain(line)
  })

  it("doesn't record the same lesson twice and rejects essays", () => {
    expect(addLesson("i7", "Garage i7", "plate side is the cleanest face on textured PEI", "again")).toMatch(/already recorded/)
    expect(() => addLesson("i7", "Garage i7", "x".repeat(400), "")).toThrow(/one concise line/)
    expect(() => addLesson("i7", "Garage i7", "  ", "")).toThrow(/empty/)
  })

  it("truncates for the brief, keeping the newest lessons", () => {
    for (let i = 0; i < 40; i++) addLesson("busy", "Busy", `Lesson number ${i} about something specific enough to be worth keeping`, "test")
    const short = readLessons("busy", 600)
    expect(short.length).toBeLessThanOrEqual(650)
    expect(short).toContain("Lesson number 39")
    expect(short).not.toContain("Lesson number 0 ")
    expect(short).toMatch(/older lessons trimmed/)
  })
})
