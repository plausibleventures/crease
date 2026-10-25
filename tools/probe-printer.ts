// Read-only probe of a Klipper/Moonraker printer (target: Creality SPARKX i7). Writes a markdown report.
//
//   npx tsx tools/probe-printer.ts <host> [port] [--allow-upload] [--out file.md]
//
// It never starts, pauses or cancels a print, and never sends G-code. With --allow-upload it uploads a
// tiny comment-only file (no moves, no heating) to the gcodes root, checks it is listed, then deletes it.
//
// Ports checked (Creality K-series / i7 conventions; verify on the device):
//   7125 Moonraker API · 4408 Fluidd · 4409 Mainsail · 80 web/nginx (Creality file upload on stock FW)
//   9999 Creality's own WebSocket API (stock FW) · 8000 Creality WebRTC camera signalling · 8080 mjpg-streamer
import { connect } from "node:net"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const outIdx = args.indexOf("--out")
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out")
const host = positional[0]
const userPort = positional[1] ? Number(positional[1]) : null
if (!host) {
  console.error("usage: npx tsx tools/probe-printer.ts <host> [port] [--allow-upload] [--out report.md]")
  process.exit(2)
}
const allowUpload = flags.has("--allow-upload")
const outFile =
  outIdx >= 0
    ? args[outIdx + 1]
    : join(dirname(fileURLToPath(import.meta.url)), "..", "docs", `printer-probe-${host.replace(/[^\w.-]+/g, "_")}${userPort && userPort !== 7125 ? `-${userPort}` : ""}.md`)

const KNOWN_PORTS: [number, string][] = [
  [7125, "Moonraker API"],
  [4408, "Fluidd (Creality)"],
  [4409, "Mainsail (Creality helper script)"],
  [80, "HTTP / nginx / Creality upload"],
  [9999, "Creality WebSocket API (stock firmware)"],
  [8000, "Creality WebRTC camera signalling"],
  [8080, "mjpg-streamer camera"],
]
// Standard Klipper object names; anything else in /printer/objects/list is worth a look (CFS etc).
const STANDARD_OBJECT = /^(gcode_move|toolhead|extruder\d*|heater_bed|heaters|fan|heater_fan .*|controller_fan .*|fan_generic .*|temperature_sensor .*|temperature_fan .*|print_stats|virtual_sdcard|display_status|pause_resume|webhooks|configfile|idle_timeout|motion_report|query_endstops|system_stats|bed_mesh|probe|stepper_enable|gcode_macro .*|gcode_button .*|output_pin .*|filament_switch_sensor .*|filament_motion_sensor .*|tmc\d+ .*|mcu.*|exclude_object|firmware_retraction|manual_probe|bed_screws|screws_tilt_adjust|z_tilt|quad_gantry_level|input_shaper|save_variables|gcode|led .*|neopixel .*|servo .*|respond|homing_override|safe_z_home|adxl345.*|resonance_tester|skew_correction|z_thermal_adjust .*|heater_generic .*|endstop_phase.*|verify_heater .*|bltouch|smart_effector|axis_twist_compensation|dual_carriage|palette2|angle .*)$/

const lines: string[] = []
const md = (s = "") => {
  lines.push(s)
  console.log(s)
}
const code = (v: unknown, max = 4000) => {
  let t = typeof v === "string" ? v : JSON.stringify(v, null, 2)
  if (t.length > max) t = t.slice(0, max) + `\n… (${t.length - max} more chars)`
  md("```")
  md(t)
  md("```")
}

function tcpOpen(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

interface HttpResult {
  ok: boolean
  status: number
  type: string
  json: unknown
  text: string
  error?: string
  bytes: number
}
async function http(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<HttpResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const type = res.headers.get("content-type") ?? ""
    const buf = Buffer.from(await res.arrayBuffer())
    const text = type.startsWith("image/") ? "" : buf.toString("utf8")
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* not json */
    }
    return { ok: res.ok, status: res.status, type, json, text, bytes: buf.length }
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } }
    return { ok: false, status: 0, type: "", json: null, text: "", bytes: 0, error: err.cause?.code ?? err.message }
  }
}
const result = (r: HttpResult) => (r.json as { result?: unknown } | null)?.result

function wsProbe(url: string, waitMs = 4000): Promise<{ opened: boolean; messages: string[]; error?: string }> {
  return new Promise((resolve) => {
    const messages: string[] = []
    let opened = false
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (e) {
      resolve({ opened, messages, error: (e as Error).message })
      return
    }
    const finish = (error?: string) => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve({ opened, messages, error })
    }
    const timer = setTimeout(() => finish(), waitMs)
    ws.onopen = () => {
      opened = true
    }
    ws.onmessage = (m) => {
      if (messages.length < 3) messages.push(String(m.data).slice(0, 1500))
    }
    ws.onerror = () => finish(opened ? undefined : "connection failed")
  })
}

