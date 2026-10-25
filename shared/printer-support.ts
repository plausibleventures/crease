// The honest printer compatibility matrix (R19). One source of truth for the Add-a-printer flow, machine cards,
// the agent and docs/printer-support.md (generated: `npx tsx tools/gen-printer-support.ts`; a test fails when the
// doc is out of date). Only the Creality SPARKX i7 (fw 1.1.5.10, 10.0.0.24) has been used with real prints; every
// other "works" claim below is either simulated (practice printer / OrcaSlicer CLI) or untested. Keep it that way:
// raise a level only with evidence from a real print.
// No Node or DOM dependencies.
import type { CapabilitySupport, PrinterFamilySupport, SupportCapability, SupportLevel } from "./types"

export const CAPABILITIES: { key: SupportCapability; label: string; short: string }[] = [
  { key: "slicing", label: "Slicer preset", short: "slicing" },
  { key: "export", label: "Save print file (by hand)", short: "saving" },
  { key: "send", label: "Send + control (Moonraker)", short: "sending" },
  { key: "slots", label: "Colour / material slots", short: "colours" },
  { key: "creality", label: "Creality job tracking (:9999)", short: "touchscreen" },
  { key: "camera", label: "Camera", short: "camera" },
]

export const LEVEL_LABEL: Record<SupportLevel, string> = {
  verified: "verified on real hardware",
  simulated: "simulated only",
  untested: "untested",
  unsupported: "not supported",
}
export const LEVEL_MARK: Record<SupportLevel, string> = { verified: "✓", simulated: "~", untested: "?", unsupported: "–" }

const c = (level: SupportLevel, note: string): CapabilitySupport => ({ level, note })

const NO_CREALITY = c("unsupported", "Not Creality firmware.")
const MOONRAKER_SIM = c(
  "simulated",
  "Upload, start, pause/resume/cancel, status and end detection follow Moonraker's documented API; exercised only against the built-in practice printer (a Moonraker simulation). Plain Klipper reports print_stats normally, which the simulator also covers.",
)

interface FamilyRule extends PrinterFamilySupport {
  /** Matched against "<vendor> <model>" (case-insensitive). */
  match?: RegExp
  /** Klipper firmware (OrcaSlicer gcode_flavor "klipper"): required for this rule when set. */
  klipper?: boolean
}

