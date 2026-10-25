# Crease

Desktop IDE for 3D printing. Current focus: breadth-first end-to-end slice —
generate a part with the agent → render/check → slice (OrcaSlicer CLI) → send to printer (Moonraker, confirm dialog).

## Layout
- `shared/` — types + API contract (`shared/types.ts`, `shared/api.md`). Change contract here first.
- `server/` — Node "main process" services, runs standalone (Fastify + WS on 127.0.0.1:5174).
  - `projects/` project folders + git · `cad/` OpenSCAD CLI + mesh checks · `agent/` Claude Agent SDK + MCP tools
  - `slicer/` OrcaSlicer CLI · `printer/` Moonraker client · `routes/` HTTP routes · `events.ts` WS bus
- `src/` — React renderer (Vite, Tailwind v4, shadcn/base-ui primitives restyled to the "Workshop" design: warm stone dark theme (default) + light, Geist (Geist Mono only for code, paths, aligned numbers), pill buttons with one solid pill for the screen's main action, no brand accent (status colours only; parts draw in filament tones from `shared/filament-tones.ts`), glass only on controls floating over the full-bleed 3D stage (`src/glass.css`), solid panels for reading; tokens in `src/index.css`, living style board at `/#/style`). Talks only to /api and /ws.
- `electron/` — desktop shell (server in-process, per-launch token).
- `tools/mock-moonraker.ts` — fake printer on :7125 for dev. Real printer: SPARKX i7 at 10.0.0.24.
- Data lives in `~/PrintStudio` on installs from before the Crease rename, else `~/Crease` (override with `PRINTSTUDIO_HOME`).

## UX
UI changes follow `docs/ux-principles.md` (progressive disclosure, task-first, audit → rethink → refine → verify) and `docs/writing.md` (word budgets, glossary).

## Status
Open items live in GitHub issues. Maintainers may keep private notes (status, plans, print journal) in `local/`, which is gitignored and may be absent.

## Commands
- `npm run dev:electron` — the desktop app (dev); needs ports 5173/5174/7125 free
- `npm run dev` — server + vite (http://localhost:5173) + mock printer
- `npm run eval` — design-agent evals (costs real tokens)
- `npx tsx tools/probe-printer.ts <ip>` — read-only printer probe
- `npx tsx tools/sandbox-check.ts [--raw]` — live check of the design agent's sandbox/policy (a few cents, fake printer)
- `npm run dev:server` / `npm run dev:web` / `npm run mock:printer` individually
- `npm run check` — release gate: typecheck + lint + tests (run before merging)
- `npm run typecheck` — renderer + server
- `npm test` — vitest
- Add shadcn components: `npx shadcn@latest add <name>`

## Tools on this machine
- OpenSCAD: `/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD` (2026.10.05, `--backend Manifold`)
- OrcaSlicer: `/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer` (2.4.2)
