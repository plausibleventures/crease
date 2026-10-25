import { describe, expect, it } from "vitest"
import { collect, render } from "./notices"

describe("third-party notices (R21)", () => {
  const text = render()

  it("covers the non-npm material we ship", () => {
    expect(text).toContain("BOSL2 (OpenSCAD library)")
    expect(text).toContain("GNU AFFERO GENERAL PUBLIC LICENSE") // OrcaSlicer-derived profiles
    expect(text).toMatch(/agent skill: fdm-design-rules .*\n.*Apache-2\.0/)
    expect(text).toContain("Licence: proprietary (Anthropic PBC)")
  })

  it("lists runtime npm packages but not build-only tooling", () => {
    const names = new Set(collect().npm.map((c) => c.name))
    for (const n of ["react", "fastify", "three", "@phosphor-icons/react", "@fontsource/geist", "sharp"]) expect(names).toContain(n)
    for (const n of ["shadcn", "@tailwindcss/vite", "vite", "typescript", "eslint"]) expect(names).not.toContain(n)
  })

  it("has a licence for every package and no local paths", () => {
    for (const c of collect().npm) expect(c.license, c.name).not.toBe("UNKNOWN")
    expect(text).not.toMatch(/\/Users\/[a-z]/i)
  })
})
