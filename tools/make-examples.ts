// Builds the example build packs in examples/ from bundled starters, with no agent run (free, offline):
// starter -> project (throwaway PRINTSTUDIO_HOME) -> render every part (OpenSCAD) -> assembly guide (when the
// starter has one) -> build pack export (R16). Needs OpenSCAD (Settings path, /Applications, Homebrew or PATH).
//
// Usage: npx tsx tools/make-examples.ts [starter-id ...]
//
// Reproducible: the clock is pinned to SOURCE_DATE_EPOCH (default 2026-10-09T00:00:00Z), so the manifest date and
// zip timestamps don't change between runs. Renders and STLs depend on the OpenSCAD version (recorded in each
// example's README).
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "examples")
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH ?? Date.UTC(2026, 9, 9) / 1000) * 1000

/** Examples: starter id -> what the README says about it. */
const EXAMPLES: Record<string, { why: string }> = {
  "box-with-lid": { why: "Two printed parts, one piece of hardware (a filament pin), a hinge that moves, and an assembly guide." },
  "plant-pot": { why: "Two printed parts that go together, with a short assembly guide." },
  "cable-clip": { why: "The simplest kind of project: one part, no assembly." },
}

// Pin the clock (and the zone: zip entries store local time) before any server module runs.
process.env.TZ = "UTC"
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(EPOCH)
    else super(...(args as [string]))
  }
  static now() {
    return EPOCH
  }
}
globalThis.Date = FixedDate as DateConstructor

const home = mkdtempSync(join(tmpdir(), "ps-examples-"))
process.env.PRINTSTUDIO_HOME = home

async function main() {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXAMPLES)
  const { starterDir } = await import("../server/onboarding")
  const { createProjectFromStarter, getProject } = await import("../server/projects/store")
  const { renderPart } = await import("../server/cad/index")
  const { readAssembly, buildAssemblyGuide } = await import("../server/assembly/index")
  const { exportPack } = await import("../server/pack/index")
  const { openscadBin } = await import("../server/tools/index")
  const v = spawnSync(openscadBin(), ["--version"], { encoding: "utf8" })
  const openscad = `${v.stdout ?? ""}${v.stderr ?? ""}`.trim() || "an unknown OpenSCAD version"

  for (const id of ids) {
    const dir = starterDir(id)
    if (!dir) throw new Error(`no starter "${id}" in resources/starters`)
    const project = await createProjectFromStarter(dir)
    for (const p of (await getProject(project.id)).parts) {
      const r = await renderPart(project.id, p.id)
      if (r.error) throw new Error(`${id}/${p.id}: ${r.error}`)
    }
    const { assembly } = await readAssembly(project.id)
    if (assembly) await buildAssemblyGuide(project.id)
    const { zip, filename, manifest } = await exportPack(project.id, {
      // The examples follow the repository's licence (Apache-2.0).
      license: "Same licence as the Crease repository (see its LICENSE file)",
    })
    const outDir = join(OUT, id)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, filename), zip)
    const parts = manifest.parts.map((p) => `- **${p.name || p.id}**${p.sizeMm ? `: ${p.sizeMm.map((n) => +n.toFixed(1)).join(" × ")} mm` : ""}`)
    writeFileSync(
      join(outDir, "README.md"),
      [
        `# Example: ${manifest.project.name}`,
        "",
        EXAMPLES[id]?.why ?? "",
        "",
        `**Open it:** in Crease, Library > **Import pack** > \`${filename}\`. Without the app, unzip it: \`models/\``,
        "has STLs for any slicer, `source/` has the OpenSCAD files" + (manifest.files.some((f) => f.path === "guide/assembly-guide.html") ? ", `guide/assembly-guide.html` is the assembly guide." : "."),
        "",
        "Parts:",
        ...parts,
        "",
        `Made from the "${id}" starter (\`resources/starters/${id}\`) by \`npx tsx tools/make-examples.ts ${id}\`: no`,
        "designer (agent) run, so it costs nothing to rebuild. No G-code is included: slice it for your own printer.",
        `Rendered with ${openscad.replace(/\s+/g, " ")}. Check it: \`cd examples/${id} && unzip -o ${filename} -d /tmp/${id} && cd /tmp/${id} && shasum -a 256 -c CHECKSUMS.sha256\`.`,
        "",
      ].join("\n"),
    )
    console.log(`examples/${id}/${filename} (${(zip.length / 1024).toFixed(0)} KB, ${manifest.files.length} files)`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => rmSync(home, { recursive: true, force: true }))