/** First matching rule wins (order matters). */
export const PRINTER_FAMILIES: FamilyRule[] = [
  {
    id: "practice",
    family: "Practice printer (built in)",
    examples: "Crease's pretend printer",
    verifiedOn: null,
    caps: {
      slicing: c("simulated", "Uses the SPARKX i7 profile, so files match what a real i7 gets."),
      export: c("simulated", "Save print file works the same way; nothing to print it on."),
      send: c("simulated", "A Moonraker simulation inside Crease: heats, prepares, prints, finishes. Nothing moves."),
      slots: c("simulated", "Shows the colours you typed in for it; a made-up CFS unit for testing."),
      creality: c("unsupported", "The dev mock (MOCK_CREALITY=1, MOCK_CREALITY_WS_PORT) emulates Creality firmware; the practice printer doesn't."),
      camera: c("simulated", "A drawn picture of the print, via a Moonraker-style snapshot URL."),
    },
  },
  {
    id: "sparkx-i7",
    family: "Creality SPARKX i7",
    examples: "SPARKX i7 (with or without CFS-lite), firmware 1.1.5.10",
    match: /spark\s*x.*i7/i,
    verifiedOn: "SPARKX i7",
    caps: {
      slicing: c("verified", "Tuned copy of OrcaSlicer's i7 preset; calibration cube, apple logo and test plates printed."),
      export: c("verified", "The same G-code that printed over the network. Printing it from a USB stick on the touchscreen is untested."),
      send: c("verified", "Upload, start, cancel, Preparing phase and end detection on real prints. Pause/resume from the app: untested."),
      slots: c("verified", "CFS slots and colours read from the printer; slot mapping fixed after the first print. Material codes other than PLA (001001): unverified."),
      creality: c("simulated", "Listening to :9999 for layer/time left: verified. Starting jobs through Creality's service so the touchscreen tracks them: experimental, simulator only (off by default)."),
      camera: c("verified", "WebRTC on :8000 with Google's STUN server. Local-only (no STUN): implemented, untested on the printer."),
    },
  },
  {
    id: "creality-cfs",
    family: "Creality Klipper printers with CFS",
    examples: "K2, K2 Plus, K2 Pro, Hi (Combo), K1-series with CFS-C",
    match: /creality.*(\bk2\b|\bhi\b|cfs)/i,
    verifiedOn: null,
    caps: {
      slicing: c("untested", "OrcaSlicer's own preset; never printed from Crease."),
      export: c("untested", "Standard G-code for the printer's touchscreen / USB; never tried."),
      send: c("untested", "Same Creality-Klipper + Moonraker path as the i7, so it should work; K1-series stock firmware may need root for Moonraker."),
      slots: c("untested", "Expected to read the same Moonraker `box` object as the i7; never seen on these printers."),
      creality: c("untested", "The :9999 websocket is documented for the K1/K2 family (OrcaSlicer, community notes); never tried here."),
      camera: c("untested", "K2-family firmware is reported to use the same WebRTC camera on :8000 as the i7."),
    },
  },
  {
    id: "creality-klipper",
    family: "Creality Klipper printers (single spool)",
    examples: "K1, K1C, K1 Max, K1 SE, Ender-3 V3 / V3 KE / V3 Plus, Ender-5 Max",
    match: /creality.*(\bk1|ender-?3 v3|ender-?5 ?max)/i,
    verifiedOn: null,
    caps: {
      slicing: c("untested", "OrcaSlicer's own preset (the K1 preset was sliced in development, never printed)."),
      export: c("untested", "Standard G-code for the printer's touchscreen / USB; never tried."),
      send: c("untested", "Creality-Klipper + Moonraker like the i7; K1-series stock firmware may need root before Moonraker answers."),
      slots: c("unsupported", "Single spool (a CFS add-on would be read like the i7's, untested)."),
      creality: c("untested", "K1-family firmware has the :9999 websocket; never tried here."),
      camera: c("untested", "Auto-detected (WebRTC :8000 or mjpg-streamer :8080); never tried on these printers."),
    },
  },
  {
    id: "bambu",
    family: "Bambu Lab",
    examples: "A1, A1 mini, P1P, P1S, X1C, H2D",
    match: /bambu/i,
    verifiedOn: null,
    caps: {
      slicing: c("untested", "OrcaSlicer's own preset."),
      export: c("untested", "Bambu printers normally take a sliced .gcode.3mf from Bambu Studio/Handy; a plain .gcode on the SD card is untested."),
      send: c("unsupported", "Bambu uses its own MQTT/FTP protocol, not Moonraker."),
      slots: c("unsupported", "The AMS isn't read."),
      creality: NO_CREALITY,
      camera: c("unsupported", "Not connected."),
    },
  },
  {
    id: "klipper",
    family: "Other Klipper printers (Moonraker)",
    examples: "Voron, RatRig, Sovol SV07/SV08, Elegoo Neptune 4, Qidi, Anycubic Kobra (Klipper builds), Prusa/others running Klipper",
    klipper: true,
    verifiedOn: null,
    caps: {
      slicing: c("untested", "OrcaSlicer's own preset for the model; its start G-code must match the printer's PRINT_START macro."),
      export: c("untested", "Standard G-code; never tried by hand on these printers."),
      send: MOONRAKER_SIM,
      slots: c("unsupported", "Single spool; other multi-colour units (MMU, ERCF, Box Turtle) aren't read."),
      creality: NO_CREALITY,
      camera: c("simulated", "Moonraker-listed webcams (snapshot URL) and mjpg-streamer; only the simulator's snapshot was tested."),
    },
  },
  {
    id: "other",
    family: "Other printers (Marlin, PrusaLink, OctoPrint …)",
    examples: "Prusa MK4/Core One/Mini, Ender-3 V2/S1, Anycubic, Elegoo (Marlin), anything else in the model list",
    verifiedOn: null,
    caps: {
      slicing: c("untested", "OrcaSlicer's own preset (or a generic profile sized to the bed when the model isn't listed)."),
      export: c("untested", "Save the G-code and print it from the printer's screen / SD card / its own app."),
      send: c("unsupported", "Crease only talks to Klipper's Moonraker. PrusaLink / OctoPrint / Marlin serial aren't supported."),
      slots: c("unsupported", "Not read."),
      creality: NO_CREALITY,
      camera: c("unsupported", "Not connected."),
    },
  },
]

