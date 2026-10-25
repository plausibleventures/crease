// Crease's own tools for the design agent, defined once for every runtime (see types.ts). Names, descriptions
// and input schemas are the agent-facing contract: changing them changes what every runtime's model sees.
import { readFile, writeFile } from "node:fs/promises"
import { z } from "zod"
import { deps } from "../deps"
import { resolveInside } from "../../projects/paths"
import { applyPyParameters, isSculptFile } from "../../cad/sculpt"
import { clearOverrides, isSharedFor, paramLinksAt } from "../../projects/revision"
import { getSnapshot } from "../../printer/index"
import { slicePart, slicePlate } from "../../slicer/index"
import { parseGcodeFile } from "../../gcode/parse"
import { analyzeGcode } from "../../gcode/analyze"
import { layerPng } from "../../gcode/render"
import type { PrintIntent } from "../../../shared/types"
import { confirmLoadedFilaments, getLoadedFilaments } from "../../printer/filaments"
import { onToolAllowed } from "../approval"
import { fileSha256, noteReviewed, noteSliced, requestPrintGate } from "../review"
import { enabledMachines, loadedColours, machineLine, machinesWithStatus, targetMachine } from "../machines"
import { emit } from "../../events"
import { addLesson, readLessons } from "../lessons"
import { projectOutcomes } from "../../outcomes"
import { describeOutcome } from "../../outcomes/brief"
import { doneChecklist, failingChecks, formatChecklist, notePlan, notePreview, noteSliceResult } from "../done"
import { assemblySchema } from "../../assembly/schema"
import { approvedDesign, guideBuilt } from "./gates"
import { listIdeas } from "../../projects/ideas"
import { compareIdeas, describeComparison } from "../../projects/compare"
import { listCheckpoints } from "../../projects/store"
import { defineTool, type ToolContent, type ToolContext, type ToolDef, type ToolResult } from "./types"

const intentParams = {
  intent: z
    .enum(["display", "strong", "fast", "draft", "standard"])
    .optional()
    .describe("Print intent: display (ironed top, slower crisp edges), strong, fast, draft, standard (stock; default)"),
  overrides: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Extra OrcaSlicer process settings, e.g. {\"wall_loops\": \"4\"}"),
}

export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] })
export const json = (v: unknown) => text(JSON.stringify(v, null, 2))
export const fail = (e: unknown): ToolResult => ({
  content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
})

/** Map an artifact URL (/api/projects/:id/artifacts/renders/x.png?v=..) to an absolute file path. */
function artifactUrlToPath(projectId: string, url: string): string | null {
  const m = url.split("?")[0].match(/\/artifacts\/(.+)$/)
  if (!m) return null
  try {
    return resolveInside(deps.projectDir(projectId), decodeURIComponent(m[1]), { within: ["build", "renders"] })
  } catch {
    return null
  }
}

const partId = z.string().describe("Part id, i.e. the file name in parts/ without .scad (or .blend.py)")
const paramValue = z.union([z.number(), z.string(), z.boolean()])

function scadLiteral(v: number | string | boolean): string {
  if (typeof v === "string") return JSON.stringify(v)
  return String(v)
}

/** Rewrite top-level `name = <literal>;` assignments in a .scad file. Returns names not found. */
export function applyParameters(source: string, values: Record<string, number | string | boolean>) {
  let out = source
  const missing: string[] = []
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_]*$/.test(name)) {
      missing.push(name)
      continue
    }
    const re = new RegExp(`^(\\s*${name.replace(/\$/g, "\\$")}\\s*=\\s*)([^;]*)(;)`, "m")
    if (!re.test(out)) {
      missing.push(name)
      continue
    }
    out = out.replace(re, (_m, a: string, _b: string, c: string) => `${a}${scadLiteral(value)}${c}`)
  }
  return { source: out, missing }
}

async function partFile(projectId: string, id: string) {
  const project = await deps.getProject(projectId)
  const ref = project.parts.find((p) => p.id === id)
  return ref?.file ?? `parts/${id}.scad`
}

/**
 * set_parameters: write design values where they are declared. A shared setting (an include<>d project file's, or
 * one several parts declare with the same value) is written in every file that declares it, so every part that has
 * it keeps the same value; a part's own setting only in the file that declares it for that part. Saved Customizer
 * values of those settings are dropped so the new design value shows. R09: the server writes outside the agent's
 * sandbox, so each path goes through resolveInside (a parts/ link the agent made must not carry the write out).
 */
