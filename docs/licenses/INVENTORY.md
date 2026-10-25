# Licence inventory (R21)

What Crease contains or redistributes, under which licence, and what each licence asks of us. Prepared
2026-10-09 from `main` e89fcec; updated the same day when the project chose **Apache-2.0** for its own code (`LICENSE`,
`NOTICE`, `package.json`) and resolved blockers B1 and B2 (below). This is an engineering inventory, not legal advice.

- Generated notices: `THIRD_PARTY_NOTICES.txt` (repo root), built by `npm run notices` (`tools/notices.ts`). It ships
  twice in the app: in the renderer bundle (Settings > About > **Licences**) and as
  `Crease.app/Contents/Resources/THIRD_PARTY_NOTICES.txt`. `npm run dist:mac` regenerates it first.
- Licence summary of the npm tree: `npx tsx tools/notices.ts --summary` (offline equivalent of
  `license-checker --production --summary`, read from `package-lock.json` + `node_modules`).
- Choosing the project's own licence: [CHOOSING.md](CHOOSING.md).

## Blockers and open questions

| # | Item | Why it matters | Options |
|---|---|---|---|
| **B1** | ~~Claude sign-in (subscription OAuth) was the default designer auth~~ **Resolved 2026-10-09 (option b + c).** | Anthropic's Agent SDK docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods." The Claude Code legal page separately allows an end user to sign in to an **unmodified, preinstalled Claude Code binary** with their own subscription. | **Done:** new installs default to an **API-key** profile ("Add an API key" is the primary fix in setup, Agents and the timeline). A user who installed Claude Code and signed in to it **themselves** may choose "Your Claude plan via your own Claude Code"; the app only detects that login with the user's own `claude auth status` and never reads credential files. The app's own "Sign in to Claude" (`claude auth login` in Terminal) is gone from public builds; it remains a developer escape hatch behind `PRINTSTUDIO_DEV_CLAUDE_LOGIN=1` (`server/tools/index.ts`, `server/onboarding.ts`). Billing labels: "Your Claude plan via your own Claude Code" vs "Anthropic API key". Installs set up before this keep the login they already used. Still worth asking Anthropic before advertising the plan option; the plan-usage meter only shows what the user's own CLI reports. |
| **B2** | ~~The bundled `claude` CLI binary is proprietary~~ **Resolved 2026-10-09 (option c).** | `@anthropic-ai/claude-agent-sdk-darwin-arm64` ("© Anthropic PBC. All rights reserved", Commercial Terms) is no longer copied into the .dmg: `electron-builder.config.cjs` excludes `node_modules/@anthropic-ai/claude-agent-sdk-*`, and `tools/notices.ts` leaves it out of the notices. The arm64 .dmg went from ~270 MB to 170 MB (169.5 MB; the app folder is 458 MB unpacked). | **Finding:** the Agent SDK (0.3.292) needs a native `claude` binary for **every** session, API key or plan alike. It has no JavaScript fallback: without the platform package or `pathToClaudeCodeExecutable` it throws "Native CLI binary for darwin-arm64 not found". So public builds require the user to **install Claude Code** (free, from Anthropic's page). The app discovers it (Settings path, PATH incl. the login shell's, `~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`; `server/tools/discovery.ts`) and passes it to the SDK as `pathToClaudeCodeExecutable`. Setup shows "Claude Code: found vX" or "not installed > Install Claude Code" (opens the official setup page) and warns when the install is older than the version the SDK was released with (`claude update`). We chose this over downloading the binary on first run (option b), which would make Crease a redistributor again. Running from source still uses the SDK's optional binary; `PRINTSTUDIO_NO_BUNDLED_CLAUDE=1` imitates the .dmg. |
| Q1 | OrcaSlicer-derived profiles (AGPL-3.0) | Only matters if the project licence is permissive; see "Slicer profiles" below. | Keep them as a separately licensed AGPL-3.0 data folder (done), or make the whole project AGPL/GPL. |
| Q2 | libvips (LGPL-3.0) inside `sharp` | LGPL object code we redistribute: needs licence texts (done) and corresponding source availability. | Point to the exact upstream release (done in notices via the package) and, to be safe, attach the `sharp-libvips` v1.3.4 source tarball to each GitHub release. |

## Bundled in the app

### npm runtime dependencies

