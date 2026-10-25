// OWNER: slicer/printer agent. Simulated Klipper/Moonraker printer: the dev mock (tools/mock-moonraker.ts)
// and the in-app "Practice printer" (server/printer/practice.ts).
// Response shapes follow the Moonraker docs (https://moonraker.readthedocs.io/en/latest/web_api/):
// every endpoint wraps its payload in {result: ...} except POST /server/files/upload, and errors are
// {error: {code, message}}. Start -> heat to target -> ~60 s of progress -> complete.
import Fastify from "fastify"
import multipart from "@fastify/multipart"
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { deflateSync, crc32 } from "node:zlib"
import { basename, join } from "node:path"

export interface SimPrinterOptions {
  printSeconds?: number // simulated print length after heating (default 60)
  hostname?: string // reported by /printer/info (a hostname containing "mock" marks PrinterStatus.isMock)
  log?: (msg: string) => void
  /**
   * Creality CFS unit T1 slots A–D as "RRGGBB:materialcode" or "none" (comma-separated), like the SPARKX i7 reports
   * them. null = no CFS (no `box` object). Default: white, black, blue, red PLA. Like the real firmware, starting a
   * file that selects an unset slot cancels it at once and resets to standby.
   */
  cfs?: string | null
  cancelAtStart?: boolean // test hook: firmware cancels every print at 0 s (as with an unset CFS slot)
  /**
   * Creality-style START_PRINT: for this long after start (and until heated) print_stats stays "standby" with the
   * file loaded (virtual_sdcard.is_active) while it homes, loads, flushes and cleans; console lines go to
   * /server/gcode_store. 0 = start printing at once (plain Klipper). Default 8.
   */
  prepSeconds?: number
  /**
   * Emulate Creality firmware (SPARKX i7 fw 1.1.5.x): print_stats stays frozen at "standby" / 0 s for the whole
   * job; the truth is in virtual_sdcard (is_active, layer/layer_count), idle_timeout and pause_resume, and in
   * Creality's own websocket (`crealityWsPort`, normally 9999) which pushes deviceState/layer/printLeftTime JSON.
   */
  creality?: boolean
  crealityWsPort?: number
  restartSeconds?: number // how long FIRMWARE_RESTART stays in "startup" (default 1.5)
}

/** What the SPARKX i7 reported as /printer/info state_message after its 2026-10-16 shutdown. */
export const SPARKX_SHUTDOWN =
  '{"code":"key1", "msg":"Exception in flush_handler\\nOnce the underlying issue is corrected, use the\\n\'FIRMWARE_RESTART\' command to reset the firmware, reload the\\nconfig, and restart the host software.\\nPrinter is shutdown\\n"}'