async function setDesignValues(projectId: string, partId: string, values: Record<string, number | string | boolean>) {
  const root = deps.projectDir(projectId)
  const own = await partFile(projectId, partId)
  const links = paramLinksAt(root)
  const mine = links.byPart.get(partId)
  const plan = new Map<string, Record<string, number | string | boolean>>()
  const shared: string[] = []
  const alsoParts = new Set<string>()
  for (const [name, v] of Object.entries(values)) {
    const l = isSharedFor(links, partId, name) ? links.byName.get(name) : undefined
    const files = l ? l.files : [mine?.get(name) ?? own]
    if (l) {
      shared.push(name)
      for (const id of l.parts) if (id !== partId) alsoParts.add(id)
    }
    for (const f of files) plan.set(f, { ...(plan.get(f) ?? {}), [name]: v })
  }
  const found = new Set<string>()
  const writes: { abs: string; source: string; rel: string }[] = []
  for (const [rel, vals] of plan) {
    const abs = resolveInside(root, rel)
    let src: string
    try {
      src = await readFile(abs, "utf8")
    } catch {
      continue
    }
    // a Blender part script keeps its settings in its settings block (server/cad/sculpt.ts)
    const { source, missing } = isSculptFile(rel) ? applyPyParameters(src, vals) : applyParameters(src, vals)
    for (const n of Object.keys(vals)) if (!missing.includes(n)) found.add(n)
    if (source !== src) writes.push({ abs, source, rel })
  }
  const missing = Object.keys(values).filter((n) => !found.has(n))
  if (!found.size) return { missing }
  for (const w of writes) await writeFile(w.abs, w.source)
  const updated = Object.fromEntries(Object.entries(values).filter(([k]) => found.has(k)))
  const sharedSet = [...found].filter((n) => shared.includes(n))
  const cleared = [
    ...clearOverrides(root, sharedSet),
    ...clearOverrides(
      root,
      [...found].filter((n) => !shared.includes(n)),
      [partId],
    ),
  ]
  return {
    updated,
    missing,
    files: writes.map((w) => w.rel),
    ...(alsoParts.size ? { sharedWith: [...alsoParts] } : {}),
    ...(cleared.length ? { clearedSavedValues: [...new Set(cleared)] } : {}),
  }
}

/** JSON from a tool's text result (the first `{` to the last `}`), or null. */
function resultJson(r: ToolResult): unknown {
  const raw = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n")
  try {
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1))
  } catch {
    return null
  }
}

/** Keeps the done checklist current from slice results (what the agent was told, paths project-relative). */
const noteSlice = (ctx: ToolContext, _input: unknown, r: ToolResult) => {
  const parsed = resultJson(r)
  if (parsed) noteSliceResult(ctx.projectId, parsed)
}