237 packages ship (238 are reachable from the app's runtime dependencies (excluding build-only `shadcn` and
`@tailwindcss/vite`, which `electron-builder.config.cjs` drops; the Agent SDK's CLI binary package is reachable but excluded, B2). The renderer-only ones are compiled into `dist/` by
Vite, so they ship too and are included.

| Licence | Count | Obligation when we ship a binary |
|---|---|---|
| MIT | 196 | Keep the copyright + permission notice (in THIRD_PARTY_NOTICES). |
| ISC | 13 | Same as MIT. |
| Apache-2.0 | 10 | Include the licence; keep any NOTICE file contents; state changes if we modify (we don't). |
| BlueOak-1.0.0 | 6 | Include the licence text or link. |
| BSD-3-Clause | 5 | Keep notice; don't use their names to endorse. |
| OFL-1.1 | 2 | `@fontsource/geist`, `@fontsource/geist-mono` (Geist, Vercel). Ship the OFL with the fonts; don't sell the fonts on their own; don't call a modified font by its reserved name. Embedding them in assembly guides/PDFs is allowed. |
| LGPL-3.0-or-later | 1 | `@img/sharp-libvips-darwin-arm64` (libvips, glib, pango, librsvg… as a prebuilt dylib loaded by `sharp`). Include LGPL + GPL texts (done: `docs/licenses/texts/`); keep it a separate, replaceable dynamic library (it is: no asar, plain file in `node_modules/@img/`); make the corresponding source available (Q2). Its other components (aom, cairo MPL-1.1, libpng, zlib-ng, …) are listed in the package's licensing table, reproduced in the notices. |
| MPL-2.0 OR Apache-2.0 | 1 | `dompurify` (via monaco-editor): we take it under Apache-2.0. |
| Python-2.0 | 1 | `argparse` (JS port): keep the notice. |
| 0BSD | 1 | None. |
| MIT (from LICENSE file) | 1 | `webgl-constants` has no `license` field; its LICENSE file is MIT. |
| Proprietary | 1 | `@anthropic-ai/claude-agent-sdk` (the JavaScript library, loaded in-process). Its `darwin-arm64` CLI binary package is installed for development but **not shipped** (B2). (`@anthropic-ai/sdk`, a dependency of it, is MIT.) |

Notable individual components: React, three.js, @react-three/*, Fastify, zod, zustand, simple-git, chokidar (MIT);
monaco-editor (MIT); manifold-3d (Apache-2.0); sharp (Apache-2.0); better-sqlite3 (MIT; bundles SQLite, public
domain); `@phosphor-icons/react` (MIT) and `lucide-react` (ISC) for icons; electron-updater (MIT).

### Electron

`electron` 44.6.0 (MIT) is a devDependency but is the app shell, so it ships. It contains Chromium, Node.js, V8,
ffmpeg (LGPL build) and many others, credited in Electron's `LICENSES.chromium.html`. electron-builder doesn't copy that
file on macOS, so `electron-builder.config.cjs` now adds it (and Electron's LICENSE) via `extraResources`.

### Repository material (not from npm)

| What | Where | Licence | Obligations / notes |
|---|---|---|---|
| BOSL2 v2.0.766 (OpenSCAD library) | `resources/openscad-libraries/BOSL2/` | BSD-2-Clause | Keep LICENSE (kept verbatim). Unmodified; provenance in `BOSL2.SOURCE.md`. Models users make with it are theirs. |
| 11 vendored agent skills | `server/agent/skills/<name>/` (LICENSE + SOURCE.md each) | 7 MIT, 4 Apache-2.0 (AgentCAD: enclosures, fdm-design-rules, fits-and-clearances, snap-fits) | Keep the LICENSE files (done). Apache-2.0 §4(b): modified files must carry a prominent change notice. The SKILL.md files have a "Crease notes" section and SOURCE.md records changes; **done 2026-10-09:** each Apache skill's SKILL.md now starts with "Modified for Crease; see SOURCE.md." (they were modified: the added "Crease notes" section). AgentCAD has no NOTICE file. |
| fit-and-tolerance (first party) | `server/agent/skills/fit-and-tolerance/` | ours (Apache-2.0) + adapted MIT material (Altern92) | `LICENSE-Altern92` kept; attribution in SOURCE.md. |
| Other first-party skills | `server/agent/skills/*` without LICENSE | ours | Apache-2.0 (project licence). |
| Slicer profiles (SPARKX i7: machine, process, PLA/PETG/TPU) | `resources/slicer-profiles/sparkx-i7/` | **AGPL-3.0** (derived from OrcaSlicer's bundled presets) | See below. `SOURCE.md` + `LICENSE-AGPL-3.0.txt` added in that folder. |
| Starters (8 example projects) | `resources/starters/` | ours | Written for Crease. Apache-2.0 (project licence). |
| Example build packs | `examples/` | ours | Generated from the starters (`tools/make-examples.ts`); their manifest says "Same licence as the Crease repository", i.e. Apache-2.0. |
| UI components | `src/components/ui/` | ours, generated from shadcn/ui (MIT) templates | shadcn/ui says the generated code is yours; crediting it in the README is courteous, not required. |
| Fonts | via `@fontsource` (npm, above) | OFL-1.1 | Also embedded (base64 woff2) in every assembly guide HTML/PDF and so in build packs: allowed by the OFL for documents. |
| README screenshots | `docs/images/` | ours | App screenshots. |

#### Slicer profiles in detail

- **What was copied:** five OrcaSlicer system presets (`Creality SPARKX i7 0.4 nozzle`, `0.20mm Standard @Creality
  SPARKX i7 0.4 nozzle`, `Generic PLA|PETG|TPU @SPARKX i7-all`) with their `inherits` chains (Creality +
  OrcaFilamentLibrary) flattened into single JSON files by `server/slicer/flatten-profiles.ts`, then tuned.
- **Licence:** OrcaSlicer is AGPL-3.0 and its `resources/profiles/` folder has no separate licence, so the presets
  are distributed under the AGPL. Much of a preset is factual numbers (speeds, temperatures) with thin copyright, but
  the conservative reading is that our flattened copies are AGPL-3.0 derived works. Flattening is a modification; it
  doesn't change the licence.
- **Obligations if we ship them:** keep them under AGPL-3.0, include the licence (done), mark them as modified (done in
  SOURCE.md), provide source (the JSON *is* the source; it's in the app's `resources/` folder and the repo).
- **Does it reach our code?** No, on the usual reading. They're data files loaded by a separate program (the user's
  OrcaSlicer CLI); our code doesn't link OrcaSlicer, and reading a data file doesn't make the reader a derivative. The
  folder is an "aggregate" alongside the app. AGPL §13 (network use) doesn't apply: nothing is offered over a network.
- **Runtime-flattened presets** (the other ~358 printer models in the picker) are read from the user's own OrcaSlicer
  install and cached in `~/PrintStudio/slicer-profiles/` on their machine: we don't distribute them.
- **The project is Apache-2.0 (permissive), so:** `NOTICE`, README and the folder's SOURCE.md state that
  `resources/slicer-profiles/` is AGPL-3.0 (done). If that's unwelcome, the alternative is to stop bundling them and flatten the i7 preset from the user's
  OrcaSlicer at first run (the code path for `orca:` presets already does this), keeping only our *overrides* as a
  small first-party JSON patch.

## Not bundled (user installs; we only run them)

| Tool | Licence | Notes |
|---|---|---|
| OpenSCAD | GPL-2.0-or-later | Separate program, run as a subprocess. Not redistributed. |
| OrcaSlicer | AGPL-3.0 | Separate program, run as a subprocess. Not redistributed. |
| Claude Code | Anthropic terms (proprietary) | **Required** for the designer (B2): the user installs it; the app finds it and runs it unmodified as a separate program, with the user's own API key or Claude Code sign-in. Not redistributed. |
| Codex CLI (R11d) | Apache-2.0 (OpenAI's open-source CLI); its service is under OpenAI's terms | Discovered, not bundled (`PRINTSTUDIO_CODEX_BIN`, PATH, usual install places: `server/agent/runtime/codex/process.ts`). Signing in with a ChatGPT plan is OpenAI's flow in the user's own CLI; check OpenAI's terms for third-party apps before advertising it. If it is ever bundled, add it here and to `tools/notices.ts`. |
| Grok CLI (R11e) | xAI terms (proprietary binary) | Discovered, not bundled (`PRINTSTUDIO_GROK_BIN`, PATH, `~/.grok/bin`: `server/agent/runtime/grok/process.ts`); run unmodified as a separate program (`grok agent stdio`). Sign-in is the CLI's own device-code flow (`grok login --device-auth`) into a Crease-owned Grok home, or the user's xAI API key in the process environment; no credential file is read. Check xAI's terms for third-party apps before advertising the Grok-account option. |

## Build/dev-only (not shipped)

TypeScript, Vite, ESLint, Vitest, Playwright, electron-builder, tsx, prettier, shadcn CLI, Tailwind Vite plugin and
their trees. They don't ship, so they don't need notices.

## Third-party services the app talks to

Anthropic API (the designer, under the user's own account), the user's printer (LAN), and links to shops (Amazon,
AliExpress, Bolt Depot, McMaster-Carr) as plain search URLs with no affiliate tags. No telemetry from Crease
itself; the Claude CLI's own data collection is governed by Anthropic's terms and is described in the SDK README.

## Keeping this current

- Adding an npm dependency: run `npm run notices` and commit the regenerated `THIRD_PARTY_NOTICES.txt`. Anything
  non-permissive (GPL/AGPL/LGPL, SSPL, "SEE LICENSE", UNKNOWN) shows up under "Needs attention" in
  `npx tsx tools/notices.ts --summary`: add a row here.
- Vendoring a skill: follow docs/skills.md (permissive only, LICENSE + SOURCE.md in the folder). The notices script
  picks up any skill folder with a LICENSE file.
- Adding a bundled slicer profile: record its source in `resources/slicer-profiles/SOURCE.md`.
