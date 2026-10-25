// Shared contract between the server (Node) and the renderer (React).
// Keep this file dependency-free so both sides can import it.

export interface PartRef {
  id: string
  file: string // relative to project root, e.g. "parts/tray.scad"
  qty: number
  colors: string[]
  /** R23: the part came from a file the user imported (parts/imported/<id>.*); absent for designed parts. */
  imported?: ImportedPartInfo
}

/** R23: where an imported part came from. Also written next to it as parts/imported/<id>.json. */
export interface ImportedPartInfo {
  /** "mesh": STL/3MF triangles, a fixed shape that can be scaled, rotated and placed but not reshaped by parameters.
   *  "scad": OpenSCAD source, editable like any designed part. */
  kind: "mesh" | "scad"
  format: "stl" | "3mf" | "scad"
  originalName: string // the file name the user dropped
  importedAt: string
  sha256: string // of the imported bytes
  units: "mm" | "inch" // what one unit in the file means (3MF: converted to mm on import)
  source: ImportSource
  licence: string // e.g. "CC BY 4.0", "I made it", "Unknown"
  title?: string // from 3MF metadata
  designer?: string // from 3MF metadata or what the user typed
  sizeMm?: [number, number, number] // after units
  triangles?: number
  /** What the import didn't take from the file, in plain words (e.g. the print settings inside a 3MF). */
  ignored?: string[]
}

export interface ImportSource {
  kind: "self" | "web" | "person" | "unknown" // I made it / a website / someone gave it to me / not sure
  url?: string
  author?: string
}

/** R23: what an uploaded file looks like, before the user answers the import questions. */
export interface ImportInspection {
  token: string // pass back to commit; valid ~30 min
  fileName: string
  format: "stl" | "3mf" | "scad"
  kind: "mesh" | "scad"
  suggestedId: string // part id it will get (free in the project)
  triangles?: number
  /** Size if one unit is a millimetre, and if it's an inch (meshes from STL; 3MF already knows its units). */
  sizeIfMm?: [number, number, number]
  sizeIfInch?: [number, number, number]
  units: { known: "mm" | "inch" | null; ask: boolean; recommended: "mm" | "inch"; why: string }
  /** Filled from 3MF metadata when present; the dialog asks "Where's it from?" when `licence` is missing. */
  metadata: { title?: string; designer?: string; licence?: string; copyright?: string; source?: string; application?: string }
  libraries: string[] // OpenSCAD libraries a .scad uses (BOSL2 is bundled)
  warnings: string[] // plain words: ignored 3MF settings, missing include files, not watertight…
}

export interface ImportCommitRequest {
  token: string
  id?: string // part id (default: suggestedId)
  units?: "mm" | "inch" // default: the inspection's known/recommended units
  source: ImportSource
  licence: string
}

export interface ImportCommitResult {
  part: PartRef
  project: Project
  files: string[] // project-relative paths written
}

/** One row of the sidebar's Files tree (GET /api/projects/:id/files). Paths are project-relative, "/"-separated. */
export interface ProjectFileNode {
  name: string
  path: string
  kind: "file" | "dir"
  /** bytes (files only) */
  size?: number
  mtime: string
  /** app-made (renders/): shown, but never renamed, deleted or written from the Files section */
  readOnly?: boolean
  children?: ProjectFileNode[]
}

export interface ProjectFilesResult {
  files: ProjectFileNode[]
  /** hit the listing cap (entries beyond it are left out) */
  truncated: boolean
}

export interface Project {
  id: string
  name: string
  createdAt: string
  printer: string
  /** Print intent the project slices with: the toolbar picker; every slice sets it (= the latest slice's intent). */
  intent?: PrintIntent
  engine: "openscad"
  tags: string[]
  parts: PartRef[]
  activeSessionId: string | null
  // Kept in .studio/state.json (not versioned), so switching versions never rewrites the session list.
  sessions: ProjectSession[]
  /** Agent model picked in this project's switcher (.studio/state.json); absent = the profile's model. */
  agentModel?: string | null
  /** R11b: runtime the agentModel was picked for ("claude" when absent); ignored under a different runtime. */
  agentModelRuntime?: string | null
  /** R11b: agent profile picked for this project (.studio/state.json); absent/null = the default profile. */
  agentProfileId?: string | null
  source: null | { importId: string }
  /** Licence the maker chose for sharing (build pack export). Default "All rights reserved" when absent. */
  license?: string
  /** One or two plain sentences about what this is (build pack + library). */
  description?: string
}

/** PATCH /api/projects/:id (U4): rename (display name only; the folder/id stay) and/or replace the tags. */
export interface ProjectPatch {
  name?: string
  tags?: string[]
}

/** DELETE /api/projects/:id (U4): the folder went to the OS Trash ("system", desktop app) or <STUDIO_HOME>/.trash ("app"). */
export interface ProjectTrashResult {
  trashed: true
  where: "system" | "app"
  /** where it is now ("app" only) */
  path: string | null
}

/**
 * One chat of a project (.studio/state.json). forkCostUsd: the parent chat's cost copied in at the fork (the idea's own
 * cost is the rest). R11g: `handoff` links a chat started from a portable summary to the chat it came from;
 * `profileId`/`model` = the designer the chat was held by (restored when the chat is opened again; absent = unknown).
 */
export interface ProjectSession {
  id: string
  title: string
  forkedFrom: string | null
  branch?: string
  runtime?: string
  forkCostUsd?: number
  handoff?: { id: string; fromSessionId: string | null; from: string; reason: HandoffReason }
  profileId?: string | null
  model?: string | null
}

/** A bundled starter idea (resources/starters/<id>/) shown in the Library's "Start from an idea". */
export interface Starter {
  id: string
  title: string
  blurb: string
  tags: string[]
  thumbnailUrl: string | null
  firstMessage: string | null
}

/** GET /api/about: Settings > About. `repoUrl`/`issueUrl` are null unless package.json names a repository. */
export interface AboutInfo {
  name: string
  version: string
  license: string
  repoUrl: string | null
  /** A GitHub "new issue" URL (the app adds a prefilled title/body); null = copy a summary instead. */
  issueUrl: string | null
  /** STUDIO_HOME: where projects, printers and settings live. */
  dataDir: string
  os: { platform: string; release: string; arch: string }
  runtime: { node: string; electron: string | null }
}

/** First-run "Checking your computer" result for one tool. ok: null = couldn't tell. */
export interface SetupCheck {
  ok: boolean | null
  detail: string
  hint?: string
  /** The program found (OpenSCAD/OrcaSlicer binary, or the Claude CLI). */
  path?: string
  version?: string
  /** "settings" = the path set in Settings; "found" = discovered automatically. */
  source?: "settings" | "found"
  /** A one-click fix the UI offers next to the hint. */
  fix?: SetupFix
  /** A second, less prominent fix (e.g. "Use my Claude Code sign-in" next to "Add an API key"). */
  altFix?: SetupFix
}

export type SetupFix =
  | { kind: "open-url"; label: string; url: string }
  /**
   * Dev only (PRINTSTUDIO_DEV_CLAUDE_LOGIN=1): POST /api/onboarding/claude-login opens Terminal running `claude auth
   * login`. Public builds never offer it (INVENTORY B1): people sign in to their own Claude Code themselves.
   */
  | { kind: "claude-login"; label: string }
  /** Paste an Anthropic API key for this agent profile (PUT /api/agent/profiles/:id/key; it switches to the key). */
  | { kind: "anthropic-key"; label: string; profileId: string }
  /** Use the user's own, already signed-in Claude Code for this profile (PATCH auth -> {kind: "subscription"}). */
  | { kind: "claude-use-login"; label: string; profileId: string }
  /** R11d: POST /api/agent/runtimes/codex/login -> {authUrl}: opens the ChatGPT sign-in for Crease's own Codex home. */
  | { kind: "codex-login"; label: string }
  /** R11e: POST /api/agent/runtimes/grok/login -> {authUrl, code}: opens the Grok device sign-in for Crease's own Grok home. */
  | { kind: "grok-login"; label: string }

/** A saved version of the project (a git commit on the current line of work). */
export interface Checkpoint {
  commit: string
  short: string
  date: string // ISO
  message: string // without the "agent: " / "user: " prefix
  author: "agent" | "user"
}

export interface ProjectSummary {
  id: string
  name: string
  tags: string[]
  updatedAt: string
  thumbnailUrl: string | null
}

export interface ScadParameter {
  name: string
  type: "number" | "string" | "boolean" | "enum"
  value: number | string | boolean
  min?: number
  max?: number
  step?: number
  options?: (string | number)[]
  group?: string
  description?: string
  /** set when it comes from a project file the part include<>s (e.g. "lib/params.scad"), not the part's own file */
  file?: string
  /** A shared setting: every part that has it (this one included, project order). One value applies to all of them,
   *  so changing it here changes them all. Absent for a setting only this part has. */
  sharedWith?: string[]
}

/** A shared setting whose parts had different saved values before Crease joined them (older projects). */
export interface SharedParamNote {
  name: string
  /** the value every part uses now */
  value: number | string | boolean
  /** part id -> the value it had */
  was: Record<string, number | string | boolean>
}

export interface MeshStats {
  bbox: { min: [number, number, number]; max: [number, number, number] }
  sizeMm: [number, number, number]
  volumeMm3: number
  triangles: number
  bodies: number
  manifold: boolean
}

export interface RenderResult {
  partId: string
  // Colour-preserving 3MF (per-color() triangles) for the 3D viewer; absent on older renders -> use stlUrl.
  modelUrl?: string
  front?: "-y" | "+y" | "-x" | "+x" // side treated as the part's front in the previews (default -y)
  /** A face-down display piece (show face on the plate, modelled mirrored): views other than the plate show it
   *  turned over, so the show face reads the right way round. */
  showFaceDown?: boolean
  stlUrl: string // URL served by the local API, e.g. /api/projects/:id/artifacts/build/tray.stl?v=<hash>
  /** "back": Blender (sculpted) parts only, so a figure is seen from all round. */
  images: { view: "iso" | "front" | "top" | "right" | "bed" | "back"; url: string }[]
  stats: MeshStats | null
  /** What the build did on its own, in plain words (a Blender part simplified, or moved down onto the bed). */
  notes?: string[]
  /** Why `error`, when the app can help: "BLOCKED" = a Blender script from a build pack, not yet allowed. */
  errorCode?: string
  cached: boolean
  durationMs: number
  error?: string
}

export interface PartLatest {
  render: RenderResult | null
  check: CheckReport | null
}

export type CheckSeverity = "pass" | "warn" | "fail" | "info"
/** A spot on the part a check points at (R23), in the part's own (STL) coordinates; shown as a marker in the viewer. */
export interface CheckMarker {
  at: [number, number, number]
  label: string // short, e.g. "0.60 mm"
  severity: CheckSeverity
}
export interface CheckItem {
  rule: string
  severity: CheckSeverity
  measured: string
  threshold: string
  location?: string
  message: string
  markers?: CheckMarker[]
}
export interface CheckReport {
  partId: string
  createdAt: string
  items: CheckItem[]
  summary: CheckSeverity // worst severity among items (info counts as pass)
  source?: SourceStamp // what it was checked against (absent on reports made before R07: treated as out of date)
  orientation?: OrientationAdvice // R23: how to lay it on the bed (absent on older reports)
}

/** R23: one way to lay a part on the bed, measured on its mesh. */
export interface OrientationCandidate {
  id: string // "current", "upside-down", "on-its-back", "on-its-front", "on-its-left", "on-its-right", "tilted-1"…
  label: string // plain: "As it is now", "On its back"
  /** rotate([x, y, z]) in degrees to write in the part's .scad (print_orientation): absolute, not relative. */
  rotate: [number, number, number]
  heightMm: number
  bedContactMm2: number // flat area touching the bed
  overhangMm2: number // faces steeper than 45° that need supports
  bridgeMm2: number // flat undersides narrow enough to bridge (≤ 10 mm across)
  supportMm2: number // overhangs + flat undersides too wide to bridge
  relTime: number // rough print time relative to the current orientation (0.6 = about 40% faster)
  tippy: boolean // tall and narrow on the bed
}
export interface OrientationAdvice {
  current: OrientationCandidate
  /** The better way to lay it, or null when the current one is best (or nothing is clearly better). */
  suggestion: OrientationCandidate | null
  reasons: string[] // plain words, why the suggestion is better (or why the current one is fine)
  summary: string // one line: "Lay it on its back: no supports needed, about 40% faster."
  candidates: OrientationCandidate[] // every orientation evaluated, current first
}

// ---- Artifact validity (R07): every derived artifact records what it was built from ----

/**
 * The inputs an artifact was built from. Part stamps: the part's .scad + every include/use (recursively) + its
 * Customizer overrides. Assembly stamps (guide, assembly renders, motion checks): every part's stamp + assembly.json +
 * assembly.scad and its includes. Freshness = recorded `hash` equals the stamp computed now (content-based, so
 * restoring an older version makes artifacts built from it current again). See server/projects/revision.ts.
 */