async function main() {
  md(`# Printer probe: ${host}`)
  md()
  md(`- Date: ${new Date().toISOString()}`)
  md(`- Command: \`npx tsx tools/probe-printer.ts ${args.join(" ")}\``)
  md(`- Mode: read-only${allowUpload ? " + upload test (--allow-upload; no print started)" : " (no upload)"}`)
  md()

  // 1. Ports
  md("## 1. Open ports")
  md()
  md("| Port | Expected | Open |")
  md("|---|---|---|")
  const ports = [...KNOWN_PORTS]
  if (userPort && !ports.some(([p]) => p === userPort)) ports.unshift([userPort, "given port"])
  const open = new Map<number, boolean>()
  await Promise.all(ports.map(async ([p]) => open.set(p, await tcpOpen(p))))
  for (const [p, what] of ports) md(`| ${p} | ${what} | ${open.get(p) ? "**yes**" : "no"} |`)
  md()

  // 2. Find Moonraker (direct, or proxied through Fluidd/Mainsail/nginx)
  md("## 2. Moonraker")
  md()
  const order = [...new Set([userPort ?? 7125, 7125, 4408, 4409, 80])].filter((p) => open.get(p))
  let base: string | null = null
  for (const p of order) {
    const b = `http://${host}${p === 80 ? "" : `:${p}`}`
    const r = await http(`${b}/server/info`)
    const info = result(r) as { klippy_state?: string } | undefined
    md(`- \`GET ${b}/server/info\` -> ${r.error ?? r.status} ${info?.klippy_state ? `(klippy_state=${info.klippy_state})` : ""}`)
    if (r.status === 401 || r.status === 403) md(`  - **Auth required** (${r.status}). Moonraker [authorization] trusted_clients must include this machine, or use an API key.`)
    if (info && !base) base = b
  }
  md()
  if (!base) {
    md("**Moonraker not reachable.** On the SPARKX i7 this likely means root access is needed (Settings → Root account information),")
    md("or Moonraker only listens on localhost. Check the Creality WebSocket (section 6) as a fallback.")
  } else {
    md(`Using Moonraker at **${base}**`)
    md()
    const get = async (path: string) => {
      const r = await http(base + path)
      return { r, res: result(r) }
    }

    const si = await get("/server/info")
    md("### /server/info")
    code(si.res)
    const pi = await get("/printer/info")
    md("### /printer/info")
    code(pi.res ?? pi.r.error ?? pi.r.status)
    const sys = await get("/machine/system_info")
    if (sys.res) {
      const s = (sys.res as { system_info?: { distribution?: unknown; cpu_info?: unknown } }).system_info
      md("### /machine/system_info (distribution, cpu)")
      code({ distribution: s?.distribution, cpu_info: s?.cpu_info })
    }

    // Objects
    const ol = await get("/printer/objects/list")
    const objects = ((ol.res as { objects?: string[] } | undefined)?.objects ?? []).slice().sort()
    md(`### /printer/objects/list (${objects.length} objects)`)
    code(objects.join("\n"), 8000)
    const custom = objects.filter((o) => !STANDARD_OBJECT.test(o))
    md(`**Non-standard objects** (candidates for the CFS / Creality extensions): ${custom.length ? custom.map((o) => `\`${o}\``).join(", ") : "none"}`)
    md()
    if (custom.length) {
      const q = await get(`/printer/objects/query?${custom.map(encodeURIComponent).join("&")}`)
      md("#### Custom object state")
      code((q.res as { status?: unknown } | undefined)?.status ?? q.r.error ?? q.r.status, 8000)
    }
    const st = await get("/printer/objects/query?print_stats&extruder&heater_bed&display_status&virtual_sdcard&toolhead&bed_mesh")
    md("### Live state (print_stats, extruder, heater_bed, display_status, virtual_sdcard, toolhead, bed_mesh)")
    code((st.res as { status?: unknown } | undefined)?.status ?? st.r.error, 6000)

    // Macros the slicer output relies on
    const cf = await get("/printer/objects/query?configfile=settings")
    const settings = ((cf.res as { status?: { configfile?: { settings?: Record<string, unknown> } } } | undefined)?.status
      ?.configfile?.settings ?? {}) as Record<string, { gcode?: string } & Record<string, unknown>>
    md("### Macros used by the OrcaSlicer SPARKX i7 profile")
    md()
    md("The sliced G-code calls `START_PRINT EXTRUDER_TEMP= BED_TEMP=`, `END_PRINT`, `PAUSE`, and CFS commands `M8200`.")
    for (const m of ["start_print", "end_print", "pause", "resume", "cancel_print", "m8200", "box_go_to_extrude_pos"]) {
      const sec = settings[`gcode_macro ${m}`]
      md(`- \`${m.toUpperCase()}\`: ${sec ? "defined" : "**not found** as gcode_macro (may be a built-in/C extension command)"}`)
      if (sec?.gcode) code(sec.gcode, 3000)
    }
    const macros = Object.keys(settings).filter((k) => k.startsWith("gcode_macro ")).map((k) => k.slice(12))
    md(`- All macros (${macros.length}): ${macros.join(", ") || "none"}`)
    if (settings.bed_mesh) {
      md("- `[bed_mesh]`:")
      code(settings.bed_mesh)
    }
    const cfsSections = Object.keys(settings).filter((k) => /box|cfs|multi_color|filament_rack|rfid/i.test(k))
    if (cfsSections.length) md(`- CFS-looking config sections: ${cfsSections.map((k) => `\`${k}\``).join(", ")}`)
    md()

    // Files
    const roots = await get("/server/files/roots")
    md("### /server/files/roots")
    code(roots.res ?? roots.r.error ?? roots.r.status)
    const gcodesRoot = ((roots.res as { name: string; permissions?: string }[] | undefined) ?? []).find((r) => r.name === "gcodes")
    md(`- gcodes root permissions: **${gcodesRoot?.permissions ?? "unknown"}** ${gcodesRoot?.permissions?.includes("w") ? "(uploads should be allowed)" : ""}`)
    const files = await get("/server/files/list?root=gcodes")
    if (Array.isArray(files.res)) md(`- ${files.res.length} files in gcodes`)
    md()

    // Upload test
    md("### Upload test")
    if (!allowUpload) {
      md("Skipped (run with `--allow-upload` to upload and delete a comment-only test file).")
    } else {
      const name = `printstudio-probe-${Date.now()}.gcode`
      const form = new FormData()
      form.append("root", "gcodes")
      form.append("file", new Blob(["; Crease probe file. Comments only: no moves, no heating.\n"]), name)
      const up = await http(`${base}/server/files/upload`, { method: "POST", body: form }, 15000)
      md(`- upload \`${name}\` -> ${up.error ?? up.status}`)
      code(up.json ?? up.text, 1000)
      const listed = await get("/server/files/list?root=gcodes")
      const found = Array.isArray(listed.res) && (listed.res as { path: string }[]).some((f) => f.path === name)
      md(`- listed afterwards: ${found ? "yes" : "no"}`)
      const del = await http(`${base}/server/files/gcodes/${encodeURIComponent(name)}`, { method: "DELETE" })
      md(`- delete -> ${del.error ?? del.status}`)
    }
    md()

    // Cameras
    md("## 3. Cameras")
    md()
    const wc = await get("/server/webcams/list")
    const cams = ((wc.res as { webcams?: { name?: string; snapshot_url?: string; stream_url?: string; service?: string }[] } | undefined)?.webcams ?? [])
    code(wc.res ?? wc.r.error ?? wc.r.status)
    for (const c of cams) {
      if (!c.snapshot_url) continue
      const urls = /^https?:/.test(c.snapshot_url)
        ? [c.snapshot_url]
        : [80, 4408, 4409, userPort ?? 7125].map((p) => `http://${host}${p === 80 ? "" : `:${p}`}${c.snapshot_url}`)
      for (const u of urls) {
        const r = await http(u)
        md(`- \`${c.name}\` snapshot \`${u}\` -> ${r.error ?? `${r.status} ${r.type} ${r.bytes} bytes`}`)
        if (r.ok && r.type.startsWith("image/")) break
      }
    }
  }
  if (!base) md("## 3. Cameras")
  md()
  md("Direct camera endpoints (Creality stock firmware):")
  for (const u of [`http://${host}:8080/?action=snapshot`, `http://${host}:8080/snapshot`, `http://${host}/webcam/?action=snapshot`]) {
    const r = await http(u, {}, 3000)
    md(`- \`${u}\` -> ${r.error ?? `${r.status} ${r.type} ${r.bytes} bytes`}`)
  }
  md()

  // 4. Web UIs
  md("## 4. Web frontends")
  md()
  for (const p of [80, 4408, 4409]) {
    if (!open.get(p)) continue
    const r = await http(`http://${host}${p === 80 ? "" : `:${p}`}/`, {}, 3000)
    const title = r.text.match(/<title>([^<]*)<\/title>/i)?.[1]
    md(`- :${p} -> ${r.error ?? r.status} ${title ? `title "${title}"` : r.type}`)
  }
  md()

  // 5. Creality WebSocket (read-only: we only listen, never send)
  md("## 5. Creality WebSocket API (:9999)")
  md()
  if (!open.get(9999)) md("Port closed.")
  else {
    const ws = await wsProbe(`ws://${host}:9999`)
    md(`- opened: ${ws.opened}${ws.error ? `, error: ${ws.error}` : ""}; first messages (listen-only, 4 s):`)
    for (const m of ws.messages) code(m, 1500)
    if (ws.opened && !ws.messages.length) md("- no unsolicited messages (it may need a request; not sent: read-only probe)")
  }
  md()

  md("## Summary")
  md()
  md(`- Moonraker: ${base ? `reachable at ${base}` : "**not reachable**"}`)
  md(`- Root needed?: ${base ? "no (answered without credentials)" : "probably (see SPEC risk)"}`)
  md()

  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, lines.join("\n") + "\n")
  console.error(`\nreport written to ${outFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
