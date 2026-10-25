// Regenerate resources/starters/*/thumbnail.png: each starter's primary part rendered like a project's part picture
// (OpenSCAD, iso view, the dark render scheme) with the background made transparent, so one picture suits the light
// and the dark theme (the same treatment as the app's <render>.clear.png part pictures).
//   PRINTSTUDIO_HOME=$(mktemp -d) npx tsx tools/make-starter-thumbnails.ts [starter-id …]
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

if (!process.env.PRINTSTUDIO_HOME) {
  console.error("Set PRINTSTUDIO_HOME to a scratch folder (the server config makes folders there).")
  process.exit(1)
}
const { openscadEngine } = await import("../server/cad/index")
const { clearBackground } = await import("../server/assembly/png")
const { partFace, previewSource } = await import("../server/cad/preview")
const sharp = (await import("sharp")).default

const STARTERS = join(import.meta.dirname, "..", "resources", "starters")
const only = process.argv.slice(2)
const out = mkdtempSync(join(tmpdir(), "ps-thumbs-"))
try {
  for (const id of readdirSync(STARTERS)) {
    if (only.length && !only.includes(id)) continue
    const dir = join(STARTERS, id)
    const starter = JSON.parse(readFileSync(join(dir, "starter.json"), "utf8")) as { primaryPart?: string }
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8")) as { parts: { id: string; file: string; colors?: string[] }[] }
    const part = project.parts.find((p) => p.id === starter.primaryPart) ?? project.parts[0]
    const png = join(out, `${id}.png`)
    // in the part's own colour, as a filament tone, from the same preview copy a project renders (server/cad/preview.ts)
    const src = join(dir, part.file)
    const shown = join(out, `${id}.preview.scad`)
    writeFileSync(shown, previewSource(readFileSync(src, "utf8"), dirname(src)))
    await openscadEngine.renderView(shown, png, "iso", undefined, 0, false, partFace(part.colors?.[0], part.id))
    // trim the empty margin, then pad back to the 4:3 card with a little room around the part
    const trimmed = await sharp(clearBackground(readFileSync(png))).trim().png().toBuffer({ resolveWithObject: true })
    const { width: w, height: h } = trimmed.info
    const W = Math.max(Math.round(w * 1.16), Math.round(h * 1.16 * (4 / 3)))
    const H = Math.round((W * 3) / 4)
    const left = Math.floor((W - w) / 2)
    const top = Math.floor((H - h) / 2)
    // (two pipelines: sharp resizes before it extends within one)
    const padded = await sharp(trimmed.data)
      .extend({ left, right: W - w - left, top, bottom: H - h - top, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
    const clear = await sharp(padded).resize(640, 480).png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer()
    writeFileSync(join(dir, "thumbnail.png"), clear)
    console.log(`${id}: ${part.file} -> thumbnail.png (${Math.round(clear.length / 1024)} KB)`)
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}
