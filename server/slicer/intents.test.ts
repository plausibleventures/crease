import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { INTENTS, objectParams, writeProcessFile } from "./intents"

const profile = join(import.meta.dirname, "../../resources/slicer-profiles/sparkx-i7")

describe("print intents", () => {
  it("only use keys the i7 process profile knows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "intent-"))
    for (const it of INTENTS) {
      const f = await writeProcessFile(profile, tmp, it.id)
      const j = JSON.parse(readFileSync(f, "utf8"))
      for (const [k, v] of Object.entries(it.overrides)) expect(j[k], `${it.id}.${k}`).toEqual(Array.isArray(j[k]) ? [String(v)] : String(v))
    }
  })
  it("validates per-part overrides and stringifies values", async () => {
    expect(await objectParams(profile, { ironing_type: "no ironing", wall_loops: 4 })).toEqual({ ironing_type: "no ironing", wall_loops: "4" })
    await expect(objectParams(profile, { wall_loopz: 3 })).rejects.toThrow(/unknown OrcaSlicer process setting/)
  })
})