export interface SourceStamp {
  hash: string
  files: Record<string, string> // project-relative path -> content hash (12 hex) or "missing"
  params?: Record<string, number | string | boolean> | null // part stamps: Customizer overrides
  parts?: Record<string, { hash: string; params: Record<string, number | string | boolean> | null }> // assembly stamps
}

/** Whether a derived artifact still matches the design. */
export interface ArtifactValidity {
  state: "fresh" | "stale" | "missing" // missing = never made
  /** Why it's out of date, in plain words ("lib/params.scad changed", "Customizer values changed (width)"). */
  reasons: string[]
  builtAt: string | null
}

/** GET /api/projects/:id/validity: freshness of every derived artifact, computed on read. */
export interface ProjectValidity {
  parts: Record<
    string,
    {
      source: string // the part's source hash now
      overrides: Record<string, number | string | boolean> | null // Customizer values it renders with now (re-render with these)
      render: ArtifactValidity // build/<part>.stl + renders/<part>-*.png
      check: ArtifactValidity // .studio/checks/<part>.json
    }
  >
  /** null when the project has no assembly.json */
  assembly: {
    source: string
    guide: ArtifactValidity // build/assembly-guide.html + assembly step renders + shopping list
    motion: ArtifactValidity | null // last check_motion (its result: AssemblyInfo.motionCheck); null without motions
  } | null
}

export interface SliceResult {
  partId: string
  gcodePath: string // relative to project root, e.g. "build/tray.gcode"
  gcodeName: string // file name, e.g. "tray.gcode"
  estimatedTimeS: number | null
  filamentG: number | null
  filamentMm: number | null
  durationMs: number
  // Multicolour (CFS) jobs only; absent for single-filament slices.
  filamentBySlot?: SlotUsage[]
  colorChanges?: number | null
  machineId?: string // machine (slicer profile) it was sliced for
  warnings?: string[] // e.g. generic slicer profile
  intent?: PrintIntent
  overrides?: Record<string, string | number | boolean> // process keys changed on top of the intent
  preview?: SlicePreviewSummary // toolpath quality check of the result
  jobId?: string // the immutable print job made from this G-code (sha256 of its bytes; see PrintJob)
}

/** Filament use per CFS slot in a multicolour slice (grams include purge/prime-tower waste). */
export interface SlotUsage {
  slot: number // 1-based CFS slot (T<slot-1> in the G-code)
  colorName: string
  colorHex: string
  grams: number | null
  mm: number | null
  modelColors: string[] // the color() values from the model mapped to this slot, e.g. ["red"]
}

export type PrinterState =
  | "disconnected"
  | "standby"
  | "printing"
  | "preparing" // derived: a job is loaded but Klipper still says standby (Creality START_PRINT: heat, load, flush, clean)
  | "paused"
  | "complete"
  | "cancelled"
  | "error"

/**
 * Klipper's own state when it isn't ready (Moonraker /printer/info `state`, objects/query `webhooks.state`).
 * "shutdown": Klipper stopped itself (e.g. a firmware fault mid-print); it needs a firmware restart.
 * "error": Klipper couldn't start (config or MCU problem); a firmware restart may fix it.
 * "startup": Klipper is starting (e.g. just after a restart). Nothing to do but wait.
 */
export type FirmwareState = "startup" | "shutdown" | "error"

export interface PrinterStatus {
  machineId?: string // which Machine this is (absent only from pre-Machines servers)
  layer?: number | null // current layer (1-based) while printing, when the printer says
  totalLayers?: number | null
  timeLeftS?: number | null // printer's own estimate when it has one (Creality), else derived from progress
  phase?: string | null // while "preparing": what it's doing, e.g. "Loading White · slot 1 · nozzle 209/240 °C"
  // Filament slots as the printer reports them (Creality CFS `box` object); absent if the printer doesn't say.
  filaments?: FilamentSlot[]
  connected: boolean
  host: string | null
  state: PrinterState
  filename: string | null
  progress: number // 0..1
  printDurationS: number
  extruder: { temp: number; target: number }
  bed: { temp: number; target: number }
  message: string | null // plain words for people; never raw firmware or Moonraker text
  isMock: boolean
  // Set (with state "error") while Klipper isn't ready. "shutdown" | "error" can be fixed with
  // POST /api/machines/:id/firmware-restart; pause/resume/cancel are refused (409) meanwhile.
  firmware?: FirmwareState
}

export interface PrintRequest {
  machineId?: string // the Machine this job goes to (user can change it in the confirm dialog)
  slotsUsed?: number[] // filament slots (1-based) the G-code uses
  slotFilaments?: { slot: number; colorName: string; colorHex: string; material: string }[] // what's in those slots now
  // Reasons the print can't start yet (e.g. a used CFS slot isn't set up on the printer). The dialog shows them
  // with a "Check again" button (POST /api/print-requests/:id/recheck); approving is refused while any remain.
  blockers?: string[]
  requestId: string
  projectId: string
  gcodeName: string
  estimatedTimeS: number | null
  filamentG: number | null
  origin: "agent" | "user"
  /** Failing printability checks from the latest check of each part ("part: message"), shown in the confirm dialog. */
  failingChecks?: string[]
  /** The immutable job this request prints: approving uploads exactly these bytes (hash-verified). */
  job?: PrintJobSummary
  /**
   * A user's print of a design not approved yet (U1): the dialog shows the checks, and its Print approves this exact
   * revision and prints (POST /api/print-requests/:id with approveDesign: true; without it the answer is refused).
   */
  needsApproval?: boolean
  /** Colours the design asks for (project.json part colours), to say so when the print uses another colour. */
  designColors?: string[]
  adjustedTime?: AdjustedTime | null // estimate scaled by the machine's time factor (R15)
}

/** One CFS (multi-material) slot on the printer. */
export interface FilamentSlot {
  slot: number // 1..4
  colorName: string // plain name, e.g. "White"
  colorHex: string // "#ffffff"
  material: string // "PLA" (default), "PETG", ...
  loaded: boolean
  materialCode?: string // Creality CFS material code as the printer reports it (e.g. "001001" = PLA)
  /** Creality product the code stands for, e.g. "Hyper PLA" (server/printer/cfs.ts table; most are unverified). */
  materialProduct?: string
}

export interface Settings {
  openscadPath: string
  orcaSlicerPath: string
  /** Blender (optional, for sculpted parts). Empty/absent = automatic. */
  blenderPath?: string
  /** The user's Claude Code program (`claude`), when automatic discovery doesn't find it. Empty/absent = automatic. */
  claudePath?: string
  printer: {
    host: string
    port: number
    // Loaded filaments (up to 4 CFS slots). Defaults are a guess until the user confirms them (or, later, the
    // printer reports them via Moonraker). Optional so older clients' Settings objects still type-check.
    filaments?: FilamentSlot[]
    filamentsConfirmed?: boolean
  }
  // The Anthropic API key is NOT a setting: it lives in the secret store (ref "anthropic.apiKey") and is set
  // with PUT/DELETE /api/secrets/:ref. GET /api/settings only reports its masked status in `auth`.
  model: string | null
  // Where to look for hardware (assembly guide + shopping list links). The server always fills this in
  // (default: US, Amazon first); optional only so older clients' Settings objects still type-check.
  sourcing?: SourcingSettings
  onboardedAt?: string | null // set when the first-run setup was finished or skipped
  /** How sizes are shown and talked about: millimetres or inches (the other unit stays in the hover text). Unset = not
   *  chosen yet (setup's Preferences step was skipped); shown as mm. */
  units?: Units
  /** Read-only (GET /api/settings fills it in; PUT ignores it): how the agent authenticates + secret store info. */
  auth?: SettingsAuth
  /** R11d: Codex runtime options (which Codex sign-in; the runtime itself is chosen by the agent profile). */
  codex?: CodexRuntimeSettings
  /** Anonymous usage reports (server/telemetry.ts): true = yes, false = no, unset/null = not asked yet (= off). */
  telemetry?: boolean | null
}

export type Units = "mm" | "in"

// ---- Secrets (see shared/api.md "Secrets"). Values never leave the server; only masked status does. ----
/**
 * Secret refs: "anthropic.apiKey", "machine.<machineId>.apiKey". Future providers add "<provider>.<name>" refs.
 */
export type SecretRef = string
/** Where a secret's value comes from. "os-keychain": encrypted with the OS keychain (Electron safeStorage);
 * "file": the dev-server fallback (unencrypted 0600 file); "env": an environment variable (read-only here). */
export type SecretSource = "os-keychain" | "file" | "env"
export interface SecretStatus {
  set: boolean
  last4?: string // "…abcd" (only for values of 12+ characters)
  source: SecretSource | null // null when not set
  /** Stored encrypted by the desktop app but this server can't decrypt it (e.g. the browser-dev server). */
  locked?: boolean
  updatedAt?: string
}
export interface SecretStoreInfo {
  backend: "os-keychain" | "file"
  encrypted: boolean
  note: string // one plain line for Settings, e.g. why the dev fallback is unencrypted
}
export interface SettingsAuth {
  anthropic: {
    /** "api-key": the agent uses the API key (billed per token). "claude-login": the user's own Claude login
     *  (subscription plan, via the claude CLI); no key is stored or passed. */
    method: "api-key" | "claude-login"
    apiKey: SecretStatus
  }
  store: SecretStoreInfo
}

// Store ids from the registry in server/assembly/stores.ts (search-link templates per store).
export type StoreId = "amazon-us" | "amazon-ca" | "amazon-uk" | "amazon-de" | "amazon-in" | "aliexpress" | "boltdepot" | "mcmaster"

export interface SourcingStoreInfo {
  id: StoreId
  label: string
  countries: string[] // ISO alpha-2; "*" = ships worldwide
  suits: HardwareType[] | "all"
  note: string | null
  verified: boolean
}

export interface SourcingSettings {
  country: string // ISO 3166 alpha-2, e.g. "US"
  stores: StoreId[] // in preference order; links are shown in this order
}

/** A spot the user pointed at on the model ("make this thicker"), sent with a chat message. */
export interface PointAnnotation {
  n: number // 1-based pin number, as drawn on the picture
  partId: string | null
  instance?: number // assembled view: which copy of the part (0-based)
  point: [number, number, number] // mm, in the part's own coordinates (its .scad)
  assemblyPoint?: [number, number, number] // mm, in assembly coordinates (assembled view only)
  normal: [number, number, number] // surface normal at the point, part coordinates
  hint: string // plain-words location, e.g. "top face, near the back-left corner"
  note: string // what the user wants changed there
}

// Legacy/native envelope: raw runtime messages. Transcripts before R11a hold these in .studio/sessions/<id>.jsonl
// (migrated to AgentEventEnvelope on read); since R11a they go to .studio/sessions/native/<id>.jsonl for diagnostics.
export interface AgentEnvelope {
  projectId: string
  sessionId: string
  seq: number
  ts: string
  // Raw SDK message (SDKMessage) or an app-level message such as
  // { type: "user_input", text } / { type: "app_error", error }.
  message: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ---- Agent runtime events (R11a): runtime-neutral, see shared/api.md "Agent events" ----
// One stream per app session, persisted to <project>/.studio/sessions/<sessionId>.jsonl and pushed over WS as
// `agent.event`. Each runtime adapter (Claude today) turns its native messages into these; the timeline renders only
// these. Legacy transcripts (raw Claude SDK messages in AgentEnvelope lines) are migrated on read.

export const AGENT_EVENT_SCHEMA_VERSION = 1 as const

/** An image the user attached (base64, no data: prefix). */
export interface AgentInputImage {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
  data: string
}
/** An image in a tool result: inline base64 or a URL. */
export interface AgentImage {
  mediaType: string
  data?: string
  url?: string
}

/** Tokens as the runtime reported them for this turn. null = not reported (unknown, not zero). */
export interface AgentTokenUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
}
/**
 * Usage, keeping what is known apart from what is estimated. Money is cumulative for the session (survives resumes).
 * Unknown stays null: never 0, and never another runtime's price list.
 */
export interface AgentUsage {
  tokens: AgentTokenUsage | null
  /** Charged per token (API key billing), as the runtime reports it. null = not billed per token, or unknown. */
  billedUsd: number | null
  /** What the same tokens would cost at the provider's API list prices: an estimate. null = unknown. */
  estimatedApiUsd: number | null
  /** How the runtime is paid for: "api" key, a subscription "plan", or "unknown" (e.g. migrated transcripts). */
  billing: AgentBilling | "unknown"
  /** Subscription-limit status (plan logins), when the runtime reports it. */
  subscription: PlanUsage | null
  /** true = reconciled to the runtime's own total (end of turn); false = live estimate mid-turn. */
  final: boolean
}

