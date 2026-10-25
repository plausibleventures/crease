// The box-with-lid starter's hinge must really clear: the lid's loops used to sweep exactly through the back wall's
// top edge at ~90° (0 mm gap), while its check text promised "without rubbing". Builds both parts with OpenSCAD.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Assembly } from "../../shared/types"

const home = mkdtempSync(join(tmpdir(), "printstudio-starter-box-"))
process.env.PRINTSTUDIO_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const OPENSCAD = "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
const STARTER = resolve(import.meta.dirname, "../../resources/starters/box-with-lid")

describe.skipIf(!existsSync(OPENSCAD))("box-with-lid starter", () => {
  it("lid swings 0–110° with at least the rub margin to the box, and says so honestly", { timeout: 120_000 }, async () => {
    const { checkMotion, RUB_MM } = await import("./motion")
    const { parseStl } = await import("../cad/mesh")
    const a = JSON.parse(readFileSync(join(STARTER, "assembly.json"), "utf8")) as Assembly
    const r = await checkMotion("starter", a, {
      loadMesh: async (id) => {
        const out = join(home, `${id}.stl`)
        execFileSync(OPENSCAD, ["--backend", "Manifold", "-o", out, join(STARTER, "parts", `${id}.scad`)], { stdio: "ignore" })
        return parseStl(readFileSync(out))
      },
    })
    // the motion turns about the hinge the parts are really built around
    const params = readFileSync(join(STARTER, "lib/params.scad"), "utf8")
    const num = (k: string) => Number(new RegExp(`^${k}\\s*=\\s*([\\d.]+)`, "m").exec(params)![1])
    expect(a.motions?.[0].origin).toEqual([0, num("box_d") + num("swing_gap") + num("knuckle_r"), num("box_h") + num("knuckle_r")])
    expect(r.status).toBe("ok")
    const lid = r.motions.find((m) => m.id === "lid")!
    expect(lid.collisions).toEqual([])
    expect(lid.minClearanceMm).not.toBeNull()
    expect(lid.minClearanceMm!).toBeGreaterThanOrEqual(RUB_MM)
    expect(lid.text).not.toMatch(/may rub/)
    // the guide's check line doesn't promise more than was checked
    expect(a.motions?.[0].check).not.toMatch(/without rubbing/i)
  })
})
