# Contributing to Crease

Thanks for helping. Crease is alpha and mostly built by one person with coding agents, so small, focused
changes with a clear test are the easiest to take. Open an issue first for anything bigger than a bug fix.

Crease is licensed under the [Apache License 2.0](LICENSE). Code, docs and design-quality reports are all
welcome; see "Licence of contributions" below.

## Set up

Needs Node 22+, git, [OpenSCAD](https://openscad.org/downloads.html#snapshots) (2024+ snapshot) and
[OrcaSlicer](https://github.com/SoftFever/OrcaSlicer/releases/latest). macOS is the main target; the server and web
UI also run on Linux and Windows.

```sh
npm ci
npm run dev            # server :5174 + web UI http://localhost:5173 + fake Moonraker printer :7125
npm run dev:electron   # the desktop app instead (same ports must be free)
```

Your data goes to `~/Crease` (`~/PrintStudio` if you used the app before it was renamed); set `PRINTSTUDIO_HOME=/tmp/ps-dev` to keep a throwaway one. The designer needs an
`ANTHROPIC_API_KEY` (or a key added in Agents), or your own signed-in Claude Code; most of the app (editing,
rendering, checks, slicing, the practice printer) works without it. From source, the Agent SDK's bundled Claude Code
binary runs the designer; `PRINTSTUDIO_NO_BUNDLED_CLAUDE=1` uses your installed Claude Code instead, like the .dmg.
The app never signs in to Claude for you; `PRINTSTUDIO_DEV_CLAUDE_LOGIN=1` brings back the old developer-only
"Sign in to Claude" button (it runs `claude auth login` in Terminal) and must never be on in a release.

## The gate: `npm run check`

`npm run check` (typecheck + ESLint on the whole repo + Vitest) must be green before a PR is merged. Add a test with
every fix; tests must not need the network, a real printer, OpenSCAD or a paid model call unless they skip cleanly
without them. `npm run eval` runs the design-agent evals and **costs real tokens**: only when you change agent
behaviour, and say so in the PR.

If you add an npm dependency, run `npm run notices` and commit the regenerated `THIRD_PARTY_NOTICES.txt`. Anything
that isn't permissively licensed needs a note in [docs/licenses/INVENTORY.md](docs/licenses/INVENTORY.md) first.

## Where things live

The layout is in [CLAUDE.md](CLAUDE.md) ("Layout"). In short:

| Folder | What |
|---|---|
| `shared/` | Types and the HTTP/WS API contract (`shared/types.ts`, `shared/api.md`). Change the contract here first. |
| `server/` | Node services (Fastify + WebSocket): `projects/`, `cad/` (OpenSCAD + checks), `assembly/`, `agent/` (runtimes, tools, skills, sandbox policy), `slicer/`, `printer/` (Moonraker, Creality, practice printer), `pack/` (build packs), `routes/` |
| `src/` | React renderer. Talks only to `/api` and `/ws`. Design tokens in `src/index.css`, style board at `/#/style`. |
| `electron/` | Desktop shell (runs the server in-process). |
| `resources/` | Shipped data: BOSL2, tuned slicer profiles, starters. |
| `tools/` | Dev scripts: mock printer, printer probe, evals, notices, example packs. |

Open work and known gaps are tracked in GitHub issues.

## Common contributions

### Report or add printer support

Support is tracked honestly per capability (slicer preset, save file, send + control, colour slots, camera) in
[`shared/printer-support.ts`](shared/printer-support.ts); [docs/printer-support.md](docs/printer-support.md) is
generated from it (`npx tsx tools/gen-printer-support.ts`, a test fails if it's stale).

1. Run the read-only probe against your printer and attach the output to a "Printer support" issue:
   `npx tsx tools/probe-printer.ts <printer-ip>`. It reads status only. **Remove serial numbers, hostnames and IP
   addresses you don't want public before posting.**
2. A level goes to "verified" only with evidence from a real print (photos and notes in the issue or PR). "Simulated" means the practice printer or mock covered it.
3. Printer communication lives in `server/printer/` (Moonraker is the only network protocol today). New protocols
   (PrusaLink, OctoPrint, Bambu) need a client plus a simulator in `tools/` or `server/printer/sim.ts` so tests
   never need hardware.

### Add a tuned slicer profile

Most printers work through OrcaSlicer's own presets (the model picker flattens them from the user's OrcaSlicer at
run time). Ship a tuned copy only when the stock preset needs fixes:

1. Flatten the stock preset: adapt `server/slicer/flatten-profiles.ts` (machine/process/filament names, `KEY`) and
   write `resources/slicer-profiles/<key>/{machine,process,filament-PLA,filament-PETG,filament-TPU}.json`.
2. Route the OrcaSlicer preset to it in `CURATED` in `server/slicer/profiles.ts`.
3. Record what you copied and changed in `resources/slicer-profiles/SOURCE.md`. These files are derived from
   OrcaSlicer and are **AGPL-3.0**; keep them in that folder.

### Add an agent skill

Skills are folders in `server/agent/skills/<name>/` with a `SKILL.md`; every session gets a copy. Follow the review
rules in [docs/skills.md](docs/skills.md): read every file; no scripts, network calls, downloads, installers,
credential access or prompt-injection text; permissive licences only (MIT/Apache/BSD/CC), with the upstream
`LICENSE` and a `SOURCE.md` (URL, commit, licence, what you changed) in the folder. List it in docs/skills.md.

### Add an agent runtime (a different designer)

Runtimes implement `AgentRuntime` / `AgentAdapter` in [`server/agent/runtime/types.ts`](server/agent/runtime/types.ts)
and are registered in `server/agent/index.ts`; `runtime/claude/` is the reference and `runtime/fake.ts` the test
double. The adapter must expose the app's tools (`server/agent/registry`) and keep the sandbox and approval rules:
the design agent can only write inside the project, can never reach a printer directly, and can only *request* a
print, which the app confirms with the user.

### Report design quality

When the designer makes something wrong (doesn't fit, prints badly, ignores what you asked), open a "Design quality"
issue with the prompt, the model, and the exported build pack if you can share it (it leaves out chat transcripts,
keys and folder paths).

## Real-printer safety rules

A printer has hot ends, a heated bed and moving parts, and it may be someone's only printer.

- **Development and tests use the fake printer** (`npm run mock:printer`) or the built-in practice printer. CI and
  `npm test` never contact real hardware.
- **Never start, pause, cancel or upload to a real printer from a script, test or agent.** Prints start only from the
  app's confirm dialog, by a person who can see the printer.
- **Probes are read-only.** `tools/probe-printer.ts` reads status; `--allow-upload` writes and deletes one
  comment-only file and is only for the printer's owner.
- **Someone stays with the printer** for any supervised test on real hardware (first layer, colour changes, end of
  print), and the steps are written down first (see `docs/printer-bringup.md`).
- **Don't weaken the guards**: the confirm dialog, the latest-slice review before a print request, the agent sandbox
  (no network, no writes outside the project, no G-code edits), and preflight checks (bed size, loaded slots).
  Changes to these need a test and a note in the PR.

## Pull requests

- One topic per PR; say what you changed, why, and how you checked it (tests, screenshots for UI).
- Run `npm run check`. For UI changes include a screenshot; for slicing/printing changes say which printer or
  simulator you used.
- Don't commit personal data: projects, `~/PrintStudio` contents, printer serials/IPs, API keys, or chat transcripts.
- By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence of contributions

Crease is licensed under the Apache License 2.0. By submitting a contribution (a pull request, patch or file)
you agree that it is licensed under the Apache License 2.0, as section 5 of the licence says ("inbound = outbound").
There is no CLA. Only submit work you have the right to license this way; if your employer has rights in your work,
make sure they're fine with it.

Material under other licences stays under them and must say so: vendored skills keep their `LICENSE` and a
`SOURCE.md` (and a "Modified for Crease" line if you change an Apache-2.0 one), and changes to
`resources/slicer-profiles/` are AGPL-3.0 like the rest of that folder.