/** How a run (one user turn) ended. */
export interface AgentRunResult {
  /** Runtime's end reason ("success", "error_max_turns", "error_during_execution", …). */
  subtype: string
  isError: boolean
  /** Final text, or the errors. */
  text: string
  durationMs: number | null
  /** Model round trips in the turn. */
  turns: number | null
  usage: AgentUsage | null
  /** Turns still queued in the runtime after this one (0/undefined = nothing pending). */
  queued?: number | null
}

export type AgentEvent =
  /** The user's message started a run (one turn). The item is the user's bubble. */
  | {
      type: "run.started"
      input: { text: string; images?: AgentInputImage[]; annotations?: PointAnnotation[] }
      model?: string | null
      /** R11b: the profile frozen for this run. */
      profile?: { id: string | null; name: string; runtime: string; budgetUsd: number | null }
      /**
       * Sent while the designer was busy with another run: it hasn't read the message yet. An `input.status` for this
       * run follows when it does (or when Stop drops it).
       */
      queued?: boolean
    }
  /**
   * A queued message (run.started queued, same runId) reached the designer ("received": its turn started, or it was
   * steered into the running turn), or was dropped unread ("dropped": Stop, the session ended).
   */
  | { type: "input.status"; status: "received" | "dropped" }
  /** Streaming text/thinking (live only, never persisted). */
  | { type: "message.delta"; role: "assistant"; kind: "text" | "thinking"; delta: string; parentToolId?: string | null }
  /** A whole message block. Upserts the item (replaces streamed text). role "user": text the runtime echoed as the user's. */
  | { type: "message.completed"; role: "assistant" | "user"; kind: "text" | "thinking"; text: string; parentToolId?: string | null; stepId?: string | null }
  /**
   * A tool call began, or its details arrived (name, full input, streamed input fragment). Upserts by itemId (= the
   * call id); `inputDelta` frames are live only. `stepId` groups calls and text of one model step.
   */
  | { type: "tool.started"; name: string; input?: unknown; inputDelta?: string; parentToolId?: string | null; stepId?: string | null }
  | { type: "tool.completed"; isError: boolean; text: string; images: AgentImage[] }
  /** The agent is waiting on the user (also sent as agent.question for the dialog). */
  | { type: "question.requested"; requestId: string; questions: AgentQuestion[] }
  /** The runtime asks to allow a tool call (runtimes with permission callbacks; Claude's are decided by policy). */
  | { type: "permission.requested"; requestId: string; tool: string; input: unknown; reason?: string }
  /** Project files changed during a run (from the project watcher). */
  | { type: "artifact.changed"; paths: string[] }
  /** Usage/cost moved. Live estimates (final: false) aren't persisted. */
  | { type: "usage.updated"; usage: AgentUsage }
  | { type: "run.completed"; result: AgentRunResult }
  /** The run failed: a runtime error result, or the runtime itself (no `result`: the process died, no sandbox, …). */
  | { type: "run.failed"; error: string; result?: AgentRunResult }
  /** The user stopped the run. */
  | { type: "run.interrupted"; result?: AgentRunResult }
  /**
   * App/runtime notices: "Model switched…", "Context compacted", errors outside a run. `code` marks known ones
   * ("session.started" carries data.cwd / data.model).
   */
  | { type: "notice"; level: "info" | "error"; text: string; code?: string; data?: Record<string, unknown> }
  /** A runtime message the app doesn't understand: kept and shown as raw JSON. */
  | { type: "native"; message: unknown }

export type AgentEventType = AgentEvent["type"]

export interface AgentEventEnvelope {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION
  /** Unique within the session: "<seq>", or "<seq>.<k>" for the k-th event migrated from one legacy line. */
  eventId: string
  /** Per-session order (events migrated from one legacy line share its seq). */
  seq: number
  ts: string
  projectId: string
  sessionId: string
  /** App run (one user turn); null outside a run. */
  runId: string | null
  /** Stable id of the timeline item the event belongs to (message block, tool call id, …). */
  itemId: string | null
  /** Design revision last seen by the run (refreshed at run start, after each tool, at run end); null = unknown. */
  revision: string | null
  /** Runtime that produced it ("claude", …); "app" for the coordinator's own. */
  runtime: string
  event: AgentEvent
}

/** What a runtime can do; the UI disables what's missing. */
export interface AgentRuntimeCapabilities {
  images: boolean
  streaming: boolean
  appTools: boolean
  userQuestions: boolean
  permissionRequests: boolean
  resume: boolean
  fork: boolean
  modelSwitch: boolean
  /** "reported": the runtime reports cost; "tokens": tokens only; "none". */
  usage: "reported" | "tokens" | "none"
  /** Enforced by the runtime/OS, not by asking the model. */
  isolation: {
    workspaceWrites: boolean
    network: boolean
    /**
     * R11d. "full": the app's boundary (project-folder writes only, app-owned paths read-only, no network, printers only
     * through app tools) is enforced by the runtime/OS. "partial": some of it isn't (see `reason`); the app refuses
     * to start such a session unless the user turned it on explicitly. Absent = "full" when both flags are true.
     */
    level?: "full" | "partial"
    reason?: string
  }
}
export interface AgentRuntimeProbe {
  runtime: string
  installed: boolean
  version: string | null
  /** How it authenticates and whether that's known to work. "unknown" = not checked without spending tokens. */
  auth: { method: "api-key" | "login" | "none"; status: "ok" | "missing" | "unknown" }
  models: { value: string; label: string }[]
  capabilities: AgentRuntimeCapabilities
  detail?: string
  /** R11c (additive): sign-in details when the probe could read them cheaply (Claude: `claude auth status`). */
  login?: { plan?: string | null; fix?: SetupFix | null }
  /** R11c (additive): reasoning effort levels the runtime accepts (absent/empty = no effort control). */
  effortLevels?: AgentEffort[]
  /**
   * R11d: a session can start with the current settings (installed, signed in, isolation accepted). false + `detail`
   * = what to fix. Absent = not checked (treat as ready when installed and auth isn't "missing").
   */
  ready?: boolean
  /** The model used when none is chosen (the runtime's default), if known. */
  defaultModel?: string | null
}

// ---- Agent profiles (R11b) + the Agents screen (R11c). See shared/api.md "Agent profiles". ----
// A profile = which designer (runtime) the app runs, with what model, how it signs in, and limits. Profiles are
// non-secret and live in <STUDIO_HOME>/agent-profiles.json; API keys stay in the secret store (credentialRef).

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max"
/** How a profile pays: the user's own subscription login, or an API key (billed per token). */
export type AgentProfileAuth = { kind: "subscription" } | { kind: "api-key"; credentialRef: SecretRef }
export type AgentPolicyProfile = "design-sandbox"
/**
 * R11f: how the direct API runtime ("api") talks to its endpoint. "anthropic" = the Anthropic Messages API (tested);
 * "openai-chat" = an OpenAI-compatible Chat Completions endpoint (OpenAI, Ollama, LM Studio, …): tested only against a
 * scripted server, so endpoints are labelled "untested" until a connection test proves otherwise.
 */
export type ApiProtocol = "anthropic" | "openai-chat"

export interface AgentProfile {
  id: string
  /** Friendly name ("Claude", "Claude (work key)"). */
  name: string
  /** Runtime kind: "claude" now; "codex", "grok", "api" later. */
  runtime: string
  /** Model the profile uses; null = the runtime's default. */
  model: string | null
  auth: AgentProfileAuth
  /** Advanced: endpoint ref (direct API runtimes: the base URL) and a custom program path. null = automatic. */
  endpointRef?: string | null
  binaryPath?: string | null
  /** R11f, runtime "api": the wire protocol (null = "anthropic"). */
  apiProtocol?: ApiProtocol | null
  /** Reasoning effort, if the runtime supports it (AgentRuntimeProbe.effortLevels). null = runtime default. */
  effort?: AgentEffort | null
  /** Stop a run that costs more than this (USD: the billed amount with an API key, the estimate on a subscription). */
  budget: { maxUsdPerRun: number | null }
  policy: AgentPolicyProfile
  createdAt: string
  updatedAt: string
}

/** A profile as the API returns it: plus the masked status of its key (never the value). */
export interface AgentProfileView extends AgentProfile {
  credential: SecretStatus | null
  isDefault: boolean
}

/**
 * The effective profile frozen for a session/run: what it started with, even if the profile is edited or the
 * project's choice changes meanwhile. `source` = where the choice came from.
 */
export interface AgentProfileSnapshot {
  profileId: string | null
  name: string
  runtime: string
  model: string | null
  auth: AgentProfileAuth
  endpointRef: string | null
  binaryPath: string | null
  /** R11f (runtime "api"); absent/null = "anthropic". */
  apiProtocol?: ApiProtocol | null
  effort: AgentEffort | null
  budget: { maxUsdPerRun: number | null }
  policy: AgentPolicyProfile
  source: "project" | "default" | "legacy"
  frozenAt: string
}

/** Kept after importing settings.model + the Anthropic key ref into the first Claude profile (never the key). */
export interface AgentProfileMigration {
  at: string
  from: "settings"
  model: string | null
  credential: { ref: SecretRef; source: SecretSource | null } | null
  profileId: string
  verified: boolean
}

/** A runtime the Agents screen can show: registered ones (usable) and known ones not in this build yet. */
export interface AgentRuntimeInfo {
  kind: string
  label: string
  blurb: string
  /** Registered in this build: profiles can use it. false = "coming soon". */
  available: boolean
  authKinds: AgentProfileAuth["kind"][]
  /** Plain words per auth kind ("Your Claude Pro or Max plan", "Anthropic API key"). */
  subscriptionLabel?: string
  apiKeyLabel?: string
  /** Where to get an API key. */
  apiKeyUrl?: string
  homepage?: string
}

export interface AgentProfilesResponse {
  defaultProfileId: string
  profiles: AgentProfileView[]
  runtimes: AgentRuntimeInfo[]
  migration: AgentProfileMigration | null
}

/** One step of a connection test. */
export interface AgentConnectionStep {
  label: string
  ok: boolean | null
  detail?: string
}
export interface AgentConnectionResult {
  ok: boolean
  steps: AgentConnectionStep[]
  /** One plain sentence: what's wrong and what to do (or that it's ready). */
  summary: string
  fix?: SetupFix | null
  /** Only for "Send a test message": the reply and what it cost. */
  reply?: string
  costUsd?: number | null
  /** R11f: models the endpoint listed during the test (free), when the runtime discovers them per profile. */
  models?: { value: string; label: string }[]
}

/** R11f: GET /api/agent/profiles/:id/models — models discovered with the profile's key and endpoint (free call). */
export interface AgentModelList {
  models: { value: string; label: string }[]
  defaultModel: string | null
  /** Why the list couldn't be read (no key yet, endpoint down, key refused). */
  error?: string
}

/** A run that failed or was stopped (GET /api/agent/failures). */
export interface AgentFailure {
  ts: string
  projectId: string
  projectName: string | null
  sessionId: string
  runId: string | null
  profileId: string | null
  profileName: string | null
  runtime: string
  kind: "failed" | "budget" | "auth"
  error: string
}

/** The project's designer choice (per-project override of the default profile) and what it resolves to. */
export interface ProjectAgentChoice {
  /** The project's own pick; null = follow the default profile. */
  profileId: string | null
  /** The project's own model pick (for the effective runtime); null = the profile's model. */
  model: string | null
  effective: AgentProfileSnapshot
}

/**
 * R11d: Codex runtime settings (Settings.codex). Codex runs as `codex app-server` (JSON-RPC over stdio).
 * - login "app" (default): Crease's own Codex home (<STUDIO_HOME>/codex). Sign in once from the app
 *   (POST /api/agent/runtimes/codex/login); nothing from ~/.codex (config, rules, skills, plugins) is used. Full isolation.
 * - login "user": the Codex login already on this Mac (~/.codex). Crease overrides its config, but Codex still
 *   loads that home's command rules (rules/*.rules), which the app can't turn off or vet, so isolation is "partial"
 *   and a session starts only with `allowPartialIsolation: true`.
 * Model and effort come from the agent profile (AgentProfileSnapshot), like every runtime.
 */
export interface CodexRuntimeSettings {
  login?: "app" | "user"
  allowPartialIsolation?: boolean
}

/**
 * A browser sign-in the app started for a runtime's own home (Codex: ChatGPT; Grok: device code). The renderer shows
 * `code` big (the user types or checks it on the sign-in page) and polls GET /api/agent/runtimes/:kind/login until
 * `state` leaves "waiting". "idle" = none started since the server started.
 */
export interface RuntimeLoginStatus {
  state: "idle" | "waiting" | "done" | "failed"
  authUrl: string | null
  /** Device code to type or check on the sign-in page (Grok). null = none (Codex). */
  code: string | null
  /** Plain words when state is "failed". */
  error: string | null
}

