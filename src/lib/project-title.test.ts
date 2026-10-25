import { describe, expect, it } from "vitest"
import { projectTitle } from "./project-title"

describe("projectTitle", () => {
  it("drops the asking words", () => {
    expect(projectTitle("Make me a phone stand")).toBe("Phone stand")
    expect(projectTitle("can you please make a hook for my bike helmet?")).toBe("Hook for my bike helmet")
    expect(projectTitle("I want something to organize my keys")).toBe("Organize my keys")
    expect(projectTitle("Hi! Could you design a small box with a lid, thanks")).toBe("Box with a lid")
    expect(projectTitle("two cable clips for my desk")).toBe("Cable clips for my desk")
  })
  it("keeps the first sentence and stays short", () => {
    expect(projectTitle("A planter for basil. It should drain well and sit on a saucer.")).toBe("Planter for basil")
    const long = projectTitle("make a wall mounted holder for three game controllers and two headsets with cable routing")
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toBe("Wall mounted holder for three game")
  })
  it("never returns nothing", () => {
    expect(projectTitle("")).toBe("New project")
    expect(projectTitle("make")).toBe("Make")
    expect(projectTitle("   ?  ")).toBe("New project")
  })
})