export interface SupportInput {
  model: string
  vendor?: string
  klipper?: boolean // from the model catalogue (MachineModel.klipper); unknown when undefined
  isPractice?: boolean
  slicerProfile?: string // "generic" = no OrcaSlicer preset matched
}

export interface PrinterSupport extends PrinterFamilySupport {
  generic: boolean // sliced with the generic profile (approximate)
}

/** Support levels for a printer model (or a saved machine). */
export function supportFor(input: SupportInput): PrinterSupport {
  const hay = `${input.vendor ?? ""} ${input.model}`.trim()
  const rule = input.isPractice
    ? PRINTER_FAMILIES[0]
    : (PRINTER_FAMILIES.slice(1).find((r) => {
        if (r.match && !r.match.test(hay)) return false
        if (r.klipper && input.klipper !== true) return false
        // a rule without match/klipper is the catch-all
        return true
      }) ?? PRINTER_FAMILIES[PRINTER_FAMILIES.length - 1])
  const { match: _m, klipper: _k, ...fam } = rule
  void _m
  void _k
  const generic = input.slicerProfile === "generic"
  const caps = { ...fam.caps }
  if (generic)
    caps.slicing = c("untested", "No OrcaSlicer preset matches this model: a generic Klipper profile sized to the bed. Check its start G-code suits the printer.")
  return { ...fam, caps, generic }
}

/** Support for a saved machine: a machine reached over the network talks Moonraker, so it counts as Klipper. */
export function supportForMachine(m: { model: string; isPractice?: boolean; slicerProfile?: string; connection: { type: string } }): PrinterSupport {
  return supportFor({ model: m.model, isPractice: m.isPractice, slicerProfile: m.slicerProfile, klipper: m.connection.type === "moonraker" ? true : undefined })
}

/** Can Crease send prints to this family at all (any level but unsupported)? */
export const canSend = (s: PrinterFamilySupport) => s.caps.send.level !== "unsupported"

export interface SupportHeadline {
  /** "Works: slicing ✓ · sending ✓ · colours ✓ · camera ✓ (verified on SPARKX i7)" or "Slicing only — …" */
  text: string
  tone: "ok" | "warn" | "muted"
  chips: { key: SupportCapability; label: string; level: SupportLevel; note: string }[]
}

/**
 * One line for the Add-a-printer flow and machine cards. `connection` is how this machine is (or will be) reached:
 * with no connection (or a family Crease can't send to) it's the export-only path.
 */