/** R11d: a runtime asks to allow something the app's policy can't decide alone (plain words for the card). */
export interface AgentPermissionRequest {
  requestId: string
  projectId: string
  sessionId: string
  /** What is asked, e.g. "Write files outside the project folder". */
  title: string
  /** Plain-words details (command, paths). */
  detail: string
  /** Native request kind, for diagnostics ("permissions", "command", "fileChange"). */
  tool: string
  createdAt: string
}

// All WebSocket events from server -> renderer.
// Questions the agent asks the user (Claude Code's AskUserQuestion tool, bridged to the UI).
export interface AgentQuestionOption {
  label: string
  description: string
  preview?: string // self-contained HTML fragment (render in a sandboxed iframe, no scripts)
}
export interface AgentQuestion {
  question: string
  header: string
  options: AgentQuestionOption[] // 2-4; by convention the first is "(Recommended)"
  multiSelect: boolean
}
export interface AgentQuestionRequest {
  requestId: string
  projectId: string
  sessionId: string
  questions: AgentQuestion[]
  createdAt: string
  /**
   * The designer stopped while this waits (the user pressed Pause, or the runtime ended its turn without the
   * answer). The card stays; answering it, or any new message, sends the reply as the user's next message.
   */
  paused?: boolean
}
/** question text -> answer (an option label, comma-separated labels for multiSelect, or free text) */
export type AgentAnswers = Record<string, string>

// Claude plan usage from the SDK's rate_limit_event (account-wide, subscription logins only).
export interface PlanUsageWindow {
  utilization: number // 0..1
  resetsAt: number | null // epoch seconds
}
export interface PlanUsage {
  status: "allowed" | "allowed_warning" | "rejected"
  fiveHour: PlanUsageWindow | null
  sevenDay: PlanUsageWindow | null
  updatedAt: string
}
/** "api": billed per token via the stored Anthropic API key (costs are real). "plan": claude.ai login (costs are estimates). */
export type AgentBilling = "plan" | "api"

export type ServerEvent =
  // Legacy: raw runtime messages (no longer emitted; GET …/agent/timeline still serves them for diagnostics/evals).
  | ({ type: "agent" } & AgentEnvelope)
  // Normalized agent events (R11a): what the timeline renders.
  | ({ type: "agent.event" } & AgentEventEnvelope)
  | { type: "agent.status"; projectId: string; running: boolean; sessionId: string | null; costUsd: number }
  | { type: "agent.question"; request: AgentQuestionRequest }
  | { type: "agent.usage"; billing: AgentBilling; usage: PlanUsage | null }
  // R11b/c: agent profiles, the default or a project's choice changed (refetch GET /api/agent/profiles); a run failed.
  | { type: "agent.profiles.changed" }
  | { type: "agent.failure"; failure: AgentFailure }
  | { type: "agent.question.resolved"; projectId: string; requestId: string; answers: AgentAnswers | null }
  // R11d: permission requests (runtimes with permission callbacks): a card in the chat, answered via POST …/agent/permission.
  | { type: "agent.permission"; request: AgentPermissionRequest }
  | { type: "agent.permission.resolved"; projectId: string; requestId: string; allowed: boolean | null }
  | { type: "project.changed"; projectId: string; paths: string[] }
  // U2: a version was saved outside an agent turn (a settled burst of slider edits): refetch the versions list
  | { type: "versions.changed"; projectId: string }
  | { type: "render.started"; projectId: string; partId: string }
  | { type: "render.done"; projectId: string; result: RenderResult }
  | { type: "check.done"; projectId: string; report: CheckReport }
  | { type: "slice.done"; projectId: string; result: SliceResult }
  | { type: "printer.status"; status: PrinterStatus }
  | { type: "print.request"; request: PrintRequest }
  | { type: "print.request.resolved"; requestId: string; approved: boolean }
  // A project's print jobs changed (new slice, request, start, finish, reject), or its files were restored / switched
  // to another idea. Staleness is computed on GET /api/projects/:id/jobs and /validity: refetch both (and after
  // project.changed).
  | { type: "jobs.changed"; projectId: string }
  // A logged print ended (printer reported complete/cancelled/error, or we lost track of it -> "error").
  // The UI prompts for a result and POSTs it to /api/prints/:printId.
  // practice: printed on the built-in practice printer (no rating card; the UI offers an optional "Rate it" link)
  | { type: "print.finished"; printId: string; projectId: string; state: PrintJobState; message?: string | null; practice?: boolean }
  // A print record's outcome / lesson changed (R15): refetch outcomes, calibration and lessons.
  | { type: "prints.changed"; projectId: string; printId: string; machineId: string | null }
  // Server asks an open app window for one camera frame (WebRTC cameras only stream to a browser). The renderer
  // answers with POST /api/camera/captures/:requestId {dataUrl} or {error}.
  | { type: "camera.capture.request"; requestId: string; machineId: string }

// ---- Event sync (R08): sequenced WS events, replay, snapshot (see shared/api.md "WebSocket") ----

/** Every ServerEvent on /ws carries `eventSeq`: per server instance, strictly increasing by 1. */
export type SequencedEvent = ServerEvent & { eventSeq: number }

/** First frame on every /ws connection. The client connects with ?since=<last eventSeq>&instance=<instanceId>. */
export interface WsHello {
  type: "ws.hello"
  instanceId: string // new per server start; a different one means "everything you hold may be stale"
  eventSeq: number // the latest seq at connect time (replayed events, if any, follow this frame)
  // replay: missed events (since < seq <= eventSeq) follow, in order, then live ones.
  // snapshot: nothing replayed (server restarted, gap evicted, or a seq from the future): GET /api/sync/snapshot.
  // fresh: no cursor given (first connect): load state normally, then follow live events.
  resume: "replay" | "snapshot" | "fresh"
  replayed: number
}
/** Liveness frame every ~15 s; a client that hears nothing for longer assumes a dead socket (sleep/wake) and reconnects. */
export interface WsPing {
  type: "ws.ping"
  eventSeq: number
  instanceId: string
}
export type WsControl = WsHello | WsPing

export interface AgentStatusInfo {
  projectId: string
  running: boolean
  sessionId: string | null
  costUsd: number
}

/** Everything a client needs to reconcile after a gap (GET /api/sync/snapshot?projectId=). */
/**
 * R09: a project's own assistant settings (GET /api/projects/:id/agent-config), project-relative paths.
 * enabled = trusted and in place; pending = present but untrusted (moved aside at the next session start);
 * disabled = moved aside to .studio/agent-config-disabled/ until the user turns them on.
 */
export interface AgentConfigStatus {
  enabled: string[]
  pending: string[]
  disabled: string[]
}

/** A finished print still waiting for "How did it turn out?" (SyncSnapshot.unratedPrints). */
export interface UnratedPrint {
  printId: string
  projectId: string
  state: PrintJobState
  finishedAt: string
}

export interface SyncSnapshot {
  instanceId: string
  eventSeq: number // state reflects every event up to and including this seq
  takenAt: string
  printRequests: PrintRequest[] // all pending print dialogs (each carries its job)
  questions: AgentQuestionRequest[] // all pending AskUserQuestion rounds, every project
  agents: AgentStatusInfo[] // live agent sessions (running or idle-but-open), every project
  machines: MachineWithStatus[] // last polled status (never polls a printer)
  /**
   * Finished prints (complete/cancelled/error) from the last 48 h nobody has rated yet, newest first (≤ 5): a
   * print.finished missed while offline still brings up the "How did it turn out?" card. Older clients ignore it.
   */
  unratedPrints?: UnratedPrint[]
  project: null | {
    project: Project
    agent: AgentStatusInfo
    assembly: AssemblyInfo | null
    jobs: ProjectJobs | null
  }
  projectError?: string
}

// ---- Catalog (SQLite index over the project folders; see shared/api.md "Catalog") ----

export type PrintJobState = "printing" | "complete" | "cancelled" | "error"
export type PrintResult = "success" | "failed" | null // user-reported outcome (prompted after a print)

export interface PrintRecord {
  id: string
  projectId: string
  machineId?: string | null // Machine it printed on (null for records from before Machines)
  printerMessage?: string | null // why the printer ended it, when it says (or we can tell), e.g. an early cancel
  partIds: string[]
  gcodeName: string
  printerFilename: string | null // name on the printer (Moonraker gcodes root)
  startedAt: string
  finishedAt: string | null
  state: PrintJobState
  result: PrintResult
  notes: string | null
  estimatedTimeS: number | null
  filamentG: number | null
  jobId?: string | null // the immutable PrintJob it printed (R15; null for records from before jobs)
  actualDurationS?: number | null // how long it really took, start to end (R15 time calibration)
  scope?: CalibrationScope | null // printer + nozzle + material + intent it printed with (from the job)
  outcome?: PrintOutcome | null // structured feedback (R15); `result`/`notes` mirror it for older readers
  practice?: boolean // printed on the built-in practice printer (set by the API; nothing to rate)
}

export interface CatalogProject {
  id: string
  name: string
  tags: string[]
  createdAt: string
  updatedAt: string
  thumbnailUrl: string | null
  license: string | null
  source: null | { importId: string }
  partCount: number
  sessionCount: number
  lastPrint: (Pick<PrintRecord, "id" | "state" | "result" | "startedAt" | "finishedAt"> & { practice?: boolean }) | null
}

export interface CatalogSession {
  id: string
  projectId: string
  title: string
  forkedFrom: string | null
  createdAt: string | null
  lastMessageAt: string | null
  costUsd: number
  messageCount: number
  firstPrompt: string | null
}

export type CatalogSort = "updated" | "created" | "name" | "printed"

export interface Webcam {
  name: string
  service: string | null
  enabled: boolean
  streamUrl: string | null // as reported by Moonraker (may be relative to the printer's web frontend)
  snapshotUrl: string | null
  rotation: number
  flipHorizontal: boolean
  flipVertical: boolean
}

// ---- Assembly guides (assembly.json; see SPEC "Assembly guides" and the assembly-guide skill) ----

export type HardwareType =
  | "screw"
  | "bolt"
  | "nut"
  | "washer"
  | "heat-set-insert"
  | "threaded-insert"
  | "magnet"
  | "spring"
  | "bearing"
  | "rod"
  | "dowel-pin"
  | "standoff"
  | "o-ring"
  | "rubber-foot"
  | "wall-anchor" // plastic wall plug; size "6x30" (dia x length)
  | "filament-offcut" // make-it-yourself: a piece cut from the user's filament (pins, axles); size "1.75x40" (dia x length). No store links
  | "adhesive-strip" // double-sided mounting strip / pad; size "20x50" (width x length) mm
  | "zip-tie"
  | "glue"
  | "tape"
  | "electronics"
  | "other"

export type ScrewHead = "socket" | "button" | "countersunk" | "pan" | "hex" | "flange" | "cheese" | "grub"
export type ScrewDrive = "hex" | "torx" | "phillips" | "pozidriv" | "slot" | "none"

export interface SpringSpec {
  kind: "compression" | "extension" | "torsion"
  wireDiaMm: number
  outerDiaMm: number
  freeLengthMm: number
  rateNPerMm?: number // spring rate if known
  solidLengthMm?: number
  material?: string // e.g. "music wire", "stainless 302"
}

export interface BearingSpec {
  designation: string // e.g. "608", "623", "MR85"
  boreMm: number
  outerDiaMm: number
  widthMm: number
  seal?: string // "2RS" | "ZZ" | "open"
}

export interface MagnetSpec {
  shape: "disc" | "block" | "ring"
  diaMm?: number // disc/ring
  lengthMm?: number // block
  widthMm?: number // block
  thicknessMm: number
  grade?: string // e.g. "N52"
}

export interface AssemblyHardware {
  id: string // referenced from steps[].adds; must not clash with a part id
  type: HardwareType
  qty: number
  name?: string // generated from type/size/standard if omitted
  standard?: string // e.g. "ISO 7380", "DIN 912", "ISO 4762", "ISO 4032", "ISO 7089"
  size?: string // e.g. "M3x10", "M3", "608", "6x3 mm"
  threadMm?: number // nominal thread / shaft diameter (parsed from size if omitted)
  lengthMm?: number // screw length per standard (under head; total for countersunk)
  head?: ScrewHead
  drive?: ScrewDrive
  material?: string // e.g. "A2 stainless", "steel 12.9 black oxide", "brass"
  purchaseHint?: string // generic search term, e.g. "M3x10 button head screw ISO 7380 A2"
  notes?: string
  color?: string // render colour override (defaults by type: steel / brass / black)
  spring?: SpringSpec
  bearing?: BearingSpec
  magnet?: MagnetSpec
  listings?: HardwareListing[] // specific listings the agent actually opened (only on request)
  /** Other sizes that also work here, only when the design allows it (e.g. an M3x10 where the hole is deep enough for
   *  M3x12). Written by the agent from the design; never guessed by the app. */
  substitutes?: HardwareSubstitute[]
  /** Dimensional compatibility note for buyers ("hole is 6.2 mm across, 3.2 mm deep: 6x3 discs only"). */
  fit?: string
}

