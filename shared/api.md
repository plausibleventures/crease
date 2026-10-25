# Local API contract (server <-> renderer)

All routes are under the Fastify server (dev: http://127.0.0.1:5174, proxied by Vite at /api and /ws).
Access: Electron requires the per-launch token on /api and /ws. Dev mode (no token) answers 403 to browser requests
from non-loopback origins (`Origin` not localhost/127.x/[::1], `Origin: null`, `Sec-Fetch-Site: cross-site`) and to a
non-loopback `Host` (DNS rebinding) when bound to loopback; clients without an Origin (curl, tools) pass.
JSON in, JSON out. Errors: HTTP 4xx/5xx with `{ "error": string }`. Types live in `shared/types.ts`.

## Projects (owner: projects/cad agent — server/routes/projects.ts)
- GET    /api/projects                                  -> ProjectSummary[]
- POST   /api/projects            {name}                -> Project   (creates folder, git init, a starter part)
- GET    /api/projects/:id                              -> Project
- PATCH  /api/projects/:id        ProjectPatch {name?, tags?} -> Project  (U4: rename = display name only, the id/folder
         stay; tags replace the list: trimmed, case-insensitive de-dup, at most 12 tags of 32 chars, name at most 80; else
         400. Emits project.changed [project.json]; the catalog row (Library search + tag filter) updates.)
- POST   /api/projects/:id/duplicate {name?}            -> Project  (U4: a copy under a new id, default name "<name> copy":
         files, version history, ideas, Customizer values, renders, checks. Not copied: chats, print jobs/records, handoffs.)
- DELETE /api/projects/:id                              -> ProjectTrashResult {trashed, where: "system"|"app", path}
         (U4: never removes files. Desktop app: the folder goes to the OS Trash (Electron shell.trashItem, restorable from
          Finder). Browser/dev server: moved to <STUDIO_HOME>/.trash/<id>-<time>/. 400 for a malformed id or a folder that is
          a link; 404 if missing; 409 while the designer is working on it or a print from it is running / waiting for
          approval. The catalog row goes; print records stay.)
- GET    /api/projects/:id/file?path=parts/x.scad       -> {path, content}
- PUT    /api/projects/:id/file   {path, content}       -> {ok:true}   (writes, triggers render via watcher; 403 for app-owned
         paths: .studio/, .claude/ (any depth), .mcp.json, build/, renders/)
- GET    /api/projects/:id/parts/:partId/parameters     -> ScadParameter[] (the part's own, then those of project files it include<>s, with `file`;
         a shared setting carries `sharedWith`: every part that has it, one value for all of them)
- POST   /api/projects/:id/parts/:partId/render {params?: Record<string, number|string|boolean>} -> RenderResult
         (params given, even `{}` = the part's Customizer overrides: saved per idea in `.studio/params/<idea>/<part>.json` and used by
          EVERY later render/check/export/slice — watcher, restore, toolbar, agent; `{}` clears them; a change emits
          jobs.changed. Omitted = render with the saved ones. Older projects without the file: their last render's.
          U2: params given also start/extend a slider burst; ~2 s after the last one the burst becomes ONE version
          "user: change width to 90" (or "change a and b", "reset settings"), then `versions.changed`.)
         Shared settings (from an include<>d project file, or declared by 2+ parts with the same design value) are saved
         once for every part that has them (`.studio/params/<idea>/@shared.json`): a render of one part with a new value
         (or without it = reset) changes it for all of them, and the other parts are re-rendered and checked after it.
- GET    /api/projects/:id/parts/:partId/overrides      -> {overrides: Record|null, notes: SharedParamNote[]}  (the saved Customizer overrides,
         the part's own + the shared ones it has; `notes`: shared settings of this part whose parts had different values before
         they were joined (older projects: the first part in project order that set one wins))
- POST   /api/projects/:id/shared-notes/dismiss {names?: string[]} -> {ok: true}  (forget those notes; all when names is omitted)
- POST   /api/projects/:id/parts/:partId/check          -> CheckReport
- GET    /api/projects/:id/parts/:partId/latest         -> PartLatest {render: RenderResult|null, check: CheckReport|null}  (cached results, never re-runs)
- GET    /api/projects/:id/validity                     -> ProjectValidity (R07: is every derived artifact still current?)
  `{parts: {partId: {source, overrides, render, check}}, assembly: {source, guide, motion|null} | null}`;
  each ArtifactValidity = `{state: "fresh"|"stale"|"missing", reasons: string[], builtAt}`. Dependency-based, never
  timestamps: a part's stamp = its .scad + every include/use (recursively, e.g. lib/params.scad) + its Customizer
  overrides (the saved ones, `.studio/params/<idea>/<part>.json`); the assembly stamp = every part's stamp + assembly.json + assembly.scad and its
  includes. Artifacts record the stamp they were built from (`build/<part>.render.json` hash+files,
  `CheckReport.source`, `build/assembly-guide.json`, `build/motion-check.json` inputs, job.json `source.stamps`); fresh = recorded
  hash == hash now, reasons name what changed ("lib/params.scad changed", "Customizer values changed (width)").
  Content-based, so restoring an older version makes artifacts built from it current again. Computed on read: refetch
  on project.changed, render.done, check.done and jobs.changed (also emitted after a restore / idea switch).
  Code: server/projects/revision.ts (stamps) + server/projects/validity.ts.
- GET    /api/projects/:id/artifacts/*                  -> static files from build/ and renders/ (STL, PNG, gcode)
- POST   /api/projects/:id/checkpoints {message}        -> {commit}
- GET    /api/projects/:id/files                        -> ProjectFilesResult (the sidebar's Files tree; folders first, by name.
         Hidden: dot-entries (.git, .studio, .claude, .mcp.json, …), build/, node_modules/, project.json. renders/ is readOnly.
         Links are listed only when they land inside the project; capped at 5000 entries -> truncated)
- POST   /api/projects/:id/files/upload?path=dir/name.ext[&replace=1]  body: raw bytes (application/octet-stream), ≤ 100 MB
         -> {path}  (copies one file in; folders are made as needed. Name taken and no replace -> "name-2.ext". Emits
         project.changed; a new parts/*.scad becomes a part.)
- POST   /api/projects/:id/files/folder {path}         -> {path}  (an empty folder, parents made; 409 if something is there.
         Same refusals as upload. Emits project.changed.)
- POST   /api/projects/:id/files/rename {from, to}      -> {path}  (409 if `to` exists)
- DELETE /api/projects/:id/files?path=…                 -> {ok:true}  (a file or a whole folder)
  ("Show in Finder" is desktop-only: preload `revealFile(projectId, path)` -> IPC; main resolves the path with the
   same resolveProjectPath and calls shell.showItemInFolder.)
  Files rules (server/projects/files.ts): paths are judged by where they really land (resolveInside: no `..`, no
  absolute paths, no links out of the project). Upload, rename and delete refuse (403): .git/, .studio/, build/,
  renders/, node_modules/, any dot-entry, G-code (.gcode/.bgcode/.gco: app-made only), project assistant settings
  (CLAUDE.md, CLAUDE.local.md, AGENTS.md, AGENTS.override.md, .claude/, .codex/, .agents/, .grok/, .mcp.json at any
  depth: these turn on only through agent-config/enable), and project.json (managed by the app).
- GET    /api/projects/:id/agent-config                 -> {enabled: string[], pending: string[], disabled: string[]}
- POST   /api/projects/:id/agent-config/enable {paths?: string[]} -> {enabled: string[], skipped: string[]}
- POST   /api/projects/:id/agent-config/disable         -> {ok:true}  (forgets the trust and moves the items aside now)

Paths (R09): every route that takes a project-relative path judges it by where it really lands (symlinks resolved,
including the existing parent of a new path; server/projects/paths.ts). Links that stay inside the project are
followed; a link that leads outside it (or into .git/) is refused with 403, for reads and writes. build/, renders/
and .studio/ must be real folders (409 otherwise).

Import trust (R09): the project's own assistant config (`.claude/settings.json` and anything else in `.claude/` except
the app's installed skill folders, `.mcp.json`, `CLAUDE.md`/`CLAUDE.local.md` at any depth; R11d: Codex's
`AGENTS.md`/`AGENTS.override.md` at any depth and `.codex/`/`.agents/` folders, which the Codex runtime also ignores)
is off until the user enables it (chat panel notice: "This project came with its own assistant settings" → Review →
Turn them on… with a warning / Turn them off). Build packs never carry any of it. At each agent session start untrusted items move to `.studio/agent-config-disabled/` (same relative path;
a timeline `app_notice` says so). `enable` moves them back and records content hashes in
`<STUDIO_HOME>/agent-trust.json`; an item that later changes is off again. `pending` = present but untrusted (moves
aside at the next session start). Changes apply from the next session. See server/projects/agent-config.ts.

## Sculpted parts (Blender) — server/cad/{sculpt,blender,sculpt-trust}.ts
A part can be a Blender Python script, `parts/<id>.blend.py` (registered like a .scad). The app runs it headless in
Blender inside a macOS sandbox (no network, no other programs, writes only to a temp folder, project read-only) and
then treats the mesh like any part: `build/<id>.blend.scad` (generated) import()s it, so render, check, slice,
plates, assembly, compare and colours work unchanged. Settings live in a `# --- settings ---` … `# --- end settings
---` block (`height = 110  # [80:1:140] Height (mm)`), read as Customizer parameters; overrides and set_parameters
work on them. RenderResult of a Blender part also has a `back` image and `notes` (e.g. "Simplified from … to …
triangles"). Errors: RenderResult.error holds the script's traceback; `errorCode` "BLOCKED" = the script came in a
build pack and won't run until allowed:
- POST   /api/projects/:id/sculpt-scripts/allow         -> {allowed: string[]}  (the user's choice; then re-render)
Blender is optional (GET /api/onboarding/checks `blender`; Settings `blenderPath`).

## Printability depth + imports (R23 — server/cad/{thickness,orient,imports,threemf}.ts, server/routes/imports.ts)
Checks (`POST …/check`) add, per the project's target machine nozzle (line width = nozzle × 1.125, e.g. 0.45 mm):
- `thin_walls` (pass/warn): side walls under 2 lines (0.9 mm) — "This wall is 0.6 mm thick (halfway up, at the left).
  Make it at least 0.9 mm, or it may print with gaps"; `thin_features` (warn, only when found): under one line (may not
  print at all). Measured by rays from the walls to the opposite face (wedges/fillets don't count). Each spot is a
  `CheckItem.markers[]` entry `{at:[x,y,z] (part/STL coords), label, severity}` shown as a marker in the 3D viewer.
- `orientation` (pass = keep it / info = suggestion) + `CheckReport.orientation: OrientationAdvice`: the current
  orientation and each large flat face down, compared by support area (overhangs past 45° + flat undersides wider than
  10 mm), short bridges (flat undersides ≤ 10 mm), bed contact, height and rough time. A suggestion only when clearly
  better (≥40% less support, or ≥25% faster with no more support, or steadier / sticks where it doesn't); ties keep the
  current one (a flat display piece stays face up).
- POST   /api/projects/:id/parts/:partId/orientation {rotate:[x,y,z]} -> {file, rotate}
  Writes the documented transform into the part's .scad, never the mesh: `print_orientation = [x, y, z];` and
  `rotate(print_orientation) { … } // printstudio:orientation` around the top-level geometry (moved to the end of the
  file, in order; assignments/modules/includes stay put, so Customizer values and -D overrides still apply). Later
  calls only change the vector; [0,0,0] = as modelled. The watcher re-renders + re-checks. Agent tool: set_orientation.
Imports (two steps, so the dialog can ask with the facts in hand):
- POST   /api/projects/:id/imports/inspect?name=<file name>  (body: the file, application/octet-stream, ≤ 200 MB)
         -> ImportInspection {token, format stl|3mf|scad, kind mesh|scad, suggestedId, sizeIfMm, sizeIfInch?,
            units {known, ask, recommended, why}, metadata (3MF Title/Designer/LicenseTerms/Copyright), libraries, warnings}
         STL has no units: ask when it's ≤ 12 units across and would fit the bed in inches. 3MF says its units
         (converted to mm). A 3MF's own print settings/plates/scripts are never read or applied (a warning says so).
         A .scad that reads files outside the project (absolute paths, `..`, `~`) is refused (422); missing
         include/import files are warnings; BOSL2 is bundled.
- POST   /api/projects/:id/imports {token, id?, units?, source {kind self|web|person|unknown, url?, author?}, licence}
         -> ImportCommitResult {part, project, files}; renders + checks in the background.
         Meshes: parts/imported/<id>.stl (binary, file units) + parts/imported/<id>.scad (wrapper: scale_percent
         Customizer value, units_to_mm, the orientation block around import()) + parts/imported/<id>.json
         (ImportedPartInfo). SCAD: parts/imported/<id>.scad as given (editable) + the .json. The part's
         `PartRef.imported` carries the same info; meshes are labelled "mesh — can be scaled/rotated/placed but not
         reshaped by parameters". Writes go through resolveInside (R09: a parts/imported link out of the project is
         403) and never overwrite. The agent may not write parts/imported/*.stl|3mf|json (policy); the STL is part of
         the part's stamp (render cache, validity, jobs).

## Project overview (R12 — server/projects/overview.ts, server/routes/projects.ts)
- GET    /api/projects/:id/overview                     -> ProjectOverview  (read-only aggregate, computed on read, never
         renders/slices: hero picture (finished assembly, else the main part), overall size, parts, materials/colours +
         grams of the current slice, plates with status + slicer and calibrated (R15) time, supplies still to get (R17),
         guide state, everything out of date (R07 validity + slice staleness), approval, last print, the ONE next action
         and project-specific composer suggestions). `hasDesign` is false while the project only holds the blank starter
         part. Refetch on the same events as /validity and /jobs, plus prints.changed and print.finished.
         Next action order: describe → fix (render failed) → update (previews out of date) → approve → slice (none / out
         of date) → print plate N of M (rejected/failed plates are offered again) → printing → assemble (guide, multi-part
         or hardware) → feedback (latest print not rated) → again. The renderer may show "waiting" while a print dialog
         for the project is open (client-side state).
- POST   /api/projects/:id/approval {approved: boolean} -> {approved}  (the user approves the design as it is now, from
         the overview's "Approve the design" button; same gate as answering "Looks great" — any later design change
         makes it stale. Saved as `{revision}` in `.studio/approval.json` (app-owned; the agent can't write it) and
         re-validated against the current design after a restart: a changed design reads as not approved.)

## Versions and ideas (owner: renderer agent — server/routes/projects.ts, server/projects/store.ts)
Versions are git commits; "ideas" (variants) are git branches `variant-N`. Session list + active session live in
`.studio/state.json` (`.studio/` is gitignored), so moving between versions never rewrites them.
U2: every version commit records the open idea's Customizer values as a message trailer
`Studio-Params: {"<part>":{"<name>":value}}` (server/projects/param-snapshot.ts). A change to the values alone is a
version (empty commit). Restore brings the version's values back; Compare builds a version with its own values.
Versions without the trailer (older) keep / use the idea's current values.
- GET    /api/projects/:id/checkpoints                  -> {branch, checkpoints: Checkpoint[]}  (current line of work, newest first)
- POST   /api/projects/:id/checkpoints/:commit/restore  -> {commit, restored}  (NEW commit "user: restore <msg>" with that version's files and slider values; edits and a pending slider burst saved first; re-renders)
- POST   /api/projects/:id/variants {fromCommit?, title?} -> {branch, sessionId, title}  (branch from HEAD/commit, fork the agent session (SDK forkSession), activate it)
- POST   /api/projects/:id/sessions/:sessionId/activate -> {sessionId, branch, switched, savedWork}  (switches files to the session's branch; uncommitted edits become "user: work in progress")
- POST   /api/projects/:id/work-in-progress             -> {committed}

## Comparing ideas (R22 — server/projects/ideas.ts, server/projects/compare.ts)
Ideas are named for people ("First idea", the chat title that started it, or a name the user gave); the branch is the
stable id and is never the main label. `.studio/ideas.json` keeps names and each idea's last chat.
Customizer overrides are per idea: `.studio/params/<idea>/<part>.json` (idea = branch, URI-encoded). Switching ideas swaps
them with the files, a new idea starts with a copy of its parent's, compare builds each side with its own idea's (a version
uses the idea that holds it). The old flat `.studio/params/<part>.json` is migrated on first use: every idea gets a copy.
Shared settings' values sit in `.studio/params/<idea>/@shared.json`; version trailers carry them under `"@shared"`.
- GET    /api/projects/:id/ideas                        -> IdeaList  ({current, ideas: Idea[]}: name, tip version, chat to return to, where it started)
- PATCH  /api/projects/:id/ideas/:branch {name}         -> IdeaList  (rename; empty = default name)
- POST   /api/projects/:id/ideas/:branch/activate       -> {branch, sessionId, switched, savedWork}  (files switch (edits saved first) and that
         idea's own chat comes back; the idea left behind remembers its chat; unbranched sessions are stamped with their idea)
- GET    /api/projects/:id/compare?a=&b=                -> IdeaComparison  (read-only; a/b = idea branch, version commit or "current").
         Each side resolves to a commit (`CompareRef`: stable — comparing the same versions after new commits gives the same
         answer; an idea's branch follows its newest version; the open idea / "current" include unsaved edits). Files are
         extracted and built under build/compare/<key>/ (cached by content + Customizer overrides): part STLs (sizes, volume),
         a colour scene model for the 3D overlay, one picture per side from a shared camera. Filament/time: slicer numbers
         when both sides have jobs sliced from exactly these sources, else a volume estimate for both (`basis`); time
         adjusted by the machine's measured factor (R15). Cost = filament (~$20/kg) + BOM purchased/consumable estimates.
         `diff`: overall size, per-part size/qty, added/removed parts, Customizer + shared lib/ values (`"(shared)"`), BOM;
         decisions = plan cards, user asks and saved changes only one side has. `summary`: one plain sentence.
- Agent tool `compare_ideas {a?, b?}` (read-only): the same comparison as text; a/b accept idea names.

## Agent (owner: agent agent — server/routes/agent.ts)
- POST   /api/projects/:id/agent/message {text, images?: {mediaType, data(base64)}[]} -> {sessionId}  (starts or continues the session; starts a run: `run.started` carries the input incl. `images`)
- POST   /api/projects/:id/agent/session {sessionId|null} -> {sessionId}  (switch active session: ends the live query, next message resumes it; null = start a new session on next message)
- POST   /api/projects/:id/agent/model {model}          -> {model}  (this project only: `.studio/state.json` agentModel,
         applied to the live session from its next turn; Project.agentModel. Settings.model, the default for projects
         without one, changes only from Settings)
- POST   /api/projects/:id/agent/stop                   -> {ok:true}
- GET    /api/projects/:id/agent/events                 -> AgentEventEnvelope[]  (the active session's normalized events, replayed from
         the transcript; legacy transcripts migrated on read. What the timeline renders. See "Agent events" below.)
- GET    /api/projects/:id/agent/timeline               -> AgentEnvelope[]  (native runtime messages: legacy transcript lines, then
         `.studio/sessions/native/<id>.jsonl`; diagnostics and evals only)
- GET    /api/agent/runtimes                             -> AgentRuntimeProbe[]  (installed / version / auth / models / capabilities per
         registered runtime; no model call. See "Agent profiles" below.)
- GET    /api/projects/:id/agent/status                 -> {running, sessionId, costUsd}
- GET    /api/agent/usage                               -> {billing: "plan"|"api", usage: PlanUsage|null}  (latest plan usage from rate_limit_event; live updates via agent.usage)
- GET    /api/projects/:id/agent/questions              -> AgentQuestionRequest[]  (questions the agent is waiting on; re-show after reload)
- POST   /api/projects/:id/agent/answer {requestId, answers: {[questionText]: string}, notes?: {[questionText]: string}} -> {ok:true}
         (answer = option label, comma-separated labels for multiSelect, or free text. Emits agent.question.resolved.
          The agent blocks until answered; stop cancels it. A message sent while a question is open (with photos or
          pins, or from a check's button) is the reply instead: the question closes unanswered and the message follows.)
- POST   /api/projects/:id/agent/pause {requestId} -> {ok:true}  (the user pauses the designer at a question: its turn
         ends, the question stays open and `agent.question` is sent again with `paused: true`. Answering it, or any new
         message, continues as the user's next message. 404 when that question isn't open. Same for every runtime.)

### Agent events (R11a, shared/types.ts `AgentEvent`, `AgentEventEnvelope`)
Runtime-neutral: each runtime adapter (server/agent/runtime/; Claude Code via the Agent SDK today) turns its native
messages into these, and the session coordinator (server/agent/coordinator.ts) wraps, dedupes, persists and emits them.
- Envelope: `{schemaVersion: 1, eventId, seq, ts, projectId, sessionId, runId, itemId, revision, runtime, event}`.
  `eventId` is unique per session (`"<seq>"`; `"<seq>.<k>"` for events migrated from one legacy line, which share its
  `seq`). `runId` = one user turn (null outside a run). `itemId` = the timeline item the event upserts (message block,
  tool call id, `user:<runId>`, …). `revision` = design revision last seen by the run (refreshed at run start, after
  each tool, at run end). `runtime` = "claude" | "app" (coordinator's own) | ….
- Events: `run.started {input, model, queued?}` (queued = sent while another run was open) · `input.status {status:
  "received" | "dropped"}` (same runId: the queued message reached the designer, or Stop/the runtime ending dropped it;
  the chat shows "Waiting" / "Not read" under the bubble until then) · `message.delta {kind, delta}` (live only) · `message.completed {role, kind,
  text}` · `tool.started {name, input?, inputDelta? (live only)}` (upsert by call id) · `tool.completed {isError, text,
  images}` · `question.requested {requestId, questions}` · `permission.requested` (runtimes with permission callbacks;
  not Claude) · `artifact.changed {paths}` (project files changed during a run) · `usage.updated {usage}` (live
  estimates not persisted) · `run.completed {result}` · `run.failed {error, result?}` (no result = the runtime itself
  failed) · `run.interrupted {result?}` · `notice {level, text, code?}` (`session.started` carries data.cwd/model) ·
  `native {message}` (not understood: shown raw).
- Usage (`AgentUsage`): provider-reported `tokens`, `billedUsd` (API-key billing), `estimatedApiUsd` (API list-price
  equivalent), `billing` ("api" | "plan" | "unknown"), `subscription` (plan limits), `final`. Money is cumulative per
  session. Unknown is null, never 0. Status/timeline cost = billed if known, else the estimate.
- Messages sent while a run is open (adapter `send`, host `received(inputId)`): each runtime folds them into the
  running turn when it can (Claude: its queue, read at the next model request; Codex: `turn/steer`, read when the
  thread shows the userMessage with that clientUserMessageId; API: with the next tool results, or as a follow-up
  before the turn ends) and otherwise queues them; everything queued goes into the next turn together (Codex
  turn/start, Grok session/prompt with several text blocks). A folded run joins the head run (no run end of its own).
  Stop drops what is queued; messages sent after Stop still run.
- Exact duplicates (same type, item and payload) are dropped; the renderer also dedupes by `sessionId:eventId` and
  upserts by `itemId`, so replays and reconnects are harmless.
- Transcript: `.studio/sessions/<id>.jsonl` holds envelopes (deltas and live estimates excluded). Before R11a it held
  `AgentEnvelope` lines with raw Claude SDK messages; those are migrated on read and never rewritten (a resumed old
  session appends envelopes after them). Native messages (redacted, images stripped) + the app's user_input /
  app_notice / app_error go to `.studio/sessions/native/<id>.jsonl`.
- WS: `agent.event` (envelope). The legacy `agent` frame (raw SDK message) is no longer sent.

### Handoff (R11g — server/agent/handoff.ts, handoff-collect.ts, coordinator `previewHandoff` / `startHandoff`)
Native resume stays inside its runtime. Another runtime (or a clean context) = a NEW app session that starts from a
summary the APP writes from project records (never the model): first request + answered questions, later requests,
the design now (idea, latest version, size, parts/qty/sizes/colours), approval, plan cards (share_plan), checks
(failing, out of date, motion check, still open), things to buy, prints + outcomes/lessons, refs/ files + pins, and the
last 6 user/designer messages (trimmed). Redacted: known secret values, key shapes (sk-ant-, sk-/sk-proj-, xai-), the
project folder made relative, the home folder as `~`, every other absolute path `<path>`. Chained handoffs carry the
earlier summary's requirements/decisions forward. Stored as `.studio/handoffs/<id>.json` (`HandoffRecord`) + `<id>.md`
(exactly what the designer gets); `.studio/handoffs/pending.json` maps a session to the handoff it delivers next.
- POST /api/projects/:id/agent/handoff/preview {reason: "switch"|"fresh"|"idea", profileId?, model?} -> HandoffPreview
  (nothing changes. `needed` false = no earlier messages, or a switch within one runtime (native resume). `resume` =
  an earlier chat of the target runtime on this idea, offered as "Continue the earlier … chat", with `resumeMarkdown`)
- POST /api/projects/:id/agent/handoff {reason: "switch"|"fresh", profileId?, model?, markdown? (the user's edit),
  mode?: "new"|"resume", resumeSessionId?} -> {sessionId, handoffId}. Ends the live session, applies the designer pick,
  creates the chat (ProjectSession.handoff = {id, fromSessionId, from, reason}; runtime/profileId/model recorded) or picks
  the earlier chat (resume), and activates it. Timeline: the new chat opens with `notice {code: "handoff.started", data:
  {handoffId, reason, mode, from, to}}` (item `handoff:<id>`); the chat left gets `notice {code: "handoff.left"}`. The
  summary is prepended to the agent text of the chat's next message (once; `deliveredAt`), with a header saying it's the
  app's handoff; the bubble shows only what the user typed. A new chat on another runtime starts with `resume: null`.
- GET  /api/projects/:id/agent/handoffs/:handoffId -> HandoffRecord ("read the summary")
- POST /api/projects/:id/ideas/try-with {profileId (null = default), model?, markdown?, title?} -> {branch, sessionId, handoffId}
  ("Try this with another designer": a new idea from the open version whose chat starts on that designer from the
  summary; compare them in Compare, whose sides now carry `designers: IdeaDesigner[]` — runtime, designer, model,
  version (from session.started), own cost labelled known (billed) / estimated / unknown).
- The designer changed outside the dialog (the default in Agents): the next message still hands over automatically
  (reason "auto", same summary). Opening a chat held by another runtime than the project's designer brings that chat's
  recorded designer back (it resumes natively instead of handing over again).

## Agent profiles + Agents screen (R11b/R11c — server/agent/profiles.ts, server/routes/agent-profiles.ts)
A profile (`AgentProfile`) = which designer runs (`runtime`: "claude"; "codex", "grok", "api" later), `model`
(null = runtime default), `auth` (`{kind:"subscription"}` = the user's own login, or `{kind:"api-key", credentialRef}`),
`effort`, `budget.maxUsdPerRun`, `policy` ("design-sandbox"), Advanced `binaryPath` / `endpointRef`. Stored non-secret in
`<STUDIO_HOME>/agent-profiles.json` `{version:1, defaultProfileId, profiles, migration}`; keys live only in the secret
store (refs `anthropic.apiKey`, `profile.<id>.apiKey`). Writes are refused if a known secret value would land in the file.
- Migration (startup, idempotent): settings.model + the `anthropic.apiKey` ref (or ANTHROPIC_API_KEY) -> default profile
  "claude" (API key if one is set, else subscription). Written, read back, compared and the ref re-checked before it's
  relied on; until verified the same profile is derived from settings and the migration retried. `migration` records
  the old model and the key's ref/source, never the key. settings.json is left as is; GET /api/settings `model` mirrors
  the default profile's model and PUT `model` updates it; PUT/DELETE /api/secrets/anthropic.apiKey switch the migrated
  profile to/from that key (old clients keep working).
- Resolution: project `agentProfileId` (.studio/state.json) else the default; the project's `agentModel` applies only
  under the runtime it was picked for (`agentModelRuntime`, absent = "claude"). The coordinator freezes the result
  (`AgentProfileSnapshot`) per run: `run.started` carries `profile {id, name, runtime, budgetUsd}`; adapters get it as
  `AgentSessionContext.profile`. A live idle session started with a different runtime/sign-in/effort/program is
  restarted on the next message (resumed if same runtime); a model-only change is switched in place. A conversation
  held by another runtime (`Project.sessions[].runtime`) isn't resumed: a new one starts with a notice.
- Budget: when a run's spend (billed with an API key, the estimate on a subscription) passes its frozen
  `maxUsdPerRun`, it's interrupted with `notice {level:"error", code:"budget.exceeded", data:{limitUsd, spentUsd}}`.
- GET    /api/agent/profiles                     -> AgentProfilesResponse {defaultProfileId, profiles: AgentProfileView[] (with
         masked `credential`, `isDefault`), runtimes: AgentRuntimeInfo[] (registered = available, known others = coming soon), migration}
- POST   /api/agent/profiles {name, runtime, model?, auth?: {kind}, effort?, budget?, ...} -> AgentProfileView  (runtime must be
         registered; any key/secret/token field -> 400; an api-key profile gets ref `profile.<id>.apiKey`)
- PUT    /api/agent/profiles/:id Partial<AgentProfile> -> AgentProfileView   · DELETE /api/agent/profiles/:id -> {ok} (not the default; its own key is deleted)
- PUT    /api/agent/default-profile {profileId} -> AgentProfilesResponse
- PUT    /api/agent/profiles/:id/key {value} -> AgentProfileView  (stored + verified in the secret store, profile switched to it)
- DELETE /api/agent/profiles/:id/key -> AgentProfileView  (key removed, profile back to subscription)
- POST   /api/agent/profiles/:id/test {message?: boolean} -> AgentConnectionResult {ok, steps[], summary, fix?, reply?, costUsd?}
         Default: install + sign-in/key check, no paid call (Claude: `claude auth status`; an API key is checked by listing
         models, which is free). `message: true` = one tiny paid turn, no tools, no project ("Send a test message").
- GET    /api/agent/failures?profileId=&limit=   -> AgentFailure[] newest first (failed runs, budget stops, sign-in failures;
         `<STUDIO_HOME>/agent-failures.jsonl`, redacted, bounded)
- GET    /api/projects/:id/agent/profile          -> ProjectAgentChoice {profileId (own or null), model (own or null), effective}
- POST   /api/projects/:id/agent/profile {profileId|null, model|null} -> ProjectAgentChoice  (per-project designer + model;
         null/null = follow the default). POST …/agent/model still sets only the model (checked against the effective runtime).
- GET /api/agent/runtimes probes every registered runtime; additive fields `login {plan, fix}` and `effortLevels`.
- WS: `agent.profiles.changed` (refetch), `agent.failure {failure}`.
- New runtime (R11d): implement `AgentRuntime` (server/agent/runtime/types.ts: probe, create, optional info /
  checkConnection / testMessage), read `ctx.profile` (model, auth.credentialRef via getSecret, effort, binaryPath), and add
  it to `RUNTIMES` in server/agent/index.ts. Its card, health, capabilities and the switcher entries appear automatically.

### Codex runtime (R11d — server/agent/runtime/codex/)
Runtime `"codex"`: `codex app-server` (Codex CLI, JSON-RPC over stdio), one process per session in its own process
group with the parent-death watchdog. App tools + `AskUserQuestion` are Codex dynamic tools answered on the same
connection (registry identity/gates as for Claude). Model/effort/program/key come from the profile.
- Sign-in (subscription profiles, `Settings.codex.login`): `"app"` (default) = Crease's own Codex home
  `<STUDIO_HOME>/codex`, nothing from ~/.codex used, isolation `full`; `"user"` = the user's ~/.codex login with its
  config overridden, isolation `partial` (its command rules still load) and refused unless
  `Settings.codex.allowPartialIsolation` (Agents → Codex card: one "Sign in" choice — sign in for Crease / OpenAI
  API key / my Codex login on this Mac — plus the "Allow partial isolation" opt-in; PUT /api/settings {codex: {login?,
  allowPartialIsolation?}} merges, validates (400 otherwise) and emits agent.profiles.changed). API-key profiles: `<STUDIO_HOME>/codex-api` with an in-memory credential store
  (key from the secret store via account/login/start, never written), isolation `full`.
- POST   /api/agent/runtimes/codex/login -> {authUrl, loginId}  (ChatGPT browser sign-in into the app's Codex home; open
         authUrl. `SetupFix {kind:"codex-login"}` does this; the probe's `login.fix` carries it while signed out.)
- Probe adds `ready` (can start now) and `defaultModel`; `capabilities.isolation.level` "full" | "partial" + `reason`.
- Sessions: Codex picks thread ids, so the app keeps `app session id -> {runtime, nativeId}` in
  `.studio/sessions/native-refs.json`; resume = thread/resume, fork = thread/fork (no model call).
- Usage: tokens only (`usage: "tokens"`); `billedUsd`/`estimatedApiUsd` stay null (never Claude prices).
- Messages mid-turn: `turn/steer {threadId, input, expectedTurnId, clientUserMessageId: runId}`; refused (a compact or
  review turn, the turn just ended, another turn) = queued and started as the next turn right away. Steered but unread
  when the turn ends = first in the next turn.

### Grok Build runtime (R11e — server/agent/runtime/grok/)
Runtime `"grok"`: `grok agent --no-leader stdio` (Grok CLI, ACP = JSON-RPC 2.0 over stdio), one process per session in
its own process group with the parent-death watchdog. Client capabilities `fs {readTextFile, writeTextFile}` +
`terminal`: Grok's file reads/writes and every shell command come back to the app (`fs/*`, `terminal/*`), which
performs them (writes with Claude's write policy + `.grok/`, `.agents/`, `AGENTS.md`; reads inside the project and
the bundled libraries; commands under the app's own `sandbox-exec` profile: no network, project-only writes). App
tools: a per-session MCP server on 127.0.0.1 (streamable HTTP, bearer token = the session's bound tools), reached by
the model as `use_tool studio__<name>`; plus `view_image` (project images; ACP prompts take no images, so attached
images are saved under `.studio/agent-images/`). Questions: `_x.ai/ask_user_question` -> the app's question cards.
Permissions: decided by the app's policy (allow once: app tools, edits, commands, questions; refuse: anything else);
Grok ends the turn on a refusal, so tools that never ask (scheduler, image/video generation, workflows) are denied
by a PreToolUse hook in `<GROK_HOME>/hooks/printstudio.json` instead (a tool error; the turn goes on). Model/effort/program/key come from the profile; `session/set_model` switches models.
- Sign-in: subscription profiles use Crease's own Grok home `<STUDIO_HOME>/grok` (HOME for the process is an
  empty app folder; nothing from ~/.grok, ~/.claude, ~/.agents is loaded), isolation `full`. API-key profiles:
  `<STUDIO_HOME>/grok-api` with the key only in the process environment (`XAI_API_KEY`), isolation `full`.
- POST   /api/agent/runtimes/grok/login -> {authUrl, code}  (`grok login --device-auth` into the app's Grok home,
         grok/login.ts. The sign-in page asks the user to type or check `code`, so the app shows it big in a modal
         with Copy + "Open sign-in page". `SetupFix {kind:"grok-login"}` does this; the probe's `login.fix` carries it.)
- GET    /api/agent/runtimes/:kind/login -> RuntimeLoginStatus {state: idle|waiting|done|failed, authUrl, code, error}
         (codex | grok; the sign-in modal polls it. Grok: done = `grok login` exited 0; Codex: account/login/completed.)
- DELETE /api/agent/runtimes/:kind/login -> {ok}  (cancel a waiting sign-in)
- Probe: `grok --version` + `grok models` (sign-in state + models; no model call); `ready` needs sandbox-exec (macOS).
- Sessions: Grok picks session ids -> `native-refs.json`; resume = `session/resume`, fork = `_x.ai/session/fork`.
- Usage: tokens only (`usage: "tokens"`); `billedUsd`/`estimatedApiUsd` stay null.

### Direct API runtime (R11f — server/agent/runtime/api/)
Runtime `"api"` ("API connection"): no agent program; the app runs the tool-calling loop itself. Built in, always
"installed"; key-only (`authKinds: ["api-key"]`: a new profile starts on its own `profile.<id>.apiKey` ref, and removing
the key keeps it a key profile). Profile fields: `apiProtocol` (`"anthropic"` default | `"openai-chat"`), `endpointRef`
(base URL; null = `https://api.anthropic.com` for anthropic; required for openai-chat, e.g. `http://localhost:11434/v1`),
`model` (null = `claude-opus-5-5` on anthropic; required on openai-chat), `effort` (anthropic adaptive-thinking models).
An endpoint on a printer's host is refused before any request. A local openai-chat server needs no key.
- Protocols (endpoint.ts `Endpoint`): **anthropic** = Messages API via `@anthropic-ai/sdk` (streaming, tool use with
  eager input streaming on the first-party API, base64 images, prompt caching: system breakpoint + automatic top-level
  `cache_control`, adaptive thinking with summaries on 4.6+/5.x models, usage). **openai-chat** = Chat Completions
  (`/chat/completions` SSE, function tools, tool-call deltas by index, `image_url` data URLs, `stream_options.include_usage`,
  `/models`): tested against a scripted server only; the Agents card and Test connection label real servers "untested".
- Tools: `read_file` / `list_files` (project + bundled libraries, never `policy.denyRead`; images come back as images),
  `write_file` / `edit_file` (policy.ts `protectedReason`: project only, no build/, renders/, .studio/, .git/, .claude/,
  project.json, G-code; writes reported for approval tracking), `read_skill` (bundled skills as reading), every registry
  tool (identity + gates from the registry) and `AskUserQuestion` (host.askUser). No shell, no network tools. Inputs
  validated (zod); invalid input, malformed JSON (`{"INVALID_JSON": raw}`) and unknown tools are tool errors the model reads.
  Timeline names follow Claude's (Read/Write/Edit/Glob/Skill, `mcp__studio__<name>`).
- Loop: one user turn = model steps until no tool calls (`maxTurns`, default 80 steps -> `run.completed
  {subtype:"error_max_turns"}`). Retries with backoff (retry-after honoured) on 429, 5xx, 529/overloaded, connection
  errors and streams that break off midway (6 attempts; one `notice {code:"api.retry"}`); only a whole response is kept.
  `max_tokens`: a cut-off tool call isn't run (the model is told), a cut-off reply is continued (twice). `refusal`: the
  run ends, calls not run. Stop = abort the request/question/tool, unanswered calls closed with errors (`run.interrupted`).
  Budget: the coordinator's `budget.exceeded` interrupt, driven by `usage.updated` after each step.
- Conversation store: `.studio/sessions/api/<sessionId>.jsonl` (`meta`, `msg` per message with the provider's own blocks
  kept verbatim, `snapshot` after a rewrite). Resume and fork rebuild from it (fork = copy); no provider-side session.
  The system prompt and tool list are frozen per session (cache + preserved thinking); thinking is stripped once on
  resume, on a model switch, after trimming, or on a thinking-signature 400 (then retried).
- Context trimming: when a step's prompt passes ~150k tokens, oldest first and never the last 4 messages: tool-result
  images, then tool output, then file bodies in tool inputs; the user's text and photos, the model's text, tool calls,
  questions/answers and `share_plan` stay (`notice {code:"context.trimmed"}`).
- Usage: provider-reported tokens; `billedUsd` (= `estimatedApiUsd`) computed from Anthropic's published prices
  (pricing.ts) for the first-party Anthropic API and known models only, cumulative per session; any other endpoint or
  model: null (tokens only, never guessed). `billing: "api"`. Errors: `notice {code:"api.auth"}` (failure log "auth") +
  `run.failed` on a refused key; plain-words `run.failed` otherwise.
- GET    /api/agent/profiles/:id/models -> AgentModelList {models, defaultModel, error?}  (the profile's own endpoint's model
         list, free; runtimes without per-profile discovery return their probe's list). Test connection = key saved +
         model list (free) + model listed (+ "untested" step for openai-chat), with `models` in the result; Send a test
         message = one tiny call, no tools, cost when priced.

### Permission requests (R11d; runtimes with permission callbacks: Codex)
The app's policy decides first (leaving the sandbox, network, writes outside the project / onto app paths, the app's
secret files: refused without asking). What's left (e.g. reading a photo outside the project) becomes a card.
- GET    /api/projects/:id/agent/permissions -> AgentPermissionRequest[]  (re-show after reload)
- POST   /api/projects/:id/agent/permission {requestId, allow: boolean} -> {ok:true}  (Allow once / Deny; 404 if gone)
- Event `permission.requested {requestId, tool, input: {title, detail}, reason}`; WS `agent.permission {request}`,
  `agent.permission.resolved {projectId, requestId, allowed}` (null = cancelled by stop/close).

## Slicing + printer (owner: slicer/printer agent — server/routes/printer.ts)
- POST   /api/projects/:id/parts/:partId/slice {machineId?} -> SliceResult (exports STL if needed, runs OrcaSlicer CLI)
         Parts with 2+ color() colours slice multicolour: each colour -> loaded CFS slot (machine.filaments); result adds
         filamentBySlot + colorChanges. 400-style error text if a colour isn't loaded or geometry is outside every color().
- POST   /api/projects/:id/slice-plate {parts?: {partId, qty?, overrides?}[], machineId?, intent?, overrides?} -> PlateSliceResult
         (parts[].overrides = per-part OrcaSlicer process settings on top of the plate intent, e.g. a test plate comparing
         ironing on/off; the same part may appear twice. Listed in each plate's preview.notes)  (default: all parts × qty, arranged
         together; build/plate.gcode, or plate-1.gcode, plate-2.gcode… if they need more than one bed; emits slice.done per plate)
         Colour plan: when every part is single-colour but the colours differ (2+ slots, CFS machine, no explicit
         `print_sequence` override), one plate would swap colour + purge on every layer. The server also slices
         "by_object" (OrcaSlicer print_sequence = by object, shortest part first; OrcaSlicer's own gantry-clearance check
         decides if it's safe; spilling onto more beds = not safe) and "per_colour" (one plate per slot) and keeps the
         cheapest safe one (print time + 10 min handling per extra plate; ties prefer by_object). Result `colorPlan`:
         {chosen, summary (plain words, e.g. "Printing them one colour at a time saves 50 min and 8 g: …"), options[]
         (strategy, ok, reason?, plates, estimatedTimeS, filamentG, colorChanges)}. by_object adds print_sequence to
         `overrides` (not to the job's userOverrides, so a re-slice compares again).
- GET    /api/printer/status                            -> PrinterStatus
- POST   /api/printer/test                              -> {ok, info?, error?}
- GET    /api/printer/webcams                           -> Webcam[]  (from Moonraker /server/webcams/list)
- GET    /api/printer/snapshot?name=                    -> image/jpeg|png  (one frame proxied from the printer camera; 404 if none)
- POST   /api/projects/:id/print-requests {gcodePath}   -> PrintRequest  (user-initiated; emits print.request)
- GET    /api/print-requests                            -> PrintRequest[]  (still-pending requests; re-show the dialog after a reload)
- POST   /api/print-requests/:requestId {approved, bedClear} -> {ok, filename?}  (upload + start only if approved && bedClear)
- POST   /api/printer/pause | /api/printer/resume | /api/printer/cancel -> {ok}
- POST   /api/printer/firmware-restart                  -> {ok}  (default machine; see /api/machines/:id/firmware-restart)

## Catalog (owner: slicer/printer agent — server/routes/catalog.ts, server/db)
SQLite index at `<STUDIO_HOME>/index.sqlite`, rebuilt from the project folders if missing. Print records are also
stored in `<project>/.studio/prints/<id>.json` so they survive a rebuild.
- GET    /api/catalog?q=&tag=&sort=updated|created|name|printed&limit=  -> CatalogProject[]  (q: prefix full-text over name, tags, part ids, session titles + first prompts)
- GET    /api/catalog/tags                              -> {tag, count}[]
- POST   /api/catalog/rebuild                           -> {projects, sessions, prints}
- GET    /api/projects/:id/sessions                     -> CatalogSession[]  (newest activity first)
- GET    /api/prints?projectId=                         -> PrintRecord[]  (newest first; all projects if no projectId. The
         Overview and Printer tab list a project's prints; "How did it turn out?" / "Change" reopens the result card.
         `practice: true` = printed on the practice printer: labelled "Practice", never rated. Also on
         CatalogProject.lastPrint, PrintJobView and OverviewPlate.)
- GET    /api/prints/:printId                           -> PrintRecord
- POST   /api/prints/:printId {result?: "success"|"failed"|null, notes?: string|null} -> PrintRecord  (post-print result prompt)
Print records are created automatically when an approved print starts (state "printing") and closed when the printer
reports complete/cancelled/error.

## Print outcomes + calibration (owner: feedback — server/outcomes, server/routes/outcomes.ts, R15)
A print record carries `jobId` (the immutable job it printed), `actualDurationS` (start → end as the app saw it) and
`outcome: PrintOutcome | null`. Saving an outcome writes the prints row + `.studio/prints/<id>.json` and, when there
is a job, `.studio/jobs/<jobId>/outcome.json` (`{jobId, outcomes: PrintOutcome[]}`, one per print of those bytes) with
photos in `.studio/jobs/<jobId>/photos/` (no job: `.studio/prints/photos/<printId>/`). Jobs with an outcome are never
pruned. `result`/`notes` mirror the outcome (failed → "failed", else "success").
- POST   /api/prints/:printId/outcome PrintOutcomeInput -> PrintRecord  (rating great|ok|problem|failed, categories,
         notes, measurements, fits, photos (omitted lists keep the saved ones); proposes a lesson (`outcome.lesson.status = "proposed"`) when there's
         something to learn. rating "failed" on a job marks that job failed (plate stays at the cursor for retry).
         Emits `prints.changed {projectId}`.)
- POST   /api/prints/:printId/photos {mediaType, data(base64)} | {fromCamera: true} -> {name, url}  (≤ 8 MB; fromCamera
         grabs the print's machine camera snapshot)
- GET    /api/prints/:printId/photos/:name               -> image
- DELETE /api/prints/:printId/photos/:name               -> {ok}
- POST   /api/prints/:printId/lesson {action: "accept"|"dismiss"|"undo", text?} -> PrintRecord  (accept writes `text`
         (edited) or the proposal to the machine's lessons.md; undo removes exactly that line)
- GET    /api/projects/:id/outcomes                      -> PrintOutcome[]  (newest first; the agent's read_print_outcomes)
- GET    /api/calibration?machineId=&intent=&material=&nozzleMm= -> CalibrationReport  (time factor + tolerance
         suggestions for that scope; apply a suggestion with PUT /api/machines/tolerances?machine=)
- GET    /api/machines/:id/lessons                       -> PrinterLesson[]
- DELETE /api/machines/:id/lessons {line}                -> PrinterLesson[]  (remove one lesson line)
- Time calibration: factor = median(actual / estimated) over the newest ≤ 10 complete prints in scope (machine + nozzle
  + material + intent; falls back to any print on the machine), ratios outside 0.5–3 and > 25% from the median dropped.
  PrintJobView and PrintRequest carry `adjustedTime: AdjustedTime | null`; show "≈ <time> · adjusted from your last N
  prints".

## Assembly guides (owner: assembly — server/routes/assembly.ts, server/assembly)
`assembly.json` (validated by `server/assembly/schema.ts`, types `Assembly*` in shared/types.ts) + `assembly.scad`
(includes the generated `lib/studio_assembly.scad` + `lib/studio_assembly_data.scad`, the latter generated from
assembly.json placements/motions; takes `step`, `explode`, `explode_dir`, `explode_dist`, and `motion_<id>` = 0..1 per motion).
  Motion order (canonical, R06): a part in several motions is posed by them in assembly.motions order, the first listed
  applied first (axes/origins in assembly coordinates at the placed pose), so list an inner motion (lid hinge) before
  the one that carries it (drawer). check_motion, the step-art scene, the 3D viewer and studio_assembly_data.scad
  (`at()` wraps the first motion innermost) all follow it (server/assembly/motion-order.test.ts).
- GET    /api/projects/:id/assembly                    -> AssemblyInfo {assembly|null, error?, hasScad, guideUrl|null, stepImages, shoppingListUrl, partModels, motionCheck?}
  `hardwarePlacements[]` = {hardware, instance?, translate, rotate?, movesWith?}: the item standing upright on z = 0,
  centred on Z (screws head-up), rotated then translated like a part; `movesWith` ("part" or "part#i") makes it follow
  that part's motions. Optional; used by check-motion only.
  `partModels[partId]` = mesh URL (build/<id>.view.3mf, else .3mf, else .stl). Assembled scene: for each placement,
  rotate (X, then Y, then Z, degrees) then translate the part mesh; then apply each motion containing the part
  ("part" = all instances, "part#i" = one): rotate `value`° about `axis` through `origin`, or translate `value` mm along `axis`,
  value in `range` (rest = `rest` ?? range[0]).
  R14 step fields (all optional, additive; old guides unchanged): `steps[].action` ("place" | "insert" | "slide" |
  "push" | "snap" | "twist" | "screw": the arrow type), `steps[].insert` [x,y,z] (direction the new items travel to go
  in; default -explodeDirection, else a placed hardware item's own -Z, else inferred from the placements),
  `steps[].glue[]` {kind: "glue"|"no-glue", at, size, part?, label?} (box in assembled mm; moves with `part` while
  exploded), `steps[].closeUp` (true | false | {at, size?}), `steps[].focus[]` (part refs the step acts on when it adds
  nothing new).
  `AssemblyInfo.art`: AssemblyArt {version, hash, steps: StepArt[]} (shared/types.ts; build/assembly-art.json) or null.
  Present when every part instance is placed and every drawable hardware item (not glue/tape/zip-tie/electronics/other)
  has a hardwarePlacement, and the art was drawn from the current assembly.json + part meshes. StepArt (n = 0 is the
  finished assembly): {camera {dir, up, target, auto}, instances [{key "id#i", kind, id, index, letter?, role
  new|done|focus|hidden, offset}], arrows [{kind, from, to, axis?, center?, radius?, targets}], callouts [{label,
  letters?, qty?, tone new|context, anchors [{key, point}], labelAt}], glue [{…region, min, max, ownerKey?}],
  closeUp {center, radius}|null, image, svg}. All points are assembled mm at the FINAL position: add the instance's
  `offset` × explode for moving items (arrows are drawn at explode = 1). Part letters: A, B, … over parts[] in order,
  copies in order (shared/assembly-art.ts `partLetters`), the same as the plate labels when the plate is sliced from
  the assembly's parts list. Projection: shared/assembly-art.ts (orthographic, `project`/`unproject`).
- POST   /api/projects/:id/assembly/guide              -> {guideUrl, steps}  (renders all steps, writes build/assembly-guide.html).
  With art available, each step is drawn from geometry (server/assembly/illustrate.ts + raster.ts: deterministic
  software render, muted earlier parts, coloured new ones pulled back along the insertion direction, auto camera) to
  renders/assembly-step-<n>.art.png (raster), .svg (raster + vector overlay) and .png (overlay composited); the guide
  inlines the SVG so arrows, callouts, hatched glue regions and close-up insets print as vectors. Otherwise the steps
  are OpenSCAD renders of assembly.scad as before.
- POST   /api/projects/:id/assembly/steps/:n/render {explode?: 0..1, pose?: {motionId: 0..1}} -> {n, url, cached}  (n = 0: finished assembly); drawn from geometry when art is available (also returns `art: StepArt`), else assembly.scad (`artNote` says why)
- POST   /api/projects/:id/assembly/check-motion       -> MotionCheck (shared/types.ts; server/assembly/motion.ts):
  {ok, status: "ok"|"problems"|"incomplete", incomplete[], restCollisions, motions[{id, label, unit, samples, ok, collisions,
  minClearanceMm, clearancePair, clearanceAt, freeRange, coverage{from, to, positions, coarse, refined, smallestStep, capped}, text}],
  combined[{values, label, ok, collisions}], scope{parts, hardware, skipped[{id, reason}]}, notChecked[], warnings, summary, checkedAt}
  Each motion: 9 evenly spaced positions + rest, then extra positions wherever a collision could still hide between two
  checked positions (gaps at both ends smaller than the farthest any moving point travels), up to 48 per motion; other
  motions at rest. Pairs of motions that could meet are also posed together at the ends of their ranges (up to 6 pairs).
  Placed hardware (`assembly.hardwarePlacements`) is included as simple shapes (server/assembly/proxies.ts).
  Missing placements, parts that fail to load or aren't closed solids, or placed hardware with no known size => status
  "incomplete" (ok false). Saved to build/motion-check.json as `{inputs: SourceStamp, check}` (R07: the assembly stamp it
  was checked against); `AssemblyInfo.motionCheck` returns it with `stale` + `staleReasons` (a part source, shared lib
  file, override, assembly.json or assembly.scad changed since; same as GET /validity `assembly.motion`). Never covers
  strength, friction or spring force.
  Building the guide records its stamp in build/assembly-guide.json (GET /validity `assembly.guide` covers the step renders too).
Building the guide also writes build/shopping-list.md and build/shopping-list.csv (hardware consolidated, pack suggestion,
store search links from Settings.sourcing; `AssemblyInfo.shoppingListUrl`). Store registry: server/assembly/stores.ts
(`StoreId`; Settings.sourcing = {country, stores[]} in preference order, default US Amazon first).
- GET    /api/sourcing/stores                          -> {stores: SourcingStoreInfo[], countries: string[], defaults: SourcingSettings}
The guide is a self-contained HTML page (images inlined, A4 print CSS) served from
/api/projects/:id/artifacts/build/assembly-guide.html; show it in an iframe and print/PDF it with Electron printToPDF.
Links: store links are always labelled "Search on <store>" (a search, not a product); `hardware[].listings` are shown
as "Verified listing, checked <date>" and only exist when the agent opened the page.

### Bill of materials (R17 — server/assembly/bom.ts)
- GET    /api/projects/:id/bom                         -> ProjectBom {items: BomItem[], region, totals{toBuy, have, estUsd|null, estimated, unpriced}, priceNote|null}
- PUT    /api/projects/:id/bom/have {key, have: true|false|null} -> ProjectBom   ("I already have this"; null = back to the parts bin's answer)
- GET    /api/parts-bin                                -> PartsBinItem[]
- PUT    /api/parts-bin {key, name, inBin}             -> PartsBinItem[]   (global "my parts bin": pre-ticks matching items in every project)
Categories: printed / purchased / make (filament offcuts) / consumable / tool. `key` is the buyable spec ("screw:m3x12:button",
"magnet:disc6x3", "consumable:superglueca"), not the assembly id, so ticks and the bin survive renames and match across
projects. Ticks live in `<project>/.studio/bom.json` (never exported); the bin in `<STUDIO_HOME>/parts-bin.json`.
`pack`: listing packSize when a verified listing gives one, else a typical pack ("Usually sold in packs of ~100: you need 4").
`substitutes` / `fit` come only from assembly.json (`hardware[].substitutes[{size, purchaseHint?, note?}]`, `hardware[].fit`),
plus generated dimension notes for screws, magnets and bearings. `estCost`: verified listing price ("$x" parsed) × packs,
else a typical US price per common pack (US only); tools are never counted. `totals.estUsd` = what's still to buy.

## Build packs (R16 — server/pack, server/routes/pack.ts)
A build pack is one .zip: `printstudio-pack.json` (BuildPackManifest: format "printstudio-build-pack" v1, app version,
project name/description/tags/licence/intent, per-part size/material/print settings, every file with sha256 + role,
labelled G-code, what was excluded), `CHECKSUMS.sha256` (`sha256sum -c` format, includes the manifest), `README.txt`,
`source/` (project.json scrubbed of sessions/printer, parts/, lib/, assembly.json/.scad, other source files),
`guide/assembly-guide.html` (+ `.pdf` when the desktop app's printToPDF is available), `bom/` (shopping-list.md/.csv,
bom.json without personal ticks), `renders/<part>-iso.png`, `renders/assembly-complete.png`, `models/<part>.stl`,
optional `gcode/` (current jobs only, each labelled "for <machine>, <nozzle> mm nozzle, <material> — won't fit other
printers", + gcode/README.txt) and optional `notes/` (print-notes.json from the catalog, R15 outcomes `.studio/prints/*.json` -> notes/prints/, `.studio/jobs/<sha>/outcome.json` + photos/ -> notes/jobs/<sha>/; only with includeNotes).
Never included: .git, .studio (sessions, transcripts, checks, job state, "already have" ticks), Claude Code config
(.claude, CLAUDE.md, .mcp.json), credential-like files (.env, keys, secrets*.json), links. Every text file is scrubbed:
the project folder, STUDIO_HOME and the home folder become `<project>`/`<Crease data>`/`~`, any `/Users/<name>`,
`/home/<name>`, `C:\Users\<name>` becomes `<user>`, and known secret values/key patterns are redacted.
- GET    /api/projects/:id/pack/preview?license=&includeGcode=1&includeNotes=1 -> BuildPackPreview
- POST   /api/projects/:id/pack {license?, description?, includeGcode?, includeNotes?} -> application/zip
         (attachment "<slug>.buildpack.zip"; licence/description are saved on the project; default licence "All rights reserved")
- POST   /api/packs/import  (body: the .zip, content-type application/zip or application/octet-stream, ≤ 512 MB) -> BuildPackImportResult
Import verifies every file against the manifest and CHECKSUMS before writing anything (400 "damaged or was changed…
Nothing was imported" otherwise; unlisted extra files are refused too), then creates a NEW project (slug of the name,
-2… if taken) with `source: {importId}`; `imports/<importId>/` keeps source.json (licence, shown in the catalog),
pack.json and reference copies of G-code/notes/PDF (git-ignored; never print jobs here). R09: trust recorded under
the new id is forgotten and any assistant settings in the pack go straight to `.studio/agent-config-disabled/`
(`disabledAgentConfig`), off until enabled via /agent-config/enable. Copies of the app's own skills are dropped.

## Onboarding + starters (owner: renderer agent — server/routes/onboarding.ts, server/onboarding.ts)
- GET    /api/onboarding/checks                         -> {claude, openscad, orcaslicer}: SetupCheck  (no model call). Claude: is
         Claude Code installed (Settings `claudePath`, PRINTSTUDIO_CLAUDE_EXECUTABLE, the SDK's bundled binary when
         installed = dev, else the user's: PATH, ~/.local/bin, ~/.claude/local, Homebrew, /usr/local/bin; version, and
         a warning when older than the SDK's claudeCodeVersion), then the default profile's access: its API key, or the
         user's own Claude Code login via `claude auth status`. Each check carries path/version/source when found, an
         optional `fix` and `altFix` (open-url install/download page, `anthropic-key` {profileId} = paste a key ->
         PUT /api/agent/profiles/:id/key, `claude-use-login` {profileId} = PUT the profile's auth to subscription,
         `claude-login` only with PRINTSTUDIO_DEV_CLAUDE_LOGIN=1). OpenSCAD/OrcaSlicer: the Settings path if it exists, else discovered
         in /Applications, ~/Applications, Homebrew, PATH (server/tools/discovery.ts; env PRINTSTUDIO_TOOL_SEARCH_DIRS
         replaces the search folders, e.g. an empty dir to test the missing-tool paths). Empty Settings path = automatic.
- POST   /api/onboarding/claude-login                   -> {ok, error?, command}  DEV ONLY: with PRINTSTUDIO_DEV_CLAUDE_LOGIN=1
         opens Terminal running `claude auth login` (macOS); otherwise always {ok: false, error} (public builds never
         sign in to Claude for the user, INVENTORY B1)
- POST   /api/onboarding/printer {name?, host?, port?, practice?} -> {ok, practice, info?, error?}  (saves the first printer's address and tests it; practice = the built-in practice printer, the default unless a real printer is)
- GET    /api/machines/tolerances?machine=              -> {slidingFitMm, pressFitMm, holeCompensationMm}
- PUT    /api/machines/tolerances?machine= {…partial}   -> same  (fit-test results; per printer via setMachineTolerances())
- GET    /api/starters                                  -> Starter[]  (resources/starters/<id>/; env PRINTSTUDIO_STARTERS overrides the folder)
- GET    /api/starters/:id/thumbnail.png
- POST   /api/starters/:id/use {name?}                  -> Project  (copies the starter into a new project, git-inits, renders its parts)
Settings.onboardedAt is set when the first-run wizard is finished or skipped. First-run setup (U3) is Welcome -> Designer ->
Printer -> Preferences -> Done, each skippable; what is left is computed from real state (default designer ready, any
printer, Settings.units chosen) and offered as "Finish setup" in Library and Settings.
Settings.units: "mm" | "in" (unset = not chosen = mm; everyone starts in mm). Every length the app shows is in this
unit (sizes, Change size sliders, limits, 3D plate grid/readouts, Compare, print dialog); shared/length.ts formats and
parses (fractions like 2 1/2"). Designs and the API stay in mm. A Customizer setting is a length when its comment says
"(mm)" (or its name ends in _mm). The server writes user-facing sizes (overview next step) in this unit; the designer
states assumed sizes in it first. The theme (light/dark/system) is a renderer preference (localStorage "theme", theme-provider).

## Settings (owner: lead — server/routes/settings.ts)
- GET    /api/settings  -> Settings   (`auth` = SettingsAuth: masked API-key status + which auth the agent uses)
- PUT    /api/settings  Partial<Settings> -> Settings   (`auth` is ignored; a legacy `anthropicApiKey` field -> 400,
         use the Secrets routes)
- `claudePath` (optional): absolute path to the user's Claude Code (`~/` allowed); empty = automatic. Other values -> 400.
- `telemetry` (optional): anonymous usage reports. true = yes, false = no, unset/null = not asked yet (off). Other
  values -> 400. Yes creates a random install id in `<STUDIO_HOME>/telemetry.json`; no deletes it. What is sent (and
  nothing else): server/telemetry.ts `SCHEMA`, batched to GA4 every 30 s and on close. Nothing is sent without
  CREASE_TELEMETRY_SECRET, under tests, or with CREASE_TELEMETRY=0. Setup asks in Preferences; anyone onboarded
  without an answer gets one small Yes / No thanks bar.
- POST   /api/telemetry/onboarding {skipped: boolean} -> {ok}  (first-run setup closed; reported only while onboardedAt
         is unset, so call it before setting onboardedAt)
- `uiMode` is retired (U2: no Beginner/Maker modes; every screen is simple with in-place details). An old value in
  settings.json is ignored and dropped on the next save; a PUT carrying it is accepted and the field ignored.
- POST   /api/settings/test-openscad -> {ok, version?, error?}
- GET    /api/about -> AboutInfo  (Settings > About: name, version, licence, dataDir = STUDIO_HOME, OS, runtime;
         repoUrl/issueUrl only when package.json has a `repository`, else null. Tool versions: /api/onboarding/checks.)

## Secrets (owner: secrets — server/secrets.ts, server/routes/secrets.ts)
Secret values (API keys) never appear in any response, settings.json, machines.json, logs or agent transcripts.
Refs: `anthropic.apiKey`, `machine.<machineId>.apiKey` (Moonraker X-Api-Key). Unknown refs -> 400; a machine ref
for an unknown machine -> 404.
- GET    /api/secrets              -> {store: SecretStoreInfo, secrets: Record<SecretRef, SecretStatus>}
- PUT    /api/secrets/:ref {value} -> SecretStatus   (replace; value is trimmed, 1..4096 chars, no line breaks;
         written, read back and verified before 200)
- DELETE /api/secrets/:ref         -> SecretStatus   (remove; idempotent)
- Storage: <STUDIO_HOME>/secrets.json (mode 0600). Desktop app: each value encrypted with Electron safeStorage
  (macOS Keychain-backed), `source: "os-keychain"`. Standalone/browser-dev server (no Electron): values are kept
  unencrypted in that 0600 file, `source: "file"` (Settings shows a warning); the desktop app re-encrypts them on
  its next start. A value encrypted by the desktop app is `locked` for the dev server (set, but not usable there).
- `ANTHROPIC_API_KEY` in the server's environment shows as `source: "env"` when nothing is stored.
- Startup migration: a plaintext `anthropicApiKey` in settings.json or `connection.apiKey` in machines.json is
  moved into the store and removed from the JSON only after the stored value reads back identical.
- Agent auth: with an API key the agent subprocess gets it as ANTHROPIC_API_KEY (only that process);
  otherwise it uses the user's own Claude Code login (`auth.anthropic.method: "claude-login"`, plan billing). New
  installs default to the API key (no key yet); installs onboarded before profiles keep their login.

## WebSocket
- GET /ws  -> stream of ServerEvent JSON messages (see shared/types.ts)
- Resume (R08): every ServerEvent carries `eventSeq` (per server instance, +1 per event; `SequencedEvent`). The server
  keeps the last ≤10k events / 32 MB in a ring. Connect with `/ws?since=<last applied eventSeq>&instance=<instanceId>`
  (both omitted on first connect). The first frame is always `ws.hello {instanceId, eventSeq, resume, replayed}`:
  - `fresh`: no cursor given; load state normally and follow live events.
  - `replay`: the `replayed` missed events follow immediately, in order, then live ones (no gap possible in between).
  - `snapshot`: nothing can be replayed (different `instanceId` = server restarted, gap evicted, or a cursor from the
    future). Buffer live events, GET /api/sync/snapshot, apply it, then apply buffered events with eventSeq > the
    snapshot's `eventSeq`.
  `ws.ping {eventSeq, instanceId}` every 15 s: silence > 40 s means a dead socket (sleep/wake) -> reconnect; a ping
  ahead of the client's last eventSeq means loss -> snapshot; a different instanceId -> reconnect.
  Event handlers must be idempotent and keyed by ids (questions by requestId, print dialogs by requestId, timeline by
  `sessionId:eventId` of agent.event envelopes), since snapshot + buffered events can overlap.
- GET /api/sync/snapshot?projectId=  -> SyncSnapshot {instanceId, eventSeq, printRequests (with job), questions (all
  projects), agents (open sessions), machines (cached status; never polls a printer), unratedPrints (finished prints
  of the last 48 h with no rating, newest first, ≤ 5: the client queues their "How did it turn out?" cards unless the
  user put them off with Later, remembered per browser), project: {project, agent, assembly, jobs} | null,
  projectError?}. `eventSeq` is captured before reading, so the state reflects at least every
  event ≤ it. Replace pending questions / print requests as whole sets (answered or expired elsewhere -> gone). The
  client then refetches the transcript, sessions, checkpoints, and each part's latest render/check.
- `print.finished {printId, projectId, state}` fires once per logged print when it ends (complete/cancelled/error);
  the UI should prompt for a result and POST /api/prints/:printId {result, notes}.
- The printer host/port are read from settings on every poll, so PUT /api/settings {printer:{host,port}} takes effect
  within one poll (~2 s) without a restart.

## Machines (printer farm support)
- GET    /api/machines                         -> MachineWithStatus[]
- POST   /api/machines   Partial<Machine>      -> Machine   (id generated from name; default only with isDefault:true —
         adding never changes the default silently; with none marked the practice printer is saved as the default first;
         slicerProfile + bed size picked from `model` when omitted; body {isPractice:true, name?, filaments?, filamentSlots?,
         tags?, notes?, enabled?, isDefault?} adds (or updates) the built-in Practice printer — served in-process, no
         address, works in packaged builds; the given filaments are its own)
- Simulated printers (practice / dev mock, PrinterStatus.isMock) report the machine's own `filaments` back and are
  never synced into it (their CFS box is made up); real CFS printers still sync (filamentsSource "printer").
- GET    /api/machines/models?q=&limit=        -> MachineModel[]  (Add-machine catalogue from OrcaSlicer's bundled profiles)
- POST   /api/machines/test {host, port?, apiKey?} -> {ok, info?, error?}  (probe an address before saving; read-only;
         the apiKey is used for the probe only, never stored)
- PUT    /api/machines/:id  Partial<Machine>   -> Machine
- `connection.apiKey` is write-only on POST/PUT (string = store as secret `machine.<id>.apiKey`, null = remove,
  absent = unchanged); responses carry `connection.apiKeyStatus` (SecretStatus) instead. Deleting a machine
  deletes its key.
- DELETE /api/machines/:id                     -> {ok}     (refused while printing)
- POST   /api/machines/:id/default             -> {ok}  (for new projects; projects with no `printer` are first pinned to
         the current default so existing projects keep their printer. The app asks "Use <name> for new projects?")
- POST   /api/machines/:id/test                -> {ok, info?, error?}   (connection probe, read-only)
- GET    /api/machines/:id/status              -> PrinterStatus  (polled now)
- GET    /api/machines/:id/webcams             -> Webcam[]
- GET    /api/machines/:id/snapshot?name=      -> image   (camera)
- POST   /api/machines/:id/pause|resume|cancel -> {ok}  (409 with a plain sentence while status.firmware is set: a
         shut-down printer takes no print commands)
- POST   /api/machines/:id/firmware-restart    -> {ok}  (Moonraker POST /printer/firmware_restart. Only while
         status.firmware is "shutdown" or "error", else 409. Restarts Klipper; moves and heats nothing. Status then
         goes firmware "startup" -> ready.)
- Klipper not ready (Moonraker /printer/info state or objects/query webhooks.state = startup | shutdown | error):
  PrinterStatus.state "error" + `firmware` set; `message` is a plain sentence. The firmware's own text (SparkX wraps
  it as `{"code":"key1","msg":"..."}`) goes to the server log as its first line only. Every Moonraker error reaches the
  app as a plain sentence ("The printer couldn't stop the print: no print in progress."), never raw JSON.
- PUT    /api/projects/:id/machine {machineId}  -> Project  (sets project.json `printer`; 404 unknown machine; emits project.changed)
- Slice and print routes accept `machineId` (default machine when omitted); print requests carry `machineId`.
  - POST /api/projects/:id/print-requests {gcodePath, machineId?}: 409 if the G-code was sliced for another printer
    profile or a bigger bed than that machine has.
  - POST /api/print-requests/:id {approved, bedClear, machineId?}: machineId = the machine picked in the dialog.
  - POST /api/projects/:id/slice-plate {…, machineIds?: string[] | "idle"}: farm split. Plates go round-robin to
    those machines (idle first; only machines with the same slicer profile and a big enough bed, others listed in
    `warnings`); each PlateGcode has `machineId`. Request each plate on its machine.
  - SliceResult / PlateSliceResult carry `machineId` (sliced for) and `warnings` (e.g. generic profile).
  - GET /api/prints?machineId= filters the print log; PrintRecord.machineId.
- Slicer profiles: Machine.slicerProfile is "sparkx-i7" (bundled), "orca:<Vendor>/<preset>" (OrcaSlicer preset,
  flattened on first use into <STUDIO_HOME>/slicer-profiles/), or "generic" (Klipper profile sized to the bed; warns).
- Storage: <STUDIO_HOME>/machines.json; Settings.printer is a view of the default machine (writes go through to it).
  A fresh install has no machines (no placeholder). With none, slicing/printing use an unsaved practice printer
  (id practice-printer) and new projects get `printer: ""` (= follow the default). Only a pre-machines install with a
  printer the user set up (legacy printers/<id>.json, a real address, confirmed filaments or onboardedAt) migrates
  into machines.json; existing machines.json files are never changed. A new real printer becomes the default when no
  real printer is; removing the default prefers a real printer, then the practice printer.
- WS `printer.status` events carry `status.machineId`.
- Legacy /api/printer/* routes act on the default machine.
- Support matrix (R19): `shared/printer-support.ts` — `supportFor({model, vendor?, klipper?, isPractice?, slicerProfile?})`,
  `supportForMachine(machine)`, `supportHeadline(support, "network"|"none"|"practice")`; levels verified / simulated /
  untested / unsupported per capability (slicing, export, send, slots, creality, camera). `docs/printer-support.md`
  is generated from it (`npx tsx tools/gen-printer-support.ts`). MachineModel carries `vendor` + `klipper`.
- `connection.crealityStart?: boolean` (moonraker machines): start approved prints over Creality's :9999 service
  (experimental, default off; falls back to Moonraker only if nothing was sent; fails if the printer didn't start
  within 20 s). `connection.cameraIce?: {mode: "auto"|"local"|"custom", stunServers?}` (shared/camera-ice.ts):
  "auto" = LAN printers without STUN first, one STUN retry. The WebRTC relay rewrites mDNS host candidates in the
  offer to this computer's LAN address.
- GET /api/projects/:id/print-file?gcode=<build/…gcode>&format=gcode|3mf -> file (attachment
  `<project>_<file>`, header x-sliced-for). Export-only path ("Save print file"): the job's exact bytes; 409 when the
  G-code isn't a current Crease slice for the project's printer (same rule as print requests); format=3mf =
  the part's coloured model (single-part jobs only).
- FilamentSlot.materialProduct?: Creality product for the CFS code (e.g. "Hyper PLA"); `material` is the base type.

## Print intent + slice preview
- GET  /api/print-intents                                  -> PrintIntentInfo[]
- Slice routes / tools accept `intent` (default "standard") and optional `overrides` (OrcaSlicer process keys); SliceResult/PlateSliceResult carry `intent` and `preview: SlicePreviewSummary`.
- GET  /api/projects/:id/slice-preview?gcode=build/x.gcode           -> SlicePreviewSummary
- GET  /api/projects/:id/slice-preview/layers?gcode=…&from=n&to=m    -> ToolpathLayer[] (cap ~40 layers per call)
- GET  /api/projects/:id/slice-preview/toolpath?gcode=…             -> application/octet-stream: the whole plate's extrusion
  (and travel) segments for the 3D view, format in shared/toolpath.ts (TPV1 header JSON + Float32 records grouped by
  feature+tool, layer-sorted). Over ~1.2 M segments it is simplified (header.simplified). x-build-ms = parse + encode.
- GET  /api/projects/:id/slice-preview/image?gcode=…&layer=n|top|first[&zoom=x,y,w,h] -> PNG (for the agent + thumbnails)
  - `layer` is the 0-based index (as in ToolpathLayer.index); zoom is a bed box in mm. Issues are recomputed per
    file (cached by mtime); the intent comes from the `; printstudio_intent = …` comment written after the header block.
  - Unknown `overrides` keys → 400 (must exist in the machine's OrcaSlicer process profile).
  - Agent tool `preview_slice {gcodePath, layers?, zoom?}` returns the summary JSON plus PNGs (top, first layer, and
    the layers issues point at). `slice_part` / `slice_plate` take `intent` / `overrides`.

## Print jobs (owner: jobs — server/jobs, R02/R04)
Every slice (part or plate) snapshots its G-code as an immutable **PrintJob**: id = sha256 (hex) of the exact bytes
(the same key as the agent's slice review, `.studio/slice-reviews/<sha256>.json`). Stored read-only in
`<project>/.studio/jobs/<id>/<name>.gcode` + `job.json` (source revision per part + design revision, parts/qty/overrides,
intent, slicer version + profiles + effective settings, machine snapshot + fingerprint, checks, guide, preview warnings).
Lifecycle + latest jobs: `.studio/jobs/state.json`. SliceResult / PlateGcode carry `jobId`.
- GET  /api/projects/:id/jobs          -> ProjectJobs {parts: {partId: PrintJobView}, plates: {plates, next, stale} | null, intent}
- GET  /api/projects/:id/jobs/:jobId   -> PrintJobView (status, `stale` reasons, reviewedAt)
- GET  /api/projects/:id/jobs/:jobId/placement -> PlatePlacement (R13): every object on that plate as sliced, from the
  G-code's `EXCLUDE_OBJECT_DEFINE NAME= CENTER= POLYGON=` lines, mapped to {partId, entry (index into the job's parts[]),
  instance, label "A".."Z","AA"…}. Letters follow parts[] order (entry 0 copy 1 = A) and are unique across the plate
  set. `rotationDeg`/`translate` take the part's own mesh (build/<part>.stl coordinates) onto the bed:
  bed XY = rotate(XY, rotationDeg) + translate, then drop to Z=0 (null = couldn't match the mesh; draw the polygon).
  Bed coords: mm, (0,0) = FRONT-LEFT corner, +Y toward the back (`front: "-y"`). New slices record this in job.json
  (`objects`, `source: "slice"`); older jobs are read from the snapshot and fitted to today's mesh (`source: "gcode"`).
  PlateGcode.objects carry `name/entry/instance/label` too. The UI's Model › Plate view, Layers labels and per-instance
  eye toggles all read this.
- PUT  /api/projects/:id/intent {intent} -> {intent}   (project.json `intent`; every slice also sets it = latest slice's intent)
- Re-slice with the same inputs: POST .../parts/:partId/slice and POST .../slice-plate take `reuseLatest: true` —
  the latest slice's plate composition (parts + qty + per-part `overrides`; none if it was "every part") and its
  process overrides as the caller gave them (job.json `userOverrides`; automatic Display choices are made again) are
  reused; `intent`/`overrides`/`parts` given in the body still win. The toolbar's Slice and Send use it, so the
  agent's per-part settings (e.g. 4 walls) survive a toolbar re-slice. A part slice also picks up a newer plate that
  held only that part (its per-part settings fold into plate-level ones).
- `jobs.changed` is emitted whenever staleness may have changed: slices/requests/starts (state.json writes), Customizer
  overrides saved, any watched file change, intent change, project machine change, machine edit/delete/default
  change (every project with jobs), restore / idea switch. Send: a 409 "Out of date" from print-requests means
  slice again (reuseLatest) and retry once.
- Server start: a job still "requested" (its dialog was lost with the restart) is set back to pending with
  `error` = PRINT_REQUEST_RESTART_NOTICE (shared/types.ts) and an `app_notice` goes into the project's timeline; the UI
  toasts it once.
- POST /api/print-requests/:id/reslice {machineId} -> PrintRequest  (another machine picked in the dialog: slice the job's
  inputs for it and swap the request to the new job; the user then approves that one)
- Staleness is server-owned and computed on read: a part's source hash (file + includes + Customizer values) changed,
  the design revision changed, a part removed/added/qty changed (all-parts plates), the project's target machine or
  that machine's slicing config changed, or the project intent differs. Refetch on `jobs.changed` and `project.changed`.
- Plate lifecycle: pending → requested → printing → done; rejected/failed (incl. expired, refused, upload error,
  print cancelled/error) stay at the cursor for retry. `next` = first plate not printing/done; it only moves on a
  recorded successful start. A "requested" job whose dialog no longer exists (server restart) reads as pending.
- Print requests are bound to jobs: POST /api/projects/:id/print-requests hashes the file and 409s if no job has those
  bytes (hand-edited / copied-in G-code), if the job is stale ("Out of date — slice again: …"), or if `machineId` isn't
  the job's machine. The request carries `job: PrintJobSummary`; the dialog previews `job.snapshotPath`.
  Approving re-verifies: snapshot hash == job id, the requested file still holds the same bytes, not stale; then uploads
  exactly those verified bytes. Otherwise 409 and the request resolves as not approved. A different `machineId` on
  approve → 409, request stays open (use /reslice).
- Agent `request_print` passes the reviewed sha256 (`requestPrintGate` record) as the expected job id; a mismatch is refused.
- Server functions: `getJobForGcode(projectId, path)`, `currentJob(projectId, partId?)`, `projectJobs`, `staleReasons`.
- Removing a part (its .scad gone) deletes its build/ outputs, render PNGs and `.studio/checks/<part>.json`.