export function supportHeadline(s: PrinterFamilySupport, connection: "network" | "none" | "practice" = "network"): SupportHeadline {
  const keys: SupportCapability[] =
    connection === "none" || !canSend(s) ? ["slicing", "export"] : ["slicing", "send", "slots", "camera", ...(s.caps.creality.level === "unsupported" ? [] : (["creality"] as const))]
  const chips = keys
    .map((k) => ({ key: k, label: CAPABILITIES.find((x) => x.key === k)!.short, level: s.caps[k].level, note: s.caps[k].note }))
    .filter((x) => x.level !== "unsupported")
  if (connection === "none" || !canSend(s)) {
    const why = connection === "none" ? "" : " (Crease can't connect to this kind of printer)"
    return { text: `Slicing only — save the file and print from the printer's screen${why}`, tone: "muted", chips }
  }
  // The headline covers the everyday path; Creality job tracking stays a chip (it's an experimental extra).
  const main = chips.filter((x) => x.key !== "creality")
  const marks = main.map((x) => `${x.label} ${LEVEL_MARK[x.level]}`).join(" · ")
  const levels = new Set(main.map((x) => x.level))
  const suffix =
    connection === "practice"
      ? "(simulated: nothing really prints)"
      : levels.size === 1 && levels.has("verified")
        ? `(verified on ${s.verifiedOn})`
        : s.verifiedOn
          ? `(✓ verified on ${s.verifiedOn}; ~ simulated only; ? untested)`
          : levels.has("untested")
            ? "(untested on this printer: ~ simulated only, ? untested)"
            : "(simulated only: never tried on this printer)"
  const allVerified = levels.size === 1 && levels.has("verified")
  return { text: `Works: ${marks} ${suffix}`, tone: allVerified ? "ok" : connection === "practice" ? "muted" : "warn", chips }
}

/** Markdown for docs/printer-support.md. */
export function renderSupportDoc(): string {
  const lines: string[] = []
  lines.push("# Printer support matrix")
  lines.push("")
  lines.push("<!-- Generated from shared/printer-support.ts by `npx tsx tools/gen-printer-support.ts`. Do not edit by hand. -->")
  lines.push("")
  lines.push(
    "Crease has been used with real prints on **one printer: a Creality SPARKX i7** (firmware 1.1.5.10). " +
      "Everything else is either *simulated only* (exercised against the built-in practice printer, a Moonraker simulation, " +
      "or the OrcaSlicer CLI) or *untested*. OrcaSlicer ships presets for hundreds of models, so the model list is long, " +
      "but a slicer preset is not the same as printer support.",
  )
  lines.push("")
  lines.push("Levels: " + (Object.keys(LEVEL_LABEL) as SupportLevel[]).map((l) => `${LEVEL_MARK[l]} ${LEVEL_LABEL[l]}`).join(" · "))
  lines.push("")
  lines.push(`| Family | ${CAPABILITIES.map((x) => x.label).join(" | ")} |`)
  lines.push(`|---|${CAPABILITIES.map(() => "---").join("|")}|`)
  for (const f of PRINTER_FAMILIES) {
    lines.push(`| **${f.family}** | ${CAPABILITIES.map((x) => `${LEVEL_MARK[f.caps[x.key].level]} ${f.caps[x.key].level}`).join(" | ")} |`)
  }
  lines.push("")
  lines.push("## Details")
  for (const f of PRINTER_FAMILIES) {
    lines.push("")
    lines.push(`### ${f.family}`)
    lines.push("")
    lines.push(`Covers: ${f.examples}.${f.verifiedOn ? ` Verified on: ${f.verifiedOn}.` : ""}`)
    lines.push("")
    for (const x of CAPABILITIES) lines.push(`- **${x.label}** — ${LEVEL_MARK[f.caps[x.key].level]} ${LEVEL_LABEL[f.caps[x.key].level]}. ${f.caps[x.key].note}`)
  }
  lines.push("")
  lines.push("## Without a connection (export only)")
  lines.push("")
  lines.push(
    "Any printer in the model list can be added with **No connection**. Crease slices for it and **Save print file** " +
      "writes the G-code (`<project>_<part>.gcode`). Copy it to a USB stick / SD card (or send it with the printer's own app), " +
      "then pick it on the printer's screen. Crease can't see these prints, so there is no progress, camera or end-of-print log.",
  )
  lines.push("")
  lines.push("## How a level goes up")
  lines.push("")
  lines.push(
    "Run the steps in `docs/printer-bringup.md` on the printer, record what happened (with photos) in an issue or PR, " +
      "then change the level in `shared/printer-support.ts` and regenerate this file. " +
      "R19's acceptance asks for a second hardware/adapter path to be proven before claiming breadth.",
  )
  lines.push("")
  return lines.join("\n")
}