export interface HardwareSubstitute {
  size: string // e.g. "M3x10"
  purchaseHint?: string // search term for the substitute
  note?: string // why it works / what to watch ("1 mm shorter: still 4 threads engaged")
}

/** A specific product page found and opened by the agent. Never invented. */
export interface HardwareListing {
  store: string // e.g. "Amazon", "McMaster-Carr"
  title: string // listing title as shown on the page
  url: string // https
  partNumber?: string // as shown on the page (e.g. McMaster 92095A179, ASIN)
  price?: string // as shown, with currency and pack size, e.g. "$8.99 / 100 pcs"
  packSize?: number
  retrievedAt: string // YYYY-MM-DD the page was opened
}

export type AssemblyToolType =
  | "hex-key"
  | "screwdriver"
  | "soldering-iron"
  | "pliers"
  | "wrench"
  | "knife"
  | "file"
  | "clamp"
  | "drill"
  | "tweezers"
  | "other"

export interface AssemblyTool {
  id: string
  type: AssemblyToolType
  name: string // e.g. "2 mm hex key"
  size?: string // e.g. "2 mm", "PH1", "T10"
  notes?: string
}

export interface AssemblyConsumable {
  id: string
  name: string // e.g. "Superglue (CA)"
  qty?: string // free text: "a few drops"
  purchaseHint?: string
  notes?: string
}

export interface AssemblyPart {
  id: string // part id (parts/<id>.scad)
  qty: number
  color: string // filament colour name or #hex
  name?: string
  notes?: string
}

export interface AssemblyStepItem {
  id: string // part, hardware or consumable id
  qty: number
}

export interface AssemblyStep {
  n: number // 1-based, consecutive
  title: string
  adds: (string | AssemblyStepItem)[] // bare id = all of that item (when only one step adds it)
  explodeDirection?: [number, number, number] // default [0,0,1]
  explodeDistance?: number // mm the new items are pulled back at explode = 1 (default 30)
  view?: [number, number, number] // camera rotation [rx, ry, rz] in degrees; default iso [55, 0, 25]
  text: string // 1-2 short sentences
  warnings?: string[]
  tips?: string[]
  tools?: string[] // tool ids used in this step
  check?: string // "You got it right when…": what the builder sees/feels if this step is correct
  showMotion?: string // AssemblyMotion id to demonstrate at the end of this step
  // ---- R14 step illustrations (all optional; the art falls back to sensible defaults) ----
  /** What the hands do, drawn as the arrow type: place/insert = straight arrow; slide = arrow with speed lines;
   *  push = arrow with press marks; snap = arrow with "click" marks; twist = curved arrow about the insert axis;
   *  screw = straight + curved arrow. Default: screw for screws/bolts, push for magnets/inserts/feet, insert otherwise. */
  action?: StepAction
  /** Direction the new items travel to go in (assembled coordinates). Default: -explodeDirection when given, else a
   *  placed hardware item's own axis (head-up frame: it goes in along its -Z), else inferred from the placements. */
  insert?: [number, number, number]
  /** Where glue goes, and where it must not (hatched in the picture). */
  glue?: AssemblyGlueRegion[]
  /** Close-up inset of the joint: true = always, false = never, {at, size} = around this region (mm).
   *  Default: automatic when the new items are small compared to the whole assembly. */
  closeUp?: boolean | { at: [number, number, number]; size?: number }
  /** Part refs ("lid", "clip#1") the step acts on when it adds nothing new (e.g. "Click it shut" -> ["lid"]):
   *  highlighted and labelled, with the step's action arrow drawn on them. */
  focus?: string[]
}

export type StepAction = "place" | "insert" | "slide" | "push" | "snap" | "twist" | "screw"

/** A glue / no-glue region: an axis-aligned box in assembled coordinates (one side can be ~0 for a face patch). */
export interface AssemblyGlueRegion {
  kind: "glue" | "no-glue"
  at: [number, number, number] // centre, mm (assembled position)
  size: [number, number, number] // mm
  part?: string // part or hardware ref ("handle", "pin#0"): the region moves with it while it is exploded
  label?: string // short words: "a drop in each hole", "keep the middle loops dry"
}

export interface Assembly {
  title?: string
  summary?: string
  timeMinutes?: number
  parts: AssemblyPart[]
  hardware: AssemblyHardware[]
  tools: AssemblyTool[]
  consumables: AssemblyConsumable[]
  steps: AssemblyStep[]
  /** Where each printed part sits in the finished build (mm / degrees, applied rotate-then-translate
   *  to the part's own exported mesh). One entry per instance; omit instance for qty-1 parts. */
  placements?: AssemblyPlacement[]
  /** Everything that moves once assembled: hinges, sliders, rotating parts, springs, latches. */
  motions?: AssemblyMotion[]
  /** Where bought hardware sits in the finished build, so check_motion can include it as simple collision shapes
   *  (screws/pins as cylinders, magnets as discs, bearings as rings...). Optional; hardware without one is not checked. */
  hardwarePlacements?: AssemblyHardwarePlacement[]
}

/** Hardware item in the finished build. Its own frame: standing upright on z = 0, centred on the Z axis
 *  (a screw stands head-up: shank from z = 0 to its length, head above). Applied rotate-then-translate like parts. */
export interface AssemblyHardwarePlacement {
  hardware: string // AssemblyHardware id
  instance?: number // 0-based, for hardware with qty > 1
  translate: [number, number, number] // mm
  rotate?: [number, number, number] // degrees about X, Y, Z (applied in that order, before translate)
  movesWith?: string // part id or "part#instance" whose motions carry this item (a screw in the lid moves with the lid)
}

export interface AssemblyPlacement {
  part: string // AssemblyPart id
  instance?: number // 0-based, for parts with qty > 1
  translate: [number, number, number] // mm
  rotate?: [number, number, number] // degrees about X, Y, Z (applied in that order, before translate)
}

export interface AssemblyMotion {
  id: string
  label: string // plain words a beginner understands: "Lid opens", "Drawer slides out", "Top spins"
  type: "rotate" | "translate"
  parts: string[] // part ids (or "part#instance") that move together. A part in several motions: applied in assembly.motions order, first listed first
  axis: [number, number, number] // unit vector in assembly coordinates
  origin?: [number, number, number] // pivot point for rotate (mm), assembly coordinates
  range: [number, number] // degrees for rotate, mm for translate, relative to the placed pose
  rest?: number // pose shown by default (defaults to range[0])
  continuous?: boolean // e.g. a spinning base: animate as a loop
  check?: string // "how you know it's right": "Swings open to about 110° without rubbing and clicks shut"
}

// ---- check_motion (POST /api/projects/:id/assembly/check-motion; server/assembly/motion.ts) ----
/** ok = no collisions found in the checked positions; problems = collisions; incomplete = some geometry could not be
 *  checked (missing placement, part failed to load, not a closed solid...), so a pass can't be claimed. */
export type MotionCheckStatus = "ok" | "problems" | "incomplete"

export interface MotionCollision {
  a: string // instance key, e.g. "lid", "clip#1", "screw#0"
  b: string
  volumeMm3: number
}

export interface MotionCoverage {
  from: number // range checked (degrees or mm)
  to: number
  positions: number // poses actually checked (coarse + refined)
  coarse: number // evenly spaced first pass
  refined: number // extra poses added near close calls and sharp clearance drops
  smallestStep: number // finest spacing used between neighbouring poses
  capped: boolean // the pose budget ran out before every gap between poses was narrow enough
}

export interface MotionReport {
  id: string
  label: string
  unit: "°" | "mm"
  samples: number[] // values checked, sorted
  ok: boolean // no collisions found in the checked positions (see coverage)
  /** Per colliding pair: the values where they overlap (beyond what already overlaps at rest). */
  collisions: { a: string; b: string; atValues: number[]; maxVolumeMm3: number; worstAt: number }[]
  /** Smallest gap between the moving parts and everything else (pairs resting against each other excluded). */
  minClearanceMm: number | null
  clearancePair: [string, string] | null
  clearanceAt: number | null // motion value where the smallest gap was found
  freeRange: [number, number] | null // longest collision-free run of samples that includes the rest pose
  coverage: MotionCoverage
  text: string // one plain-language line with the scope, e.g. "No collisions found in 24 positions from 0° to 90°"
}

/** Two motions posed together (each at an end of its range); every other motion at rest. */
export interface MotionScenario {
  values: { id: string; value: number }[]
  label: string // "Lid opens at 110° + Latch at 30°"
  ok: boolean
  collisions: MotionCollision[]
}

export interface MotionCheckScope {
  parts: string[] // part instances included
  hardware: string[] // hardware instances included as simple shapes
  skipped: { id: string; reason: string }[] // instances not included, with a plain reason
}

export interface MotionCheck {
  ok: boolean // status === "ok"
  status: MotionCheckStatus
  incomplete: string[] // plain reasons the check could not cover everything (non-empty => not ok)
  restCollisions: MotionCollision[] // parts overlapping in the assembled (rest) pose
  motions: MotionReport[]
  combined: MotionScenario[] // selected combinations of motions that can happen together
  scope: MotionCheckScope
  notChecked: string[] // what this check never covers: strength, friction, spring force...
  warnings: string[]
  summary: string // plain-language summary for the agent
  checkedAt?: string // ISO time (persisted checks)
  stale?: boolean // the assembly or a part changed since this check (GET /assembly)
  staleReasons?: string[] // R07: what changed, in plain words ("lib/params.scad changed")
}

export interface AssemblyInfo {
  assembly: Assembly | null // null when the project has no assembly.json
  error?: string // assembly.json exists but is invalid
  hasScad: boolean // assembly.scad exists
  guideUrl: string | null // /api/projects/:id/artifacts/build/assembly-guide.html?v=<mtime> if built
  stepImages: { n: number; url: string }[] // renders/assembly-step-<n>.png that exist
  shoppingListUrl: string | null // build/shopping-list.md if built (also .csv next to it)
  // Mesh per printed part for the assembled-scene viewer (apply placements + motions client-side):
  // build/<id>.view.3mf (colours) when present, else build/<id>.3mf, else build/<id>.stl.
  partModels: Record<string, string>
  motionCheck?: MotionCheck | null // last check_motion result (build/motion-check.json), with `stale`
  /** R14: geometry-based step illustrations from the last guide build / step render (build/assembly-art.json);
   *  null when the guide uses assembly.scad renders (a part or drawable hardware item has no placement) or none yet. */
  art?: AssemblyArt | null
}

// ---- R14 step illustrations (server/assembly/illustrate.ts) ----
// One plan per step, in assembled coordinates (mm). The printable guide projects it onto the step's PNG as an SVG
// overlay; the Assembly tab's 3D step-through draws the same arrows, callouts and regions with three.js.
export type Vec3 = [number, number, number]

export interface ArtInstance {
  key: string // "lid#0", "magnet#2"
  kind: "part" | "hardware"
  id: string // part / hardware id
  index: number // 0-based instance
  /** Printed parts: "A", "B", … over assembly.json parts in order, copies in order (the plate letters when a plate
   *  is sliced from the assembly's parts list in the same order). */
  letter?: string
  role: "new" | "done" | "focus" | "hidden"
  offset: Vec3 // exploded displacement of a new item (zero when it stays put)
  box?: { min: Vec3; max: Vec3 } // hardware: bounds at its final position (the 3D view draws bought items as simple shapes)
}

export interface ArtArrow {
  kind: StepAction
  from: Vec3 // tail
  to: Vec3 // tip of the straight part
  axis?: Vec3 // twist / screw: rotation axis (unit) through `center`
  center?: Vec3
  radius?: number // mm, twist / screw arc
  targets: string[] // instance keys the arrow moves
}

export interface ArtCallout {
  label: string // "Lid", "4× Magnet 6 × 3 mm"
  letters?: string // "A", "C–F" (printed parts)
  qty?: number // hardware: how many this step adds ("4×")
  tone: "new" | "context" // context = an earlier part the new ones go into (grey)
  anchors: { key: string; point: Vec3 }[] // a visible point on each instance, at its FINAL position (add offset × explode)
  labelAt: Vec3 // where the label sits in 3D: near its parts, placed clear of the other labels in the art camera's view (not the print gutters)
}

export interface ArtGlue extends AssemblyGlueRegion {
  min: Vec3 // final position; add the owning instance's offset × explode
  max: Vec3
  ownerKey?: string
  labelAt?: Vec3 // where its label sits in 3D (same spot as on the printed step, clear of the other labels); add offset × explode
}

export interface ArtCamera {
  dir: Vec3 // unit vector from the scene toward the eye (orthographic in print)
  up: Vec3
  target: Vec3 // centre of the framed geometry
  auto: boolean // chosen automatically (false: the step's `view`)
}