export const STUDIO_TOOLS = [
  defineTool({
    name: "share_plan",
    description:
      "Show the user a short checklist card of what you've decided or assumed for them (size in inches with mm, how it mounts, colours, anything to buy, and any printer limit that shaped a choice). Plain words. Keep working afterwards; it doesn't wait for a reply.",
    input: {
      title: z.string().optional().describe("Short heading, e.g. 'Your key rack'"),
      bullets: z.array(z.string()).min(1).max(8).describe("3-6 short assumption bullets in plain words"),
    },
    handler: async (ctx, { title, bullets }) => {
      notePlan(ctx.projectId, [title ?? "", ...bullets].join("\n"))
      return text("Shown to the user.")
    },
  }),

  defineTool({
    name: "list_parts",
    description:
      "List the project's parts, their files and current Customizer parameters. Parts with imported.kind \"mesh\" are imported STL/3MF meshes: a fixed shape you can scale (scale_percent), rotate (set_orientation) and place, but not reshape with parameters; never edit their .stl. Imported .scad parts (imported.kind \"scad\") are editable like any part; imported.licence/source say where they came from.",
    input: {},
    handler: async (ctx) => {
      const project = await deps.getProject(ctx.projectId)
      const parts = await Promise.all(
        project.parts.map(async (p) => {
          let parameters: unknown
          try {
            parameters = await deps.listParameters(ctx.projectId, p.id)
          } catch (e) {
            parameters = { error: e instanceof Error ? e.message : String(e) }
          }
          return { ...p, parameters }
        }),
      )
      return json(parts)
    },
  }),

  defineTool({
    name: "render_part",
    description:
      "Export a part with OpenSCAD and render preview images (iso, front, top, right, bed). A Blender part (parts/<id>.blend.py) is first run in Blender (sandboxed; a script error comes back as the error with its traceback) and also gets a back view; `notes` say what the build did on its own (simplified the mesh, moved it onto the bed). Returns the images, mesh stats and the done checklist. Render once per meaningful change and look at the images.",
    input: {
      partId,
      params: z
        .record(z.string(), paramValue)
        .optional()
        .describe("Optional Customizer overrides. Saved as the part's values (shown in the Parameters panel) and used by every later render, check and slice; {} clears them. Omit to keep the saved ones. A shared setting (from an include<>d file, or the same setting in several parts) has one value for every part that has it: changing it here changes it for them too."),
    },
    handler: async (ctx, { partId, params }) => {
      const r = await deps.renderPart(ctx.projectId, partId, params)
      const content: ToolContent[] = []
      const { images, ...rest } = r
      content.push({ type: "text", text: JSON.stringify({ ...rest, views: images.map((i) => i.view) }, null, 2) })
      for (const img of images) {
        const p = artifactUrlToPath(ctx.projectId, img.url)
        if (!p) continue
        try {
          const data = (await readFile(p)).toString("base64")
          content.push({ type: "text", text: `View: ${img.view}` })
          content.push({ type: "image", data, mimeType: "image/png" })
        } catch {
          content.push({ type: "text", text: `View ${img.view}: image missing at ${img.url}` })
        }
      }
      if (!r.error) content.push({ type: "text", text: formatChecklist(await doneChecklist(ctx.projectId).catch(() => [])) })
      return { content, isError: Boolean(r.error) }
    },
  }),

  defineTool({
    name: "check_part",
    description:
      "Run printability checks (manifold, fits bed, floating bodies, first layer, overhangs, tall/thin, thin walls and features too thin to print for this nozzle, colours, estimates) and return them with the done checklist (open items across the project). `orientation` compares ways to lay it on the bed (supports, bridges, bed contact, height) and may suggest a better one with reasons and the `rotate` for set_orientation.",
    input: { partId },
    handler: async (ctx, { partId }) => {
      const report = await deps.checkPart(ctx.projectId, partId)
      return text(`${JSON.stringify(report, null, 2)}\n\n${formatChecklist(await doneChecklist(ctx.projectId).catch(() => []))}`)
    },
  }),

  defineTool({
    name: "export_part",
    description: "Write the part's STL or 3MF into build/ and return the file path.",
    input: { partId, format: z.enum(["stl", "3mf"]).optional() },
    handler: async (ctx, { partId, format }) => json({ path: await deps.exportPart(ctx.projectId, partId, format ?? "stl") }),
  }),

  defineTool({
    name: "set_parameters",
    description:
      "Change Customizer parameter values where they are declared (top-level literal assignments) without hand-editing code. A shared setting (from an include<>d file like lib/params.scad, or the same setting in several parts) changes in every file that declares it, so all parts that use it keep matching (`sharedWith` lists the other parts: render and check them too). Saved slider values of these settings are dropped so the new value shows. Render and check afterwards.",
    input: { partId, values: z.record(z.string(), paramValue) },
    handler: async (ctx, { partId, values }) => {
      const r = await setDesignValues(ctx.projectId, partId, values)
      if (!("updated" in r)) return fail(`No matching top-level assignments for: ${r.missing.join(", ")}`)
      onToolAllowed(ctx.projectId, "set_parameters", values) // geometry changed: needs a new look
      return json(r)
    },
  }),

  defineTool({
    name: "set_orientation",
    description:
      "Lay a part on the bed a different way without changing its shape: writes `print_orientation = [x, y, z];` and `rotate(print_orientation) { … }` around the part's geometry in its .scad (later calls only change the numbers; [0, 0, 0] = as modelled). Use the `rotate` of check_part's orientation suggestion. Works for imported meshes too, and for Blender parts (a `print_orientation = [x, y, z]` line in the script that the app applies to the finished mesh). Render and check afterwards; how it sits changed, so the user needs a fresh look.",
    input: { partId, rotate: z.array(z.number().min(-360).max(360)).length(3).describe("Degrees about x, y, z (OpenSCAD rotate()), absolute") },
    handler: async (ctx, { partId, rotate }) => {
      const r = await deps.setPartOrientation(ctx.projectId, partId, rotate as [number, number, number])
      onToolAllowed(ctx.projectId, "set_orientation", { partId, rotate })
      return json({ ...r, next: "render_part, then check_part" })
    },
  }),

  defineTool({
    name: "save_checkpoint",
    description: "Commit the project's current state to git. Message format: 'agent: <summary>'.",
    input: { message: z.string() },
    handler: async (ctx, { message }) => {
      const msg = message.startsWith("agent:") ? message : `agent: ${message}`
      return json({ commit: await deps.saveCheckpoint(ctx.projectId, msg) })
    },
  }),

  defineTool({
    name: "slice_part",
    description:
      "Slice one part on its own with OrcaSlicer (a build of several parts goes through slice_plate). Returns gcodePath, estimated time and filament use. Parts with 2+ color() colours are sliced multicolour (each colour -> its loaded CFS slot; returns filamentBySlot and colorChanges).",
    input: { partId, machineId: z.string().optional().describe("Machine to slice for; default printer if omitted"), ...intentParams },
    gates: [approvedDesign, guideBuilt],
    handler: async (ctx, { partId, machineId, intent, overrides }) => {
      // ctx.revision was taken before the gates ran, i.e. before slicing: the slice record is tied to it.
      const r = await (deps.slicePart as typeof slicePart)(ctx.projectId, partId, machineId, { intent, overrides })
      noteSliced(ctx.projectId, r, ctx.revision)
      return json(r)
    },
    after: noteSlice,
  }),

  defineTool({
    name: "slice_plate",
    description:
      "Slice the whole build for printing: every part x its qty (or the given parts) arranged together on the bed in one OrcaSlicer run. Returns one G-code per plate (build/plate.gcode, or plate-1/plate-2... if it needs more than one bed) with summed time and filament. Call request_print once per plate. Multicolour parts map each color() to its CFS slot. Parts in different colours: the result's colorPlan says how they'll print (one part or one colour at a time when that's cheaper than swapping every layer) — tell the user its summary. Each plate lists its objects with the letter the user sees on the plate view (A, B, C… in the order of `parts`), so call variants by those letters.",
    input: {
      parts: z
        .array(
          z.object({
            partId,
            qty: z.number().int().min(1).max(50).optional(),
            overrides: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
              .optional()
              .describe('Per-part OrcaSlicer settings on top of the plate intent, e.g. {"ironing_type": "no ironing"} (test plates: compare settings side by side)'),
          }),
        )
        .optional()
        .describe("Default: all project parts at their qty. The same part may be listed twice with different overrides."),
      machineId: z.string().optional().describe("Machine to slice for; default printer if omitted"),
      machineIds: z
        .union([z.array(z.string()), z.literal("idle")])
        .optional()
        .describe('Printer farm: spread the plates over these machines (or "idle" = every idle one). Each plate comes back with its machineId; request_print it there.'),
      ...intentParams,
    },
    gates: [approvedDesign, guideBuilt],
    handler: async (ctx, { parts, machineId, machineIds, intent, overrides }) => {
      const r = await slicePlate(ctx.projectId, parts, machineId, { machineIds }, { intent, overrides })
      noteSliced(ctx.projectId, r, ctx.revision)
      return json(r)
    },
    after: noteSlice,
  }),

  defineTool({
    name: "preview_slice",
    description:
      "Look at a sliced G-code before printing: quality issues (gap fill on the top, no ironing, fast visible walls, things starting in mid-air, stringing risk) with plain fixes, plus pictures of the top surfaces, the first layer and any layers you ask for (or the layers an issue points at). Read-only.",
    input: {
      gcodePath: z.string().describe("G-code path relative to the project, e.g. build/main.gcode (from slice_part / slice_plate)"),
      layers: z.array(z.number().int().min(0)).max(4).optional().describe("Extra 0-based layer indexes to picture"),
      zoom: z.array(z.number()).length(4).optional().describe("Zoom box on the bed for the layer pictures: [x, y, w, h] mm"),
    },
    handler: async (ctx, { gcodePath, layers, zoom }) => {
      let abs: string
      try {
        abs = resolveInside(deps.projectDir(ctx.projectId), gcodePath)
      } catch {
        return fail("gcodePath must be a .gcode inside the project")
      }
      if (!/\.gcode$/i.test(abs)) return fail("gcodePath must be a .gcode inside the project")
      const sha = fileSha256(abs)
      const parsed = parseGcodeFile(abs)
      const summary = analyzeGcode(parsed, gcodePath, (parsed.settings.printstudio_intent ?? "standard") as PrintIntent)
      // Pictures: top + first, the layers asked for, else the first layer each issue points at.
      const picks: (number | "top" | "first")[] = ["top", "first", ...(layers ?? summary.issues.flatMap((i) => (i.layers?.length ? [i.layers[0]] : [])).slice(0, 2))]
      const content: ToolContent[] = [{ type: "text", text: JSON.stringify(summary, null, 2) }]
      const pictured = [...new Set(picks)]
      for (const sel of pictured) {
        const png = await layerPng(parsed, sel, zoom && typeof sel === "number" ? { zoom: zoom as [number, number, number, number] } : {})
        content.push({ type: "text", text: sel === "top" ? "Top surfaces:" : sel === "first" ? "First layer:" : `Layer ${sel + 1} (index ${sel}):` })
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" })
      }
      // Logged after the pictures were made: request_print checks this exact G-code was looked at.
      noteReviewed(ctx.projectId, sha, gcodePath, pictured, summary.issues)
      return { content }
    },
    after: (ctx, input, r) => notePreview(ctx.projectId, input.gcodePath, resultJson(r)),
  }),

  defineTool({
    name: "printer_status",
    description: "Printer state, temperatures, progress and the loaded filaments (CFS slots; check `confirmed`).",
    input: { machineId: z.string().optional().describe("Machine; default printer if omitted") },
    handler: async (_ctx, { machineId }) => {
      let status: unknown
      try {
        status = await deps.getPrinterStatus(machineId)
      } catch (e) {
        status = { error: e instanceof Error ? e.message : String(e) }
      }
      return json({ ...(status as object), loadedFilaments: getLoadedFilaments(machineId) })
    },
  }),

  defineTool({
    name: "list_machines",
    description:
      "The user's printers: name, id, bed size, nozzle, colour slots and loaded colours, live status, and which one is this project's target. Use it to design to the right limits, or to recommend a better-suited machine.",
    input: {},
    handler: async (ctx) => {
      const project = await deps.getProject(ctx.projectId)
      const target = targetMachine(project)
      const list = await machinesWithStatus()
      return json(
        list.map(({ machine: m, status }) => ({
          id: m.id,
          name: m.name,
          model: m.model,
          target: m.id === target.id,
          buildVolumeMm: m.buildVolumeMm,
          nozzleMm: m.nozzleMm,
          colourSlots: m.filamentSlots,
          loadedColours: loadedColours(m).map((f) => `${f.colorName} ${f.material} (slot ${f.slot})`),
          coloursConfirmed: m.filamentsConfirmed,
          status: status ? (status.connected ? status.state : "offline") : "unknown",
          summary: machineLine(m, status),
        })),
      )
    },
  }),

  defineTool({
    name: "read_printer_lessons",
    description:
      "What this printer has taught us from real prints (finish, fit, materials), newest last. The target machine's lessons are already summarised in your instructions; use this for the full list or another machine.",
    input: { machineId: z.string().optional().describe("Defaults to the project's target machine") },
    handler: async (ctx, { machineId }) => {
      const m = machineId ? enabledMachines().find((x) => x.id === machineId) : targetMachine(await deps.getProject(ctx.projectId))
      if (!m) return fail(`No enabled machine with id ${machineId}. See list_machines.`)
      return text(readLessons(m.id) || `No lessons recorded for ${m.name} yet.`)
    },
  }),

  defineTool({
    name: "add_printer_lesson",
    description:
      "Record one concise thing this printer taught us, with its evidence, after the user reports how a print came out. At most one or two per print; skip what's already known or one-off.",
    input: {
      lesson: z.string().describe("One line, a reusable rule: 'Plate side is the cleanest face on the textured PEI plate'"),
      evidence: z.string().describe("Where it came from: 'apple logo v3, 2026-10-08'"),
      machineId: z.string().optional().describe("Defaults to the project's target machine"),
    },
    handler: async (ctx, { lesson, evidence, machineId }) => {
      const m = machineId ? enabledMachines().find((x) => x.id === machineId) : targetMachine(await deps.getProject(ctx.projectId))
      if (!m) return fail(`No enabled machine with id ${machineId}. See list_machines.`)
      return text(`Recorded for ${m.name}: ${addLesson(m.id, m.name, lesson, evidence)}`)
    },
  }),

  defineTool({
    name: "read_print_outcomes",
    description:
      "How this project's earlier prints came out, newest first: the user's rating, problems (didn't stick, stringing, warping, ...), notes, measured vs designed sizes, fit tests (too tight / just right / too loose, with the clearance used), real vs estimated time, and lessons recorded. Read before changing fits or sizes after a print, so fixes are grounded in what was measured.",
    input: { limit: z.number().int().min(1).max(50).optional().describe("How many outcomes (default 10)") },
    handler: async (ctx, { limit }) => {
      const list = projectOutcomes(ctx.projectId).slice(0, limit ?? 10)
      if (!list.length) return text("No print outcomes recorded for this project yet (the user fills them in on the card shown after a print ends).")
      return text(list.map(describeOutcome).join("\n"))
    },
  }),

  defineTool({
    name: "set_target_machine",
    description:
      "Make another of the user's machines this project's target (its bed, nozzle and loaded colours become the design limits). Only after the user agreed to switch.",
    input: { machineId: z.string().describe("Machine id from list_machines") },
    handler: async (ctx, { machineId }) => {
      const m = enabledMachines().find((x) => x.id === machineId)
      if (!m) return fail(`No enabled machine with id ${machineId}. See list_machines.`)
      await deps.updateProject(ctx.projectId, { printer: m.id })
      emit({ type: "project.changed", projectId: ctx.projectId, paths: ["project.json"] })
      return text(`Target is now ${machineLine(m, null)}. Re-check the parts against it (check_part).`)
    },
  }),

  defineTool({
    name: "save_loaded_filaments",
    description:
      "Save the filament colours the user confirmed are loaded in the printer (up to 4 slots, in slot order), so other projects don't ask again.",
    input: {
      filaments: z
        .array(
          z.object({
            colorName: z.string().describe("Plain colour name, e.g. 'White'"),
            colorHex: z.string().describe("#rrggbb"),
            material: z.string().optional().describe("PLA unless the user said otherwise"),
          }),
        )
        .min(1)
        .max(4),
    },
    handler: async (_ctx, { filaments }) => json(confirmLoadedFilaments(filaments.map((f) => ({ ...f, material: f.material ?? "PLA" })))),
  }),

  defineTool({
    name: "printer_snapshot",
    description:
      "Take a photo with the printer's camera, plus the current printer status. Use it to look at a running or finished print (first layer, spaghetti, warping, bed clear?). Read-only.",
    input: {
      camera: z.string().optional().describe("Webcam name; defaults to the first enabled camera"),
      machineId: z.string().optional().describe("Machine; default printer if omitted"),
    },
    handler: async (_ctx, { camera, machineId }) => {
      const [status, snap] = await Promise.all([deps.getPrinterStatus(machineId), getSnapshot(camera, machineId)])
      return {
        content: [
          { type: "text", text: JSON.stringify({ camera: snap.camera, takenAt: new Date().toISOString(), status }, null, 2) },
          { type: "image", data: snap.data.toString("base64"), mimeType: snap.contentType },
        ],
      }
    },
  }),

  defineTool({
    name: "request_print",
    description:
      "Ask the user to start printing a sliced G-code file. Shows a blocking confirmation dialog in the app (with any failing checks listed) and waits for the answer. Needs the user's approval of this version of the design, a slice of it (slice_part / slice_plate), and a preview_slice look at that exact G-code first.",
    input: {
      gcodePath: z.string().describe("G-code path relative to the project root, as returned by slice_part or slice_plate (e.g. build/plate.gcode)"),
      machineId: z.string().optional().describe("Machine to print on (the one it was sliced for); the project's target if omitted"),
    },
    // Approval, guide and slice review in that order (review.ts), returning the review record the job is bound to.
    handler: async (ctx, { gcodePath, machineId }) => {
      const review = await requestPrintGate(ctx.projectId, gcodePath)
      if (review.refusal !== null) return fail(review.refusal)
      // Everything that blocks has blocked above. What's left is advice: failing checks go into the app's dialog
      // for the user to weigh; the open checklist only matters if they decline and the agent works on it.
      const failing = failingChecks(deps.projectDir(ctx.projectId))
      const last = review.record.reviews[review.record.reviews.length - 1]
      // Print the job with exactly the bytes that were reviewed (job id = review sha256); refused if they differ.
      const r = await deps.requestPrint(ctx.projectId, gcodePath, "agent", machineId, review.record.sha256)
      const result = JSON.stringify(
        {
          approved: r.approved,
          filename: r.filename ?? null,
          gcodeSha256: review.record.sha256,
          reviewedLayers: last.layersPictured,
          reviewedIssues: last.issues.map((i) => i.code),
          failingChecksShownToUser: failing,
          note: r.approved ? "The user approved; the print was uploaded and started." : "The user declined. Don't offer to print again until they ask. Ask once what to change (AskUserQuestion: e.g. the design, other settings or colours, or not now); if they pick not now or stop, end your turn.",
        },
        null,
        2,
      )
      if (r.approved) return text(result)
      return text(`${result}\n\n${formatChecklist(await doneChecklist(ctx.projectId).catch(() => []))}`)
    },
  }),

  defineTool({
    name: "update_assembly",
    description:
      "Validate and write assembly.json (multi-part builds): parts, hardware with structured specs, tools, consumables and steps. Rejects invalid input with every problem listed; returns warnings (quantity mismatches, missing purchase hints) to fix. See the assembly-guide skill.",
    input: { assembly: assemblySchema.describe("The complete assembly.json content") },
    handler: async (ctx, { assembly }) => {
      const r = await deps.writeAssembly(ctx.projectId, assembly)
      return json({ written: "assembly.json", steps: r.assembly.steps.length, warnings: r.warnings })
    },
  }),

  defineTool({
    name: "render_assembly_step",
    description:
      "Draw one guide step and return the picture (renders/assembly-step-N.png). When every part (placements) and every bought item that has a shape (hardwarePlacements) has a position, the step is drawn from geometry: earlier parts grey, new items in colour pulled back along their insertion direction, a camera chosen to show it (unless the step has a `view`), arrows typed by the step `action`, labelled callouts with part letters, hatched glue / no-glue regions and a close-up inset for small joints. Otherwise assembly.scad is rendered (the result says why). step 0 = the finished assembly. Look at it: is every new item visible, is the arrow pointing the way it goes in, are the labels on the right parts?",
    input: {
      step: z.number().int().min(0).describe("Step number (1..N), or 0 for the finished assembly"),
      explode: z.number().min(0).max(1).optional().describe("0..1, default 1 (= step.explodeDistance mm)"),
      pose: z
        .record(z.string(), z.number().min(0).max(1))
        .optional()
        .describe("Pose moving parts: {motionId: 0..1 across its range}; default = each motion's rest"),
    },
    handler: async (ctx, { step, explode, pose }) => {
      const r = await deps.renderAssemblyStep(ctx.projectId, step, { explode, pose })
      const data = (await readFile(r.path)).toString("base64")
      return {
        content: [
          { type: "text", text: JSON.stringify({ step: r.n, file: r.rel, url: r.url, cached: r.cached, ...(r.art ? { drawn: "from geometry", camera: r.art.camera.auto ? "auto" : "step view", arrows: r.art.arrows.map((x) => `${x.kind} ${x.targets.join(",")}`), labels: r.art.callouts.map((c) => `${c.letters ?? (c.qty ? `${c.qty}x` : "")} ${c.label}`.trim()), closeUp: !!r.art.closeUp } : { drawn: r.artNote ?? "assembly.scad" }) }) },
          { type: "image", data, mimeType: "image/png" },
        ],
      }
    },
  }),

  defineTool({
    name: "build_assembly_guide",
    description:
      "Render every step and write the IKEA-style guide build/assembly-guide.html (parts page with real-size hardware and store search links, one page per step, then a shopping list) plus build/shopping-list.md/.csv. Returns its URL; the app shows it in the Assembly tab.",
    input: {},
    handler: async (ctx) => {
      const r = await deps.buildAssemblyGuide(ctx.projectId)
      return json({ url: r.url, file: "build/assembly-guide.html", shoppingList: "build/shopping-list.md", steps: r.steps, rendered: r.rendered, stepPictures: r.art, ...(r.artNote ? { note: r.artNote } : {}) })
    },
  }),

  defineTool({
    name: "check_motion",
    description:
      "Check that the assembled parts fit and move: places every part (assembly.json placements) and placed hardware (hardwarePlacements, as simple shapes), sweeps each motion across its range (evenly spaced positions, then extra positions around close calls, up to a budget) with the other motions at rest, and poses pairs of motions that could meet together at the ends of their ranges. Reports status ok / problems / incomplete, parts overlapping at rest, collisions (which parts, at which angle/distance), the smallest gap and where, how many positions were checked and what was included. Missing placements, parts that fail to load or aren't closed solids make it incomplete (not ok). It finds collisions only in the positions it checks; it does not check strength, friction or spring force. Run after geometry changes whenever the design has motions; fix every collision before showing the user, and describe the result with its scope (\"no collisions found in 24 positions from 0° to 110°\"), never \"moves freely\".",
    input: {},
    handler: async (ctx) => {
      // Persisted with the assembly stamp it was checked against (build/motion-check.json): the done checklist and
      // the Moves panel read its freshness from there.
      const r = await deps.checkAssemblyMotion(ctx.projectId)
      // The summary leads with OK / PROBLEMS / INCOMPLETE; samples are long, so the JSON leaves them out.
      const brief = { ...r, summary: undefined, motions: r.motions.map((m) => ({ ...m, samples: undefined })) }
      return text(`${r.summary}\n\n${JSON.stringify(brief, null, 2)}`)
    },
  }),

  // R22: read-only comparison of two ideas or saved versions (server/projects/compare.ts). Builds copies of both
  // versions under build/compare/; never changes the design, the open idea or the chat.
  defineTool({
    name: "compare_ideas",
    description:
      "Compare two of this project's ideas (\"Try another idea\" branches) or saved versions, read-only: overall size, each part's size, parts added/removed, Customizer settings that differ, filament grams, print time (adjusted by this printer's real print times), cost of filament + things to buy, shopping-list differences, and the plan/asks/changes only one side has. Use it to answer \"which is better for …?\" or \"what changed?\" with facts, then explain in plain words. a/b: an idea's name or id, a version id, or \"current\" (the open files). Leave both out to compare the open idea with the most recently changed other idea; with only one idea it lists recent versions to pick from. Doesn't switch ideas — the user does that in the app.",
    input: {
      a: z.string().optional().describe("First side: idea name or id, version id (commit), or \"current\" (default)"),
      b: z.string().optional().describe("Second side (default: the most recently changed other idea)"),
    },
    handler: async (ctx, { a, b }) => {
      const list = await listIdeas(ctx.projectId)
      const pick = (r: string | undefined) => {
        if (!r) return undefined
        const byName = list.ideas.find((i) => i.name.toLowerCase() === r.trim().toLowerCase())
        return byName ? (byName.current ? "current" : byName.branch) : r.trim()
      }
      const others = list.ideas.filter((i) => !i.current).sort((x, y) => y.tip.date.localeCompare(x.tip.date))
      const A = pick(a) ?? "current"
      const B = pick(b) ?? (others[0]?.branch as string | undefined)
      const ideas = list.ideas.map((i) => `- ${i.name} (id ${i.branch}${i.current ? ", open now" : ""}): newest version ${i.tip.short} “${i.tip.message}” ${i.tip.date.slice(0, 16).replace("T", " ")}`)
      if (!B) {
        const { checkpoints } = await listCheckpoints(ctx.projectId, 15)
        return text(
          ["There's only one idea so far. Ideas:", ...ideas, "", "Recent versions of it (pass an id as a or b):", ...checkpoints.map((c) => `- ${c.short} “${c.message}” ${c.date.slice(0, 16).replace("T", " ")}`)].join("\n"),
        )
      }
      const c = await compareIdeas(ctx.projectId, A, B)
      return text(`${describeComparison(c)}\n\nIdeas in this project:\n${ideas.join("\n")}`)
    },
  }),
] as const satisfies readonly ToolDef[]

export type StudioToolName = (typeof STUDIO_TOOLS)[number]["name"]