/** A fake Moonraker as a Fastify app (not listening yet). */
export async function createSimPrinter(opts: SimPrinterOptions = {}) {
  const PRINT_SECONDS = opts.printSeconds ?? 60
  const CFS: { color: string; code: string }[] | null =
    opts.cfs === null
      ? null
      : (opts.cfs ?? "FFFFFF:001001,000000:001001,1743ED:001001,BE1C1C:001001").split(",").map((e) => {
          const [color, code] = e.trim().split(":")
          return !color || color === "none" ? { color: "none", code: "none" } : { color: `0${color.toUpperCase()}`, code: code || "001001" }
        })
  const history: { job_id: string; filename: string; status: string; start_time: number; end_time: number | null; print_duration: number; total_duration: number; filament_used: number; exists: boolean }[] = []
  const now = () => Date.now() / 1000
  const HOSTNAME = opts.hostname ?? "mock-moonraker"
  const log = opts.log ?? (() => {})
  const AMBIENT = 24
  const gcodesDir = mkdtempSync(join(tmpdir(), "printstudio-sim-gcodes-"))

  type PrintState = "standby" | "printing" | "paused" | "complete" | "cancelled" | "error"
  const s = {
    state: "standby" as PrintState,
    filename: "",
    message: "",
    totalDuration: 0, // since start, incl. heating + pauses
    printDuration: 0, // actively printing
    progress: 0,
    filamentUsed: 0,
    extruder: { temperature: AMBIENT, target: 0 },
    bed: { temperature: AMBIENT, target: 0 },
    displayMessage: null as string | null,
    prepping: false, // Creality START_PRINT running (print_stats still "standby")
    prepElapsed: 0,
    // the running file: size, where START_PRINT ends and where the first layer starts (virtual_sdcard.file_position)
    file: { size: 0, afterStart: 0, firstLayer: 0 },
  }
  // Klipper's own state. POST /debug/shutdown puts it in "shutdown" like the SPARKX i7 after a firmware fault;
  // POST /printer/firmware_restart brings it back ("startup" for a moment, then "ready").
  const klippy = { state: "ready" as "ready" | "startup" | "shutdown" | "error", message: "Printer is ready" }
  const RESTART_SECONDS = opts.restartSeconds ?? 1.5
  const PREP_SECONDS = opts.prepSeconds ?? 8
  const gcodeStore: { message: string; time: number; type: "command" | "response" }[] = []
  const say = (message: string, type: "command" | "response" = "response") => {
    gcodeStore.push({ message, time: Date.now() / 1000, type })
    if (gcodeStore.length > 200) gcodeStore.shift()
  }
  // What the i7 prints to its console during START_PRINT, at fractions of the prep time.
  const PREP_SCRIPT: [number, string][] = [
    [0.05, "// multicolor_method"],
    [0.1, "// Z-IF_HOME: Z is normal (6.01), using standard approach"],
    [0.3, "// bed_mesh: Unknown profile [default]"],
    [0.45, '!! {"macro": "BOX_LOAD_MATERIAL"}'],
    [0.6, "// flush_temp: 220"],
    [0.7, '!! {"macro": "BOX_LOAD_MATERIAL_MATERIAL_FLUSH"}'],
    [0.85, "// nozzle_clean clean_velocity :24000"],
  ]

  function parseTargets(file: string): { ext: number; bed: number } {
    // Pull temps from START_PRINT / M104 / M140 in the uploaded gcode if we can; else PLA defaults.
    let ext = 220
    let bed = 55
    try {
      const head = readFileSync(join(gcodesDir, file), "utf8").slice(0, 200_000)
      const sp = head.match(/START_PRINT[^\n]*EXTRUDER_TEMP=(\d+)[^\n]*BED_TEMP=(\d+)/)
      if (sp) return { ext: Number(sp[1]), bed: Number(sp[2]) }
      const e = head.match(/^M10[49] S(\d+)/m)
      const b = head.match(/^M1[49]0 S(\d+)/m)
      if (e && Number(e[1]) > 0) ext = Number(e[1])
      if (b && Number(b[1]) > 0) bed = Number(b[1])
    } catch {
      /* defaults */
    }
    return { ext, bed }
  }

  const TICK = 0.5
  const timer = setInterval(() => {
    // Heaters approach target (or ambient) exponentially.
    for (const h of [s.extruder, s.bed]) {
      const goal = h.target > 0 ? h.target : AMBIENT
      const rate = h === s.extruder ? 0.25 : 0.15
      h.temperature += (goal - h.temperature) * rate
      if (Math.abs(goal - h.temperature) < 0.3) h.temperature = goal
    }
    if (klippy.state !== "ready") return // a shut-down printer does nothing
    if (s.prepping) {
      const before = s.prepElapsed / PREP_SECONDS
      s.prepElapsed += TICK
      const now = s.prepElapsed / PREP_SECONDS
      for (const [at, line] of PREP_SCRIPT) if (at > before && at <= now) say(line)
      const hot = Math.abs(s.extruder.temperature - s.extruder.target) < 2 && Math.abs(s.bed.temperature - s.bed.target) < 2
      if (s.prepElapsed >= PREP_SECONDS && hot) {
        s.prepping = false
        s.state = "printing"
        say("// print preparing done")
      }
      return
    }
    if (s.state !== "printing" && s.state !== "paused") return
    s.totalDuration += TICK
    if (s.state !== "printing") return
    const heated = Math.abs(s.extruder.temperature - s.extruder.target) < 2 && Math.abs(s.bed.temperature - s.bed.target) < 2
    if (!heated) {
      s.displayMessage = "Heating..."
      return
    }
    s.displayMessage = null
    s.printDuration += TICK
    s.progress = Math.min(1, s.printDuration / PRINT_SECONDS)
    s.filamentUsed = s.progress * 1200
    if (s.progress >= 1) {
      s.state = "complete"
      s.extruder.target = 0
      s.bed.target = 0
      endJob("completed")
      log(`[mock] print complete: ${s.filename}`)
      if (opts.creality) {
        // What the i7 logs on a normal finish (the CANCEL_PRINT line is part of END_PRINT, not a cancel).
        say("// CANCEL_PRINT trigger ENABLE_PRESSURE_ADVANCE=1")
        say("// Pressure advance enabled")
        say("// END_PRINT: Saving Z position 73.00")
        say("Done printing file")
        s.progress = 1.0219 // file_position runs past file_size on the i7
      }
      crealityForget(true)
    }
  }, TICK * 1000)

  const r1 = (n: number) => Math.round(n * 100) / 100

  /** `box` as the SPARKX i7 firmware reports it (one CFS unit T1, slots A–D). */
  function cfsBox(slots: { color: string; code: string }[]) {
    const absent = { state: "None", filament: "None", temperature: "None", dry_and_humidity: "None", filament_detected: "None", version: "-1", sn: "-1", mode: "-1" }
    const map = Object.fromEntries(["T1", "T2", "T3", "T4"].flatMap((t) => ["A", "B", "C", "D"].map((l) => [`${t}${l}`, `${t}${l}`])))
    return {
      filament: 0,
      state: "connect",
      type: "CFS-lite",
      auto_refill: 1,
      enable: 1,
      filament_useup: 1,
      map,
      same_material: slots
        .map((x, i) => (x.code === "none" ? null : [x.code, x.color, [`T1${"ABCD"[i]}`], x.code === "001001" ? "PLA" : "unknown"]))
        .filter(Boolean),
      T1: {
        state: "connect",
        filament: "None",
        temperature: "24",
        dry_and_humidity: "40",
        filament_detected: "None",
        version: "0.5.4",
        sn: "MOCKCFS0001",
        mode: "0",
        vender: slots.map(() => "unknown"),
        remain_len: slots.map(() => "666666"),
        color_value: slots.map((x) => x.color),
        material_type: slots.map((x) => x.code),
      },
      T2: absent,
      T3: absent,
      T4: absent,
    }
  }

  /** Slots (1-based) a G-code file selects (T<n>, M8200 P S<n>). */
  function slotsUsed(file: string): number[] {
    try {
      const text = readFileSync(join(gcodesDir, file), "utf8")
      return [...new Set([...text.matchAll(/^(?:T(\d+)|M8200 (?:P S|L I)(\d+))\b/gm)].map((m) => Number(m[1] ?? m[2]) + 1))]
    } catch {
      return []
    }
  }

  function endJob(status: string) {
    const j = history[0]
    if (j && j.status === "in_progress") Object.assign(j, { status, end_time: now(), print_duration: s.printDuration, total_duration: s.totalDuration })
  }

  const layerNow = () => (s.state === "printing" || s.state === "paused" || s.state === "complete" ? Math.max(1, Math.round(s.progress * 100)) : 0)

  /**
   * Creality firmware: after a job the printer drops back to standby. After a finish it keeps print_stats.filename
   * and virtual_sdcard progress ≥ 1; after a cancel it forgets the file.
   */
  function crealityForget(finished = false) {
    if (!opts.creality) return
    setTimeout(() => Object.assign(s, finished ? { state: "standby" } : { state: "standby", filename: "", progress: 0 }), 2500)
  }

  function objectStatus(): Record<string, Record<string, unknown>> {
    return {
      print_stats: opts.creality
        ? {
            filename: s.filename,
            total_duration: 0,
            print_duration: 0,
            filament_used: 0,
            state: "standby",
            message: "",
            info: { total_layer: null, current_layer: null },
            power_loss: 0,
            z_pos: 3,
          }
        : {
            filename: s.filename,
            total_duration: r1(s.totalDuration),
            print_duration: r1(s.printDuration),
            filament_used: r1(s.filamentUsed),
            state: s.state,
            message: s.message,
            info: { total_layer: 100, current_layer: Math.floor(s.progress * 100) },
          },
      idle_timeout: {
        state: s.state === "printing" || s.prepping ? "Printing" : "Ready",
        printing_time: r1(s.totalDuration),
      },
      pause_resume: { is_paused: s.state === "paused", resume_err: false, sd_paused: !!opts.creality, pause_command_sent: false },
      extruder: {
        temperature: r1(s.extruder.temperature),
        target: s.extruder.target,
        power: s.extruder.target > 0 ? 0.4 : 0,
        can_extrude: s.extruder.temperature > 170,
        pressure_advance: 0.04,
        smooth_time: 0.04,
      },
      heater_bed: { temperature: r1(s.bed.temperature), target: s.bed.target, power: s.bed.target > 0 ? 0.3 : 0 },
      display_status: { progress: r1(s.progress), message: s.displayMessage },
      virtual_sdcard: {
        file_path: s.filename ? join(gcodesDir, s.filename) : null,
        progress: r1(s.progress),
        is_active: s.state === "printing" || s.prepping,
        file_position: filePosition(),
        file_size: s.filename ? s.file.size : 0,
        ...(opts.creality ? { layer: layerNow(), layer_count: s.filename ? 100 : 0 } : {}),
      },
      webhooks: { state: klippy.state, state_message: klippy.message },
      // Guess at how a Creality CFS unit might appear (custom Klipper object). Verify on the real i7.
      ...(CFS ? { box: cfsBox(CFS) } : {}),
      bed_mesh: { profile_name: "default", mesh_min: [5, 5], mesh_max: [255, 255] },
      configfile: {
        settings: {
          "gcode_macro start_print": {
            gcode: "\n{% set bed_temp = params.BED_TEMP|default(55)|float %}\n{% set extruder_temp = params.EXTRUDER_TEMP|default(220)|float %}\nM140 S{bed_temp}\nG28\nBED_MESH_CALIBRATE\nM109 S{extruder_temp}\n",
          },
          "gcode_macro end_print": { gcode: "\nTURN_OFF_HEATERS\nG91\nG1 Z5\nG90\nM84\n" },
          bed_mesh: { mesh_min: "5,5", mesh_max: "255,255", probe_count: "5,5" },
          virtual_sdcard: { path: "/home/pi/printer_data/gcodes" },
        },
      },
    }
  }

  const app = Fastify({ logger: false })
  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } })

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/printer/objects/query") && !req.url.startsWith("/webcam/")) log(`[mock] ${req.method} ${req.url}`)
  })

  const klippyError = (reply: { status: (n: number) => { send: (b: unknown) => unknown } }, code: number, message: string) =>
    reply.status(code).send({ error: { code, message, traceback: "" } })

  app.get("/server/info", async () => ({
    result: {
      klippy_connected: true,
      klippy_state: klippy.state,
      components: ["file_manager", "webcam", "history"],
      failed_components: [],
      registered_directories: ["config", "logs", "gcodes"],
      warnings: [],
      websocket_count: 0,
      moonraker_version: "v0.9.3-mock",
      api_version: [1, 5, 0],
      api_version_string: "1.5.0",
    },
  }))

  app.get("/printer/info", async () => ({
    result: {
      state: klippy.state,
      state_message: klippy.message,
      hostname: HOSTNAME,
      software_version: "v0.12.0-mock",
      cpu_info: "mock cpu",
      klipper_path: "/home/pi/klipper",
      python_path: "/home/pi/klippy-env/bin/python",
      log_file: "/tmp/klippy.log",
      config_file: "/home/pi/printer_data/config/printer.cfg",
    },
  }))

  /** Moonraker's answer to a print command while Klipper is shut down (as the SPARKX i7 sent it, 2026-10-16). */
  const notReady = (reply: Parameters<typeof klippyError>[0]) =>
    klippyError(reply, 400, `{'error': 'WebRequestError', 'message': '${klippy.message}'}`)

  /** Klipper shuts itself down: the print (if any) ends in error, heaters off, nothing moves until a restart. */
  function shutdown(message = SPARKX_SHUTDOWN) {
    Object.assign(klippy, { state: "shutdown", message })
    if (s.state === "printing" || s.state === "paused" || s.prepping) {
      endJob("klippy_shutdown")
      Object.assign(s, { state: "error", message: "Klipper shutdown", prepping: false })
    }
    s.extruder.target = 0
    s.bed.target = 0
    say("!! Exception in flush_handler")
    log("[mock] klipper shutdown")
  }

  // Dev/test hook: put the printer in Klipper's "shutdown" state (body {message?} replaces the firmware text).
  app.post("/debug/shutdown", async (req) => {
    const body = (req.body ?? {}) as { message?: unknown }
    shutdown(typeof body.message === "string" ? body.message : undefined)
    return { result: "ok" }
  })

  // Moves and heats nothing: Klipper restarts, the job is gone, the printer comes back ready.
  app.post("/printer/firmware_restart", async () => {
    Object.assign(klippy, { state: "startup", message: "Printer is restarting" })
    Object.assign(s, { state: "standby", filename: "", message: "", progress: 0, prepping: false, displayMessage: null })
    log("[mock] FIRMWARE_RESTART")
    setTimeout(() => {
      if (klippy.state === "startup") Object.assign(klippy, { state: "ready", message: "Printer is ready" })
    }, RESTART_SECONDS * 1000)
    return { result: "ok" }
  })

  app.get("/printer/objects/list", async () => ({ result: { objects: Object.keys(objectStatus()) } }))

  app.get("/printer/objects/query", async (req) => {
    // Query string is `?print_stats&extruder=temperature,target`; empty value => all attributes.
    const q = req.query as Record<string, string>
    const all = objectStatus()
    const status: Record<string, Record<string, unknown>> = {}
    for (const [obj, attrs] of Object.entries(q)) {
      if (!all[obj]) continue
      if (!attrs) status[obj] = all[obj]
      else status[obj] = Object.fromEntries(attrs.split(",").filter((a) => a in all[obj]).map((a) => [a, all[obj][a]]))
    }
    return { result: { eventtime: process.uptime(), status } }
  })

  app.post("/server/files/upload", async (req, reply) => {
    let fileName: string | null = null
    let root = "gcodes"
    let subPath = ""
    let print = false
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer()
        fileName = basename(part.filename)
        writeFileSync(join(gcodesDir, fileName), buf)
        log(`[mock]   stored ${fileName} (${buf.length} bytes) in ${gcodesDir}`)
      } else {
        const v = String(part.value)
        if (part.fieldname === "root") root = v
        if (part.fieldname === "path") subPath = v
        if (part.fieldname === "print") print = v === "true"
      }
    }
    if (!fileName) return klippyError(reply, 400, "No file name specified in upload form")
    if (root !== "gcodes") return klippyError(reply, 400, `Invalid root request: ${root}`)
    let printStarted = false
    if (print && s.state !== "printing" && s.state !== "paused") {
      startPrint(fileName)
      printStarted = true
    }
    // Note: upload responses are NOT wrapped in {result} (per Moonraker docs).
    return reply.status(201).send({
      item: { path: subPath ? `${subPath}/${fileName}` : fileName, root },
      print_started: printStarted,
      print_queued: false,
      action: "create_file",
    })
  })

  app.get("/server/files/list", async () => ({
    result: readdirSync(gcodesDir).map((f) => {
      const st = statSync(join(gcodesDir, f))
      return { path: f, modified: st.mtimeMs / 1000, size: st.size, permissions: "rw" }
    }),
  }))

  function fileLayout(filename: string) {
    try {
      const buf = readFileSync(join(gcodesDir, filename))
      const text = buf.subarray(0, 4 * 1024 * 1024).toString("latin1")
      const sp = /^(START_PRINT|PRINT_START)\b.*$/m.exec(text)
      const fl = /^(;LAYER_CHANGE|;LAYER:0\b)/m.exec(text)
      const afterStart = sp ? sp.index + sp[0].length + 1 : 0
      return { size: buf.length, afterStart, firstLayer: fl ? fl.index : afterStart }
    } catch {
      return { size: 0, afterStart: 0, firstLayer: 0 }
    }
  }
  /** Klipper's file_position: stays just after START_PRINT while it runs (and while heating), then follows progress. */
  const filePosition = () => {
    const f = s.file
    if (!s.filename || !f.size) return 0
    if (s.prepping || (s.state === "printing" && s.progress === 0)) return f.afterStart
    return Math.round(f.firstLayer + s.progress * (f.size - f.firstLayer))
  }

  function startPrint(filename: string) {
    const t = parseTargets(filename)
    s.file = fileLayout(filename)
    Object.assign(s, { state: PREP_SECONDS > 0 ? "standby" : "printing", filename, message: "", totalDuration: 0, printDuration: 0, progress: 0, filamentUsed: 0 })
    s.prepping = PREP_SECONDS > 0
    s.prepElapsed = 0
    say(`SDCARD_PRINT_FILE FILENAME="${filename}"`, "command")
    say(`File opened:${filename} Size:0`)
    say("File selected")
    s.extruder.target = t.ext
    s.bed.target = t.bed
    // Creality firmware: prints started like ours never get a Moonraker history entry.
    if (!opts.creality) history.unshift({ job_id: String(history.length).padStart(6, "0"), filename, status: "in_progress", start_time: now(), end_time: null, print_duration: 0, total_duration: 0, filament_used: 0, exists: true })
    log(`[mock] print started: ${filename} (heating to ${t.ext}/${t.bed})`)
    // Creality firmware: a used CFS slot with no material set -> cancelled at 0 s, then straight back to standby.
    const unset = CFS ? slotsUsed(filename).filter((n) => !CFS[n - 1] || CFS[n - 1].code === "none") : []
    if (unset.length || opts.cancelAtStart) {
      setTimeout(() => {
        s.prepping = false
        s.state = "cancelled"
        s.extruder.target = 0
        s.bed.target = 0
        endJob("cancelled")
        say("// start CANCEL_PRINT")
        say("// CANCEL_PRINT success")
        log(`[mock] firmware cancelled ${filename}: slot ${unset.join(",")} not set`)
        setTimeout(() => Object.assign(s, { state: "standby", filename: "", message: "", progress: 0 }), 1500)
      }, 1000)
    }
  }

  app.post("/printer/print/start", async (req, reply) => {
    if (klippy.state !== "ready") return notReady(reply)
    const filename = (req.query as Record<string, string>).filename
    if (!filename) return klippyError(reply, 400, "No data for argument: filename")
    if (s.state === "printing" || s.state === "paused" || s.prepping) return klippyError(reply, 400, "Print is already in progress")
    if (!existsSync(join(gcodesDir, filename))) return klippyError(reply, 404, `File ${filename} does not exist`)
    startPrint(filename)
    return { result: "ok" }
  })

  app.post("/printer/print/pause", async (_req, reply) => {
    if (klippy.state !== "ready") return notReady(reply)
    if (s.state !== "printing") return klippyError(reply, 400, "Print is not in progress")
    s.state = "paused"
    return { result: "ok" }
  })

  app.post("/printer/print/resume", async (_req, reply) => {
    if (klippy.state !== "ready") return notReady(reply)
    if (s.state !== "paused") return klippyError(reply, 400, "Print is not paused")
    s.state = "printing"
    return { result: "ok" }
  })

  app.post("/printer/print/cancel", async (_req, reply) => {
    if (klippy.state !== "ready") return notReady(reply)
    if (s.state !== "printing" && s.state !== "paused" && !s.prepping) return klippyError(reply, 400, "No print in progress")
    s.prepping = false
    s.state = "cancelled"
    s.extruder.target = 0
    s.bed.target = 0
    endJob("cancelled")
    say("// CANCEL_PRINT trigger ENABLE_PRESSURE_ADVANCE=1")
    say("// start CANCEL_PRINT")
    say("// CANCEL_PRINT success")
    crealityForget()
    return { result: "ok" }
  })

  app.get("/server/gcode_store", async (req) => {
    const count = Number((req.query as Record<string, string>).count) || 100
    return { result: { gcode_store: gcodeStore.slice(-count) } }
  })

  app.get("/server/history/list", async (req) => {
    const limit = Number((req.query as Record<string, string>).limit) || 50
    return { result: { count: history.length, jobs: history.slice(0, limit) } }
  })

  app.get("/server/files/roots", async () => ({
    result: [
      { name: "config", path: "/home/pi/printer_data/config", permissions: "rw" },
      { name: "logs", path: "/home/pi/printer_data/logs", permissions: "r" },
      { name: "gcodes", path: gcodesDir, permissions: "rw" },
    ],
  }))

  app.delete<{ Params: { "*": string } }>("/server/files/gcodes/*", async (req, reply) => {
    const name = basename(req.params["*"])
    const f = join(gcodesDir, name)
    if (!existsSync(f)) return klippyError(reply, 404, `File does not exist: gcodes/${name}`)
    unlinkSync(f)
    return { result: { item: { path: name, root: "gcodes" }, action: "delete_file" } }
  })

  app.get("/machine/system_info", async () => ({
    result: { system_info: { distribution: { name: "mock", id: "mock" }, cpu_info: { model: "mock" } } },
  }))

  app.get("/server/webcams/list", async () => ({
    result: {
      webcams: [
        {
          name: "mock-cam",
          location: "printer",
          service: "mjpegstreamer-adaptive",
          enabled: true,
          icon: "mdiWebcam",
          target_fps: 15,
          target_fps_idle: 5,
          // Relative URLs, like a real install: relative to the web frontend host (nginx :80/:4408).
          stream_url: "/webcam/?action=stream",
          snapshot_url: "/webcam/?action=snapshot",
          flip_horizontal: false,
          flip_vertical: false,
          rotation: 0,
          aspect_ratio: "4:3",
          extra_data: {},
          source: "database",
          uid: "00000000-0000-4000-8000-000000000001",
        },
      ],
    },
  }))

  // ---- fake camera: a generated PNG showing the bed, the part growing with progress, and a state bar
  function png(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
    const raw = Buffer.alloc((w * 3 + 1) * h)
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 0
      for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 3 + 1) + 1 + x * 3)
    }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      const td = Buffer.concat([Buffer.from(type), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(td))
      return Buffer.concat([len, td, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(w, 0)
    ihdr.writeUInt32BE(h, 4)
    ihdr[8] = 8
    ihdr[9] = 2
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  }

  function snapshot(): Buffer {
    const W = 320
    const H = 240
    const partH = Math.round(80 * s.progress)
    const stateColor: Record<PrintState, [number, number, number]> = {
      standby: [120, 120, 120],
      printing: [40, 170, 80],
      paused: [230, 170, 30],
      complete: [60, 120, 230],
      cancelled: [200, 60, 60],
      error: [200, 60, 60],
    }
    // Mid-grey scene (an enclosure in daylight), so the picture sits equally well on a light or a dark page.
    return png(W, H, (x, y) => {
      if (y < 12) return x < W * s.progress ? stateColor[s.state] : [96, 98, 102] // progress bar
      if (y > 190 && y < 205 && x > 30 && x < 290) return [62, 64, 70] // bed
      if (y <= 190 && y > 190 - partH && x > 135 && x < 185) return [244, 244, 240] // part (white PLA)
      const hot = s.extruder.temperature > 150
      if (y > 190 - partH - 30 && y <= 190 - partH - 10 && x > 150 && x < 170) return hot ? [230, 90, 40] : [88, 90, 96] // nozzle
      return [150 - (y >> 4), 153 - (y >> 4), 158 - (y >> 4)]
    })
  }

  app.get("/webcam/", async (req, reply) => {
    const action = (req.query as Record<string, string>).action
    if (action !== "snapshot") return reply.status(400).send("mock camera only supports ?action=snapshot")
    return reply.type("image/png").header("cache-control", "no-store").send(snapshot())
  })

  app.addHook("onClose", async () => clearInterval(timer))
  // Creality's own websocket API (listen-only clients get a JSON push every second).
  const crealityReceived: Record<string, unknown>[] = [] // :9999 "set" params received (tests)
  if (opts.crealityWsPort) {
    const wsApp = Fastify({ logger: false })
    const { default: websocket } = await import("@fastify/websocket")
    await wsApp.register(websocket)
    wsApp.get("/", { websocket: true }, (socket) => {
      const push = () => {
        const active = s.state === "printing" || s.state === "paused" || s.prepping
        socket.send(
          JSON.stringify({
            // Real i7: deviceState/state are 1 while printing AND still 1 after a finished print (file kept).
            deviceState: active || s.filename ? 1 : 0,
            state: active || s.filename ? 1 : 0,
            layer: layerNow(),
            TotalLayer: s.filename ? 100 : 0,
            printProgress: Math.round(s.progress * 100),
            printLeftTime: s.state === "printing" || s.state === "paused" ? Math.round(PRINT_SECONDS * (1 - s.progress)) : 0,
            printJobTime: Math.round(s.printDuration),
            printFileName: s.filename ? join("/mnt/UDISK/printer_data/gcodes", s.filename) : "",
            nozzleTemp: s.extruder.temperature.toFixed(6),
            targetNozzleTemp: s.extruder.target,
            bedTemp0: s.bed.temperature.toFixed(6),
            targetBedTemp0: s.bed.target,
            err: { errcode: 0, key: 0, value: "", retry: 0 },
          }),
        )
      }
      // Starting a job the Creality way (what Crease's experimental "Start prints through Creality's own
      // service" sends; shapes from OrcaSlicer's CrealityPrint.cpp, unverified on hardware).
      socket.on("message", (raw: Buffer) => {
        let j: { method?: string; params?: Record<string, unknown> }
        try {
          j = JSON.parse(String(raw))
        } catch {
          return
        }
        if (j.method !== "set" || !j.params) return
        const p = j.params
        crealityReceived.push(p)
        const file = typeof p.opGcodeFile === "string" ? p.opGcodeFile.replace(/^printprt:/, "") : (p.multiColorPrint as { gcode?: string } | undefined)?.gcode
        if (file) {
          const name = basename(file)
          if (s.state === "printing" || s.state === "paused" || s.prepping) return socket.send(JSON.stringify({ ret: 1, err: "busy" }))
          if (!existsSync(join(gcodesDir, name))) return socket.send(JSON.stringify({ ret: 1, err: `no file ${name}` }))
          startPrint(name)
          socket.send(JSON.stringify({ ret: 0 }))
        }
      })
      push()
      const t = setInterval(push, 1000)
      socket.on("close", () => clearInterval(t))
    })
    await wsApp.listen({ port: opts.crealityWsPort, host: "127.0.0.1" })
    app.addHook("onClose", async () => wsApp.close())
  }

  return { app, gcodesDir, crealityReceived }
}