export interface StepArt {
  n: number // 0 = finished assembly
  camera: ArtCamera
  instances: ArtInstance[]
  arrows: ArtArrow[]
  callouts: ArtCallout[]
  glue: ArtGlue[]
  closeUp: { center: Vec3; radius: number } | null
  image: string // project-relative: renders/assembly-step-<n>.png (raster + overlay composited)
  svg: string // project-relative: renders/assembly-step-<n>.svg (raster + vector overlay)
}

export interface AssemblyArt {
  version: number
  hash: string // of the inputs it was drawn from
  steps: StepArt[]
}

// Models offered in the agent panel's switcher. Values are Claude Code model aliases, so they
// track the latest model of each family. Settings.model holds the chosen value (default "opus").
export const AGENT_MODELS = [
  { value: "opus", label: "Opus", hint: "Best designs (default)" },
  { value: "sonnet", label: "Sonnet", hint: "Faster, cheaper" },
  { value: "haiku", label: "Haiku", hint: "Quick edits, cheapest" },
] as const

// ---- Plate slicing: several parts arranged together (POST /api/projects/:id/slice-plate) ----
export interface PlateObject {
  partId: string
  center: [number, number] | null // bed XY (mm) chosen by OrcaSlicer's arrange
  // R13 (additive): which entry/copy it is and its letter on the plate set (see PlacedObject)
  name?: string
  entry?: number | null
  instance?: number
  label?: string
}

/**
 * R13: one object OrcaSlicer placed on a plate (its EXCLUDE_OBJECT_DEFINE line), mapped back to the part.
 * Bed coordinates are mm with (0,0) at the FRONT-LEFT corner of the bed, +X to the right, +Y toward the back.
 */
export interface PlacedObject {
  name: string // EXCLUDE_OBJECT name in the G-code, e.g. "tag-a.stl_id_1_copy_0"
  partId: string
  entry: number | null // index into the job's parts[] (which copy/variant, incl. its per-part overrides); null = unknown
  instance: number // 1-based copy of that entry (qty > 1)
  label: string // "A", "B", … in parts[] order (entry 0 copy 1 = A); unique across a job's plates
  center: [number, number] // bed mm (EXCLUDE_OBJECT CENTER)
  polygon: [number, number][] // footprint hull, bed mm
  rotationDeg: number | null // rotation about Z the slicer applied to the part's own mesh (null: couldn't tell)
  translate: [number, number] | null // bed XY = rotate(part XY, rotationDeg) + translate; Z: dropped onto the bed
  overrides?: Record<string, string | number | boolean> // the entry's per-part settings (variants on a test plate)
}

/** GET /api/projects/:id/jobs/:jobId/placement: where every object of a sliced plate sits (from its G-code snapshot). */
export interface PlatePlacement {
  jobId: string
  kind: "part" | "plate"
  plate: number // 1-based
  plateCount: number
  bedMm: [number, number] // printable area width (X) x depth (Y)
  front: "-y" // the printer's front edge is bed Y = 0
  objects: PlacedObject[]
  /** "slice": recorded when it was sliced (mesh fitted then); "gcode": re-read from the snapshot (fitted to today's mesh) */
  source: "slice" | "gcode"
}
export interface PlateGcode {
  plate: number // 1-based
  gcodePath: string // e.g. "build/plate.gcode" (single plate) or "build/plate-2.gcode"
  gcodeName: string
  estimatedTimeS: number | null
  filamentG: number | null
  filamentMm: number | null
  objects: PlateObject[]
  filamentBySlot?: SlotUsage[]
  colorChanges?: number | null
  machineId?: string // farm split: the machine this plate is assigned to (request_print it there)
  preview?: SlicePreviewSummary
  jobId?: string // immutable print job of this plate (sha256 of the G-code bytes)
}
export interface PlateSliceResult {
  plates: PlateGcode[]
  parts: { partId: string; qty: number; overrides?: Record<string, string | number | boolean> }[] // overrides: per-part process settings
  estimatedTimeS: number | null // sum over plates
  filamentG: number | null
  filamentMm: number | null
  durationMs: number
  filamentBySlot?: SlotUsage[] // summed over plates (multicolour only)
  colorChanges?: number | null
  machineId?: string // machine (slicer profile) the plates were sliced for
  warnings?: string[] // e.g. generic slicer profile, machines skipped in a farm split
  intent?: PrintIntent
  overrides?: Record<string, string | number | boolean>
  colorPlan?: ColorPlan // plates whose single-colour parts use different colours: how the colours are printed
}

/**
 * How a plate of single-colour parts in different colours is printed (slicePlate compares, picks the cheapest safe one):
 * - "swaps": one plate, every layer swaps colour (purge each time) — the fallback
 * - "by_object": one plate, OrcaSlicer "print by object": each part printed whole, shortest first (one swap per part);
 *   only when the parts clear the print head (OrcaSlicer's own height/spacing check passes)
 * - "per_colour": one plate per colour, no swaps (clear the bed between plates)
 */
export type ColorPlanStrategy = "swaps" | "by_object" | "per_colour"

export interface ColorPlanOption {
  strategy: ColorPlanStrategy
  ok: boolean // false = not safe / OrcaSlicer refused (reason says why)
  reason?: string
  plates?: number
  estimatedTimeS?: number | null
  filamentG?: number | null
  colorChanges?: number | null
}

export interface ColorPlan {
  chosen: ColorPlanStrategy
  summary: string // plain words, e.g. "Printing them one colour at a time saves 50 min and 8 g …"
  options: ColorPlanOption[]
}

// ---- Machines (printer farm support). One entry per physical printer. ----
// Today the server exposes the single configured printer as one Machine (see server/machines.ts);
// the Machines section will store a list. Code that needs printer limits, filaments, tolerances or a
// connection should take a Machine, not read Settings.printer directly.
export interface Machine {
  id: string // slug, e.g. "sparkx-i7-1"
  name: string // user's name for it, e.g. "Garage i7"
  model: string // e.g. "Creality SPARKX i7"
  slicerProfile: string // OrcaSlicer machine profile key (resources/slicer-profiles/<key>/), e.g. "sparkx-i7"
  buildVolumeMm: [number, number, number]
  nozzleMm: number
  /** Printing parts one after another ("by object") was watched and is safe on this printer: the profile's print-head
   *  clearance is right, so the head never hits a finished part. Off until the user confirms it (practice printer: always). */
  sequentialPrintOk?: boolean
  maxNozzleC: number
  maxBedC?: number
  enclosed?: boolean
  filamentSlots: number // 1 = single extruder, 4 = CFS
  filaments: FilamentSlot[]
  filamentsConfirmed: boolean
  filamentsSource?: "user" | "printer" // "printer": read from the printer (Creality CFS), kept in sync while connected
  tolerances: { slidingFitMm: number | null; pressFitMm: number | null; holeCompensationMm: number | null }
  connection:
    | {
        type: "moonraker"
        host: string
        port: number
        /** Write-only (POST/PUT /api/machines): a string stores it as secret "machine.<id>.apiKey", null removes it,
         *  absent leaves it unchanged. Never stored in machines.json, never returned. */
        apiKey?: string | null
        /** Read-only: masked status of the Moonraker API key (filled in by the server). */
        apiKeyStatus?: SecretStatus
        crealityWsPort?: number | null // Creality firmware's own push API (listen-only): default 9999; 0 = don't use
        /** "Start prints through Creality's own service (experimental)": upload via Moonraker as usual, then start
         *  the job over the :9999 websocket so the touchscreen tracks it. Default off (Moonraker start). Not yet
         *  run on real hardware — see docs/printer-bringup.md "Supervised test: Creality start". */
        crealityStart?: boolean
        /** How the live camera (WebRTC) finds a network path. Default (absent) = "auto". See CameraIce. */
        cameraIce?: CameraIce
      }
    | { type: "none" }
  enabled: boolean // available for jobs
  isDefault: boolean
  tags?: string[] // farms: location, material speciality, etc.
  notes?: string
  isPractice?: boolean // the built-in simulated printer (connection is served in-process)
  camera?: MachineCamera // auto-detected while connected
}

/**
 * WebRTC camera ICE settings (Creality :8000 cameras).
 *  - "auto": printers on a LAN address use no STUN server (host candidates only; the server swaps the browser's
 *    mDNS host names for this computer's LAN address). If no picture arrives, retry once with `stunServers`
 *    (default Google's public STUN) and say so in the camera view.
 *  - "local": host candidates only, never contact a STUN server.
 *  - "custom": always use `stunServers`.
 */
export interface CameraIce {
  mode: "auto" | "local" | "custom"
  stunServers?: string[] // e.g. ["stun:stun.l.google.com:19302"]; used by "custom" and as the "auto" fallback
}

// ---------- Printer support matrix (shared/printer-support.ts; docs/printer-support.md is generated from it) ----------

/**
 * How far a capability is proven for a printer family:
 *  verified = done on real hardware (so far only the SPARKX i7) · simulated = only exercised in software (the
 *  practice printer / OrcaSlicer CLI), never on that hardware · untested = expected to work, never tried ·
 *  unsupported = Crease can't do it for this printer.
 */
export type SupportLevel = "verified" | "simulated" | "untested" | "unsupported"
/** slicing = a slicer preset · export = save the print file and print it by hand · send = upload + start/pause/
 *  cancel + status via Moonraker · slots = multi-colour material slots (Creality CFS) · creality = Creality-specific
 *  job tracking (:9999 websocket, touchscreen) · camera = live view / snapshots. */
export type SupportCapability = "slicing" | "export" | "send" | "slots" | "creality" | "camera"
export interface CapabilitySupport {
  level: SupportLevel
  note: string
}
export interface PrinterFamilySupport {
  id: string
  family: string // e.g. "Creality SPARKX i7"
  examples: string // models it covers, for the doc
  verifiedOn: string | null // the physical printer the "verified" levels come from
  caps: Record<SupportCapability, CapabilitySupport>
}

/** An entry of the Add-machine model catalogue (GET /api/machines/models), from OrcaSlicer's bundled profiles. */
export interface MachineModel {
  vendor: string // e.g. "Creality"
  model: string // e.g. "Creality K1"
  preset: string // OrcaSlicer machine preset used for slicing, e.g. "Creality K1 (0.4 nozzle)"
  slicerProfile: string // value for Machine.slicerProfile
  buildVolumeMm: [number, number, number] | null
  nozzleMm: number[]
  klipper: boolean // gcode_flavor klipper (Moonraker-capable)
}

/** A Machine plus its live status, as listed by GET /api/machines. */
export interface MachineWithStatus extends Machine {
  status: PrinterStatus | null // null when connection.type is "none" or not yet polled
  isPractice?: boolean // built-in practice printer (simulated)
}

/** How a machine's camera can be watched. */
export interface MachineCamera {
  // creality-webrtc: Creality firmware's WebRTC on :8000 (offer/answer via POST /api/machines/:id/camera/webrtc)
  // moonraker: a webcam listed by Moonraker (snapshot via /api/machines/:id/snapshot) · mjpeg: mjpg-streamer
  type: "creality-webrtc" | "mjpeg" | "moonraker" | "none"
  url?: string | null // signalling base (creality-webrtc) or stream/snapshot URL
  detectedAt?: string
}

// ---- Print intent + sliced-toolpath preview / quality (see shared/api.md "Slice preview") ----
/** A named set of slicer settings chosen for the job. "standard" = the machine's stock process profile. */
export type PrintIntent = "display" | "strong" | "fast" | "draft" | "standard"

export interface PrintIntentInfo {
  id: PrintIntent
  label: string // "Display piece"
  blurb: string // one plain line: "Smooth top (ironing), cleaner edges, 3 walls — slower"
  overrides: Record<string, string | number | boolean> // OrcaSlicer process keys applied on top of the machine profile
}

/** Toolpath feature types as OrcaSlicer labels them (";TYPE:" comments). */
export type ToolpathFeature =
  | "Outer wall" | "Inner wall" | "Overhang wall" | "Sparse infill" | "Internal solid infill" | "Top surface"
  | "Bottom surface" | "Bridge" | "Gap infill" | "Ironing" | "Skirt" | "Brim" | "Support" | "Support interface"
  | "Prime tower" | "Custom" | (string & {})

/** One layer of a sliced file, compact enough to draw on a canvas. Coordinates in bed mm. */
export interface ToolpathLayer {
  index: number // 0-based
  z: number
  height: number
  // Flat array of segments per feature: [x1,y1,x2,y2, x1,y1,x2,y2, ...]
  segments: { feature: ToolpathFeature; tool: number; lineWidth: number; coords: number[] }[]
}

export interface GcodeQualityIssue {
  code: "gap_infill_on_top" | "no_ironing_flat_top" | "fast_visible_walls" | "starts_mid_air" | "single_top_wall" | "stringing_risk" | (string & {})
  severity: "warn" | "info"
  title?: string // one-line name for lists, 2-5 words ("Ragged top edge"); details stay in `message`
  message: string // plain words for the user and the agent
  layers?: number[] // layer indexes where it shows
  where?: string // "along the curved edges of the top face"
  fix?: string // "Use Display piece: smoother top, slower edges." (the Layers panel makes that one a button)
}

export interface SlicePreviewSummary {
  gcodePath: string
  intent: PrintIntent
  layerCount: number
  firstLayer: number
  topLayers: number[] // indexes of layers that contain visible top surface
  issues: GcodeQualityIssue[]
  notes?: string[] // e.g. which parts have their own settings ("main #2: ironing_pattern=concentric")
}

// ---- Print jobs (R02/R04): immutable, content-addressed snapshots of sliced G-code ----
// Stored in <project>/.studio/jobs/<id>/ (the G-code + job.json, read-only). id = sha256 (hex) of the exact G-code
// bytes, so one id names the same bytes everywhere (slice-review gate, print request, upload).

/**
 * PrintJobView.error of a job whose print request was open when the server stopped (requests live in memory): the
 * job is back to pending and the timeline says so. The UI shows it once as a toast.
 */
export const PRINT_REQUEST_RESTART_NOTICE =
  "The print request was cancelled because Crease restarted — nothing was sent to the printer. Ask again when ready."

/** Where a job is in its life. Plates advance only on a recorded successful start ("printing"). */
export type PrintJobStatus = "pending" | "requested" | "printing" | "done" | "failed" | "rejected"

export interface PrintJobSummary {
  id: string // sha256 of the G-code bytes
  projectId: string
  createdAt: string
  kind: "part" | "plate"
  gcodePath: string // where the slicer wrote it (build/…); that file may since have been replaced
  gcodeName: string
  snapshotPath: string // the immutable copy (.studio/jobs/<id>/<name>): what previews and uploads read
  bytes: number
  partIds: string[]
  plate?: number // 1-based (plate jobs)
  plateCount?: number
  machineId: string // machine it prints on (farm: the plate's assigned machine)
  machineName: string
  slicedForMachineId: string // machine whose slicer profile it was sliced with
  intent: PrintIntent
  overrides?: Record<string, string | number | boolean> // effective process overrides (incl. automatic ones)
  estimatedTimeS: number | null
  filamentG: number | null
  filamentMm: number | null
  filamentBySlot?: SlotUsage[]
  sourceRevision: string // hash over each part's recursive source hash (includes + Customizer values)
  designRevision: string // whole-design revision (server/projects/revision.ts), the key of agent approval/slice review
  slicer: { name: string; version: string | null; printProfile: string | null; printerProfile: string | null }
  checks: { partId: string; summary: CheckSeverity | null; createdAt: string | null; failing: string[] }[]
  guide: { exists: boolean; current: boolean } // build/assembly-guide.html vs part/assembly sources at slice time
  previewWarnings: number // slice-preview warnings at slice time
}

/** job.json: the summary plus everything that went into the bytes. */
export interface PrintJob extends PrintJobSummary {
  parts: { partId: string; qty: number; overrides?: Record<string, string | number | boolean> }[]
  allParts: boolean // plate of "every part at its qty": adding/removing a part or changing qty makes it stale
  /** The process overrides the caller asked for (without automatic ones); a toolbar re-slice reuses them. */
  userOverrides?: Record<string, string | number | boolean>
  // per-part source hashes; `stamps` (R07, absent on older jobs) say which files/values each was sliced from
  source: { revision: string; designRevision: string; parts: Record<string, string>; stamps?: Record<string, SourceStamp> }
  machine: {
    id: string
    name: string
    model: string
    slicerProfile: string
    buildVolumeMm: [number, number, number]
    nozzleMm: number
    filamentSlots: number
    filaments: { slot: number; colorName: string; colorHex: string; material: string; loaded: boolean }[]
    fingerprint: string // hash of the slicing-relevant config + the profile's machine.json
  }
  settings: Record<string, string> // effective slicer settings (the G-code's CONFIG_BLOCK)
  settingsHash: string
  objects?: PlacedObject[] // R13: placement on this plate, recorded at slice time (older jobs: read from the G-code)
}

/** A job with its lifecycle and whether it still matches the project. */
export interface PrintJobView extends PrintJobSummary {
  status: PrintJobStatus
  /** Why it's out of date (source/parameter edit, machine or intent change, parts added/removed); empty = current. */
  stale: string[]
  requestId?: string | null
  printId?: string | null
  /** its print ran on the built-in practice printer (labelled "Practice", never rated) */
  practice?: boolean
  error?: string | null
  reviewedAt?: string | null // when the latest-slice review (preview_slice) looked at these bytes
  updatedAt: string
  /** The estimate scaled by this machine's measured time factor (R15); null until a print in scope finished. */
  adjustedTime?: AdjustedTime | null
}

/** GET /api/projects/:id/jobs: the latest job per part and the latest plate set with each plate's state. */
export interface ProjectJobs {
  parts: Record<string, PrintJobView>
  plates: {
    id: string
    createdAt: string
    plates: PrintJobView[]
    next: number | null // 0-based cursor: first plate not yet started (printing/done); null = all started
    stale: string[] // union of the plates' reasons
  } | null
  intent: PrintIntent | null // project intent (= the latest slice's, unless the user changed it since)
}

// ---- Print outcomes + calibration (R15; see shared/api.md "Print outcomes") ----
// Structured feedback the user gives after a print ends. Stored on the print record (catalog prints table +
// .studio/prints/<id>.json) and attached to the immutable job: .studio/jobs/<jobId>/outcome.json (+ photos/).

export type PrintOutcomeRating = "great" | "ok" | "problem" | "failed"
export type PrintFailureCategory =
  | "didnt_stick" | "stringing" | "warping" | "layer_shift" | "spaghetti" | "rough_top" | "wrong_size" | "broke" | "other"
export type FitResult = "too_tight" | "just_right" | "too_loose"

/** One measured feature: what the design said vs what the calipers say. */
export interface PrintMeasurement {
  name: string // "Pen hole", "Overall width"
  partId?: string | null
  /** outside: an outer size (walls grow) · hole: a hole/slot/inside size (holes shrink) · other */
  kind: "outside" | "hole" | "other"
  expectedMm: number
  measuredMm: number | null
}

/** A fit check between printed parts (or a part and a real object). */
export interface PrintFitTest {
  name: string // "Lid on the box"
  result: FitResult
  kind?: "sliding" | "press" // default sliding
  clearanceMm?: number | null // gap per side the design used (e.g. its `clearance` parameter), when known
}

/** What calibration is specific to: the same printer, nozzle, material and print intent. */
export interface CalibrationScope {
  machineId: string
  nozzleMm: number
  material: string // "PLA"
  intent: PrintIntent
}

export interface ProposedLesson {
  text: string // the line as proposed (or as edited and accepted)
  machineId: string
  status: "proposed" | "accepted" | "dismissed" | "undone"
  line?: string | null // the exact line written to lessons.md when accepted (undo removes it)
  decidedAt?: string | null
}

export interface PrintOutcome {
  printId: string
  projectId: string
  jobId: string | null
  machineId: string | null
  rating: PrintOutcomeRating
  categories: PrintFailureCategory[] // what went wrong (empty for great)
  notes: string | null
  photos: string[] // file names in the outcome's photo folder (GET /api/prints/:printId/photos/:name)
  measurements: PrintMeasurement[]
  fits: PrintFitTest[]
  scope: CalibrationScope | null // null when the print has no job (older records)
  partIds: string[]
  estimatedTimeS: number | null
  actualDurationS: number | null
  lesson: ProposedLesson | null
  createdAt: string
  updatedAt: string
}

/** POST /api/prints/:printId/outcome body (photos are uploaded separately). */
export interface PrintOutcomeInput {
  rating: PrintOutcomeRating
  categories?: PrintFailureCategory[]
  notes?: string | null
  measurements?: PrintMeasurement[]
  fits?: PrintFitTest[]
  photos?: string[] // names returned by POST /api/prints/:printId/photos (omitted: keep the current list)
}

/** An estimate scaled by the measured time factor, labelled for the UI: "≈ 21m · adjusted from your last 3 prints". */
export interface AdjustedTime {
  estimatedTimeS: number // adjusted
  rawEstimateS: number // what the slicer said
  factor: number // actual / estimated (median of recent prints in scope, outliers dropped)
  prints: number // N prints it's based on
  scope: "exact" | "machine" // same intent + material + nozzle, or any print on this machine
}

export interface TimeCalibration {
  factor: number | null // null: no usable prints yet
  prints: number // samples used (after outliers)
  ignored: number // outliers dropped
  scope: "exact" | "machine" | "none"
}

export interface ToleranceSuggestion {
  key: "slidingFitMm" | "pressFitMm" | "holeCompensationMm"
  current: number | null // machine's stored value
  suggested: number
  reason: string // plain words: "3 holes came out 0.24 mm small on average"
  samples: number
}

/** GET /api/calibration?machineId=&intent=&material= */
export interface CalibrationReport {
  scope: CalibrationScope
  time: TimeCalibration
  tolerances: ToleranceSuggestion[]
  outcomes: number // outcomes with measurements/fits considered
}

/** One lesson line of a printer's lessons.md (Machines -> edit printer -> lessons list). */
export interface PrinterLesson {
  line: string // the raw "- 2026-10-08: ..." line (identifies it for removal)
  date: string | null
  text: string
}

// ---- Practical BOM / supplies (R17; see shared/api.md "Bill of materials") ----

/** printed: parts you print. purchased: hardware to buy. make: make it yourself (filament offcuts). consumable: glue,
 *  tape, grease. tool: tools you need on hand (not counted in the cost). */
export type BomCategory = "printed" | "purchased" | "make" | "consumable" | "tool"

export interface BomLink {
  kind: "search" | "listing" // search: a store search for the term; listing: a product page someone actually opened
  store: string
  label: string // "Search on Amazon" | "Amazon: <listing title>"
  url: string
  note?: string
  checkedAt?: string // listing only: YYYY-MM-DD it was opened
  price?: string // listing only, as shown on the page
}

export interface BomItem {
  /** Stable across edits of assembly.json: derived from the buyable spec (not the id), so "I already have this"
   *  and the parts bin survive renames. */
  key: string
  category: BomCategory
  name: string
  spec: string[]
  need: number | null // count needed; null for consumables measured in free text
  needText?: string // "a few drops"
  steps: number[]
  color?: string // printed parts
  /** "I already have this": the user's tick for this project, else the parts bin. */
  have: boolean
  haveSource: "project" | "bin" | null
  inBin: boolean // the item is in the global "my parts bin"
  /** Pack size vs need: "Usually sold in packs of ~100; you need 4". */
  pack?: { size: number | null; text: string; fromListing: boolean }
  substitutes?: HardwareSubstitute[]
  fit?: string[] // dimensional compatibility notes
  searchTerm?: string
  links: BomLink[]
  /** Rough cost of buying this (USD, one pack) when known: a verified listing's price, else a typical-price estimate. */
  estCost?: { usd: number; basis: "listing" | "typical" } | null
  note?: string // e.g. the make-yourself instruction
}

export interface ProjectBom {
  items: BomItem[]
  region: string // ISO country from sourcing settings
  totals: {
    toBuy: number // purchased + consumable items not marked "have"
    have: number
    /** Estimated cost of what is still to buy (USD); null when nothing could be estimated. */
    estUsd: number | null
    estimated: number // items included in estUsd
    unpriced: number // items to buy without an estimate
  }
  /** Prices are rough US estimates; null outside the US (no estimate). */
  priceNote: string | null
}

export interface PartsBinItem {
  key: string
  name: string
  addedAt: string
}

// ---- Portable build pack (R16; see shared/api.md "Build packs") ----

export const BUILD_PACK_FORMAT = "printstudio-build-pack"
export const LICENSES = [
  "All rights reserved",
  "CC BY 4.0",
  "CC BY-SA 4.0",
  "CC BY-NC 4.0",
  "CC BY-NC-SA 4.0",
  "CC0 1.0",
  "MIT",
  "GPL-3.0-or-later",
] as const

export interface BuildPackOptions {
  license?: string // default: the project's licence, else "All rights reserved"
  description?: string
  includeGcode?: boolean // default false: sliced files only fit the machine/profile they were made for
  includeNotes?: boolean // default false: print outcomes/notes from this install
}

export interface BuildPackFile {
  path: string // inside the zip
  sha256: string
  bytes: number
  role: "source" | "guide" | "bom" | "render" | "model" | "gcode" | "notes" | "info"
}

export interface BuildPackGcode {
  path: string
  jobId: string // sha256 of the original sliced bytes (the job)
  partIds: string[]
  plate?: number
  machine: string // "SparkX (Creality SPARKX i7)"
  profile: string | null // slicer printer profile
  nozzleMm: number
  materials: string[] // e.g. ["PLA"]
  intent: string
  label: string // "for SparkX (Creality SPARKX i7), 0.4 mm nozzle, PLA — won't fit other printers"
}

export interface BuildPackPartInfo {
  id: string
  name: string
  qty: number
  colors: string[]
  sizeMm: [number, number, number] | null
  material: string | null
  printSettings: { intent: string; layerHeightMm?: string; infill?: string; walls?: string; supports?: string; overrides?: Record<string, string | number | boolean> } | null
}

/** printstudio-pack.json at the root of the zip. */
export interface BuildPackManifest {
  format: typeof BUILD_PACK_FORMAT
  formatVersion: 1
  /** The app that wrote it: "Crease" (packs from before the rename say "Print Studio"). */
  app: { name: string; version: string }
  createdAt: string
  project: { name: string; description: string | null; tags: string[]; license: string; intent: string | null }
  parts: BuildPackPartInfo[]
  materials: string[]
  hardwareCount: number
  files: BuildPackFile[]
  gcode: BuildPackGcode[]
  guidePdf: boolean
  /** The guide (and assembly picture) matched the design when the pack was made: the importer can trust it. */
  guideCurrent?: boolean
  /** What was deliberately left out (by kind, never by private path). */
  excluded: string[]
}

/** GET /api/projects/:id/pack/preview: what an export would contain. */
export interface BuildPackPreview {
  name: string
  license: string
  description: string | null
  files: { path: string; bytes: number; role: BuildPackFile["role"] }[]
  excluded: string[]
  gcode: (Omit<BuildPackGcode, "path"> & { stale: string[] })[]
  notes: number // print records that "include print notes" would add
  guidePdf: "yes" | "no-renderer" | "no-guide"
  warnings: string[]
}

export interface BuildPackImportResult {
  project: Project
  verified: number // files whose checksum matched
  license: string
  disabledAgentConfig: string[] // assistant settings in the pack, kept off (R09)
  gcode: BuildPackGcode[] // reference copies under imports/<importId>/gcode (not print jobs on this install)
  warnings: string[]
}

// ---- Project overview (R12; GET /api/projects/:id/overview, see shared/api.md "Project overview") ----

/** What the overview's one big button does. */
export type OverviewActionKind =
  | "describe" // nothing designed yet: tell the designer what to make (focus the chat)
  | "fix" // a part failed to render: ask the designer to fix it
  | "update" // previews are out of date: render again
  | "approve" // (no longer offered: approval folds into the print dialog's Print) approve it (POST /approval)
  | "fit" // a part is too big for the printer: make it fit (Parameters, else ask the designer)
  | "problem" // a printability check failed (or slicing failed): fix it before slicing
  | "slice" // nothing current sliced: slice it
  | "print" // send plate `plate` (or the single part) to the printer (the app's confirm dialog still asks)
  | "waiting" // a print dialog is open for this project: answer it
  | "printing" // a plate is printing: watch it
  | "assemble" // every plate printed and there's a guide: put it together
  | "feedback" // printed: how did it turn out? (rate print `printId`)
  | "again" // all done: print another one

export interface OverviewAction {
  kind: OverviewActionKind
  label: string // the button: "Print plate 2 of 3"
  detail: string // one plain sentence: why this is next
  plate?: number // print: 1-based plate to send (multi-plate builds)
  printId?: string // feedback: the print to rate
  partId?: string // fit / problem: the part to change
}

export interface OverviewPart {
  id: string
  name: string // assembly.json part name, else the id
  qty: number
  colors: string[]
  sizeMm: [number, number, number] | null
  imageUrl: string | null // its iso render
  error: string | null // render error
}

export interface OverviewPlate {
  plate: number // 1-based
  jobId: string
  status: PrintJobStatus
  partIds: string[]
  estimatedTimeS: number | null // slicer
  adjustedTime: AdjustedTime | null // calibrated from this printer's finished prints (R15)
  filamentG: number | null
  practice?: boolean // printed on the practice printer
}

export interface ProjectOverview {
  projectId: string
  name: string
  description: string | null
  /** false while the project still holds only the blank starter part (nothing designed yet) */
  hasDesign: boolean
  /** finished-assembly picture when there is one (renders/assembly-complete.png), else the main part's iso render */
  hero: { url: string; kind: "assembly" | "part"; stale: boolean } | null
  /** overall size: the assembled build (part boxes moved by their placements), else the single / largest part */
  size: { mm: [number, number, number]; basis: "assembled" | "part" | "largest-part" } | null
  parts: OverviewPart[]
  printedCount: number // printed pieces (sum of qty)
  hardwareCount: number // bought pieces in the build (screws, magnets…)
  /** filament per colour: from the current slice when there is one (grams), else the design's colours (grams null) */
  materials: { colorName: string; colorHex: string | null; material: string; slot: number | null; grams: number | null }[]
  filamentG: number | null // total of the current slice
  slice: {
    state: "none" | "current" | "stale"
    reasons: string[]
    kind: "part" | "plate" | null
    /** the last slice of this design revision failed: plain words + the slicer's own message (cleared by a slice) */
    error?: { message: string; detail: string } | null
  }
  plates: OverviewPlate[] // the current slice (plate set, or one entry for a single-part slice)
  nextPlate: number | null // 1-based plate to send next; null = all started / none
  /** sums over plates: slicer estimate and the calibrated one (null until a print on this machine finished) */
  time: { estimatedS: number | null; adjustedS: number | null; prints: number }
  /** R17 supplies still to get (null without an assembly) */
  supplies: { toBuy: number; have: number; estUsd: number | null; items: { name: string; need: number | null; needText?: string }[] } | null
  guide: { steps: number; exists: boolean; current: boolean } | null
  /** R07: everything out of date (previews, checks, guide, motion check, slice), in plain words */
  outOfDate: { what: string; reasons: string[] }[]
  approved: boolean // the user approved this exact design revision (the designer may slice / request prints)
  lastPrint: { id: string; state: PrintJobState; startedAt: string; finishedAt: string | null; rated: boolean; practice?: boolean } | null
  /** the printer this project's running print is on (may differ from the project's printer), else null */
  printingOn?: { machineId: string; name: string } | null
  next: OverviewAction
  /** project-specific starter actions for the composer ("Make it bigger", "Print another one"…) */
  suggestions: string[]
}

// ---- Ideas and comparison (R22; see shared/api.md "Comparing ideas") ----

/** One idea (a git branch), named for people: "First idea", "Taller hook". */
export interface Idea {
  branch: string // stable id of the idea (git branch name; never the main label)
  name: string
  current: boolean
  tip: Checkpoint // its newest saved version
  /** The idea's chat to come back to (the last one used on it); null = a fresh chat. */
  sessionId: string | null
  sessionCount: number
  /** Where it split off another idea (null for the first idea). */
  startedFrom: { commit: string; short: string; idea: string | null } | null
}

export interface IdeaList {
  current: string // branch of the idea whose files are open
  ideas: Idea[]
}

/** A stable reference to one side of a comparison: the commit it resolved to, shown with a friendly label. */
export interface CompareRef {
  ref: string // as asked: an idea's branch, a version's commit, or "current"
  kind: "idea" | "version" | "current"
  commit: string // full sha (stable: the same version compares the same after new commits)
  short: string
  idea: string | null // name of the idea it belongs to
  branch: string | null
  label: string // "Taller hook" / "“made it taller”"
  message: string
  date: string
  /** The open files have edits not saved as a version yet; they're included. */
  unsaved: boolean
}

export interface ComparePart {
  id: string
  name: string
  qty: number
  colors: string[]
  sizeMm: Vec3 | null
  error: string | null
}

export interface CompareSide {
  ref: CompareRef
  /** Picture of the whole thing; both sides use the same camera, so sizes compare by eye. */
  imageUrl: string | null
  /** Colour model of the whole thing in the shared frame (3D overlay); null if it couldn't be built. */
  modelUrl: string | null
  size: { mm: Vec3; basis: "assembled" | "part" | "laid-out" } | null
  parts: ComparePart[]
  /** Effective Customizer values per part (source defaults + this side's idea's saved overrides). */
  params: Record<string, Record<string, number | string | boolean>>
  filament: { grams: number | null; timeS: number | null; adjustedS: number | null; calibratedPrints: number; basis: "sliced" | "estimate" }
  cost: { filamentUsd: number | null; suppliesUsd: number | null; totalUsd: number | null; unpriced: number }
  bom: { key: string; name: string; category: BomCategory; need: number | null; needText?: string }[]
  /** Why this idea is the way it is: the designer's plan cards, what was asked, and the saved changes (only the
   *  ones the other side doesn't share). */
  decisions: { kind: "plan" | "ask" | "change"; text: string; at: string }[]
  /** R11g: the chats that worked on this idea: runtime, model, version, cost (known / estimated / unknown). */
  designers: IdeaDesigner[]
}

export interface IdeaComparison {
  a: CompareSide
  b: CompareSide
  /** One plain sentence: "B is 12 mm taller, uses 8 g more filament and adds 2 magnets." */
  summary: string
  same: boolean
  diff: {
    sizeMm: Vec3 | null // b − a
    parts: {
      id: string
      name: string
      change: "added" | "removed" | "resized" | "qty" | "same"
      a: Vec3 | null
      b: Vec3 | null
      qtyA: number | null
      qtyB: number | null
    }[]
    params: { partId: string; name: string; description?: string; a: number | string | boolean | null; b: number | string | boolean | null }[]
    bom: { key: string; name: string; change: "added" | "removed" | "changed"; a: number | null; b: number | null }[]
    grams: number | null
    timeS: number | null
    costUsd: number | null
  }
  /** Shared 3D frame for the overlay: both models are in the same coordinates (centre XY, floor Z, radius). */
  frame: { center: [number, number]; floorZ: number; radius: number } | null
  notes: string[]
}

// ---- Cross-runtime handoff (R11g; see shared/api.md "Handoff") ----
// A new chat (on another runtime, or the same one with a clean context) starts from a summary the APP builds from the
// project's records, never from the model. No claim of native resume across runtimes.

/** switch = another designer; fresh = a clean chat, same designer; idea = "Try this with another designer";
 *  resume = back to an earlier chat of that designer (native resume), told what changed since; auto = the designer
 *  changed outside the dialog (e.g. the default in Agents) and the next message started a new chat. */
export type HandoffReason = "switch" | "fresh" | "idea" | "resume" | "auto"

export interface HandoffDesigner {
  profileId: string | null
  /** "Claude (Opus)"-style label: profile name + model */
  name: string
  runtime: string
  model: string | null
}

/** What the new designer is told: deterministic, built from project records; redacted (no secrets, no absolute paths). */
export interface HandoffSummary {
  project: { name: string; description: string | null }
  requirements: {
    firstAsk: string | null
    answers: { question: string; answer: string }[]
    /** later requests, oldest first (trimmed) */
    asks: string[]
  }
  design: {
    idea: string | null
    version: { short: string; message: string } | null
    revision: string | null
    size: { mm: [number, number, number]; basis: string } | null
    parts: { id: string; name: string; qty: number; sizeMm: [number, number, number] | null; colors: string[]; error: string | null }[]
  }
  approved: boolean
  decisions: { title: string | null; bullets: string[] }[]
  checks: { failing: string[]; outOfDate: string[]; motion: string | null; open: string[] }
  supplies: { name: string; need: string }[] | null
  prints: { last: string | null; outcomes: string[] }
  references: { files: string[]; pins: string[] }
  recent: { role: "user" | "assistant"; text: string }[]
}

export interface HandoffPreview {
  /** false = nothing to carry over (no earlier chat, or the same runtime: it resumes natively) */
  needed: boolean
  reason: HandoffReason
  from: HandoffDesigner | null
  fromSessionId: string | null
  to: HandoffDesigner
  summary: HandoffSummary
  markdown: string
  /** An earlier chat held by the target designer's runtime on this idea: "Continue the earlier Claude chat". */
  resume: { sessionId: string; title: string; designer: string } | null
  /** the summary worded for that earlier chat ("what changed while you were away"); null without `resume` */
  resumeMarkdown: string | null
}

/** .studio/handoffs/<id>.json (+ <id>.md: exactly what the designer is told). */
export interface HandoffRecord {
  id: string
  createdAt: string
  reason: HandoffReason
  mode: "new" | "resume"
  fromSessionId: string | null
  toSessionId: string
  from: HandoffDesigner | null
  to: HandoffDesigner
  summary: HandoffSummary
  /** what the app generated, and what the designer gets (the user's edit, if any) */
  generated: string
  markdown: string
  edited: boolean
  /** when it went to the designer (the start of the chat's first message); null = waiting for the next message */
  deliveredAt: string | null
  branch?: string | null
}

/** Who worked on an idea, with what it cost (R11g "compare runtimes"). Unknown cost stays unknown, never 0. */
export interface IdeaDesigner {
  sessionId: string
  title: string
  runtime: string
  designer: string | null // profile name
  model: string | null
  version: string | null // runtime/CLI version reported at session start
  costUsd: number | null // this chat's own spend (excludes cost copied in at a fork)
  cost: "known" | "estimated" | "unknown" // billed / API-price estimate / not reported
  handedOverFrom: string | null
}
