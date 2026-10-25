// Generates THIRD_PARTY_NOTICES.txt: every third-party component the desktop app ships, with its licence text.
// The renderer bundles the file (Settings > About > Licences), so it ships inside the app too.
//
// Sources, in order:
//   1. npm production dependencies (package-lock.json entries without dev/devOptional), installed under node_modules.
//      Platform packages not installed on this machine are not shipped by this build and are left out.
//   2. Electron (a devDependency, but its runtime is the app shell) incl. a pointer to its Chromium credits.
//   3. Non-npm material in the repo: BOSL2, vendored agent skills, OrcaSlicer-derived slicer profiles.
//   4. The Claude Agent SDK's JavaScript library: proprietary, listed with its terms. Its platform package (the
//      `claude` CLI binary) is NOT shipped: electron-builder excludes it and the app runs the user's Claude Code.
//
// Usage: npx tsx tools/notices.ts            write THIRD_PARTY_NOTICES.txt
//        npx tsx tools/notices.ts --summary  print a licence summary (like `license-checker --production --summary`)
//        npx tsx tools/notices.ts --check    exit 1 if THIRD_PARTY_NOTICES.txt is out of date
// See docs/licenses/INVENTORY.md for the obligations each licence brings.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.txt")
const RULE = "=".repeat(78)
const LGPL = "docs/licenses/texts/LGPL-3.0.txt"
const GPL = "docs/licenses/texts/GPL-3.0.txt"

interface LockEntry {
  name?: string
  version?: string
  license?: string
  dev?: boolean
  devOptional?: boolean
  optional?: boolean
}
export interface Component {
  name: string
  version: string
  license: string
  url: string | null
  /** Files in the repo/node_modules the text came from (relative to the repo root). */
  from: string[]
  text: string
  note?: string
}

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n").trimEnd()
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([.-].*)?$/i

function licenceFiles(dirRel: string): string[] {
  const abs = join(ROOT, dirRel)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => LICENSE_FILE.test(f) && !/\.(js|ts|d\.ts|json|html)$/i.test(f))
    .sort()
    .map((f) => `${dirRel}/${f}`)
}

function repoUrl(pkg: Record<string, unknown>): string | null {
  const r = pkg.repository as string | { url?: string } | undefined
  let u = typeof r === "string" ? r : r?.url
  if (!u) return typeof pkg.homepage === "string" ? pkg.homepage : null
  u = u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://")
  if (/^github:/.test(u)) u = `https://github.com/${u.slice(7)}`
  else if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`
  return u
}

/** Licence text for a package that ships none: its README "Licensing" section, else a pointer. */
function fallbackText(dirRel: string, license: string): { text: string; from: string[] } {
  const readme = `${dirRel}/README.md`
  if (existsSync(join(ROOT, readme))) {
    const m = read(readme).match(/^##+ Licen[cs]ing?\b[\s\S]*?(?=^##? |$(?![\s\S]))/im)
    if (m) return { text: m[0].trim(), from: [readme] }
  }
  return { text: `No licence file in the published package. Declared licence: ${license}.`, from: [] }
}

// package.json "dependencies" that are build-time tools, not shipped (electron-builder's RENDERER_ONLY list drops
// them from the app, and Vite does not bundle them): the shadcn CLI and the Tailwind Vite plugin (with their
// toolchains: Babel, ts-morph, lightningcss, Vite itself). tailwindcss stays: its generated CSS is in the bundle.
const BUILD_ONLY = new Set(["shadcn", "@tailwindcss/vite"])
// Installed, but excluded from the app by electron-builder.config.cjs: the Agent SDK's bundled `claude` binary
// (proprietary; the app runs the user's own Claude Code instead, INVENTORY B2).
const NOT_SHIPPED = /^@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)-/

/** Lockfile paths of the production packages reachable from the app's runtime dependencies (Node resolution). */
function shippedPaths(lock: { packages: Record<string, LockEntry & { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> }): Set<string> {
  const pkgs = lock.packages
  const rootDeps = Object.keys(pkgs[""]?.dependencies ?? {}).filter((d) => !BUILD_ONLY.has(d))
  const resolve = (from: string, dep: string): string | null => {
    let base = from
    for (;;) {
      const p = `${base ? `${base}/` : ""}node_modules/${dep}`
      if (pkgs[p]) return p
      if (!base) return null
      const i = base.lastIndexOf("/node_modules/")
      base = i < 0 ? "" : base.slice(0, i)
    }
  }
  const out = new Set<string>()
  const queue = rootDeps.map((d) => resolve("", d)).filter((p): p is string => !!p)
  while (queue.length) {
    const p = queue.pop()!
    if (out.has(p)) continue
    out.add(p)
    const e = pkgs[p]
    for (const d of [...Object.keys(e.dependencies ?? {}), ...Object.keys(e.optionalDependencies ?? {})]) {
      const r = resolve(p, d)
      if (r && !out.has(r)) queue.push(r)
    }
  }
  return out
}

function npmComponents(): Component[] {
  const lock = JSON.parse(read("package-lock.json")) as Parameters<typeof shippedPaths>[0]
  const shipped = shippedPaths(lock)
  const seen = new Map<string, Component>()
  for (const [path, e] of Object.entries(lock.packages)) {
    if (!shipped.has(path) || e.dev || e.devOptional) continue
    if (NOT_SHIPPED.test(path.slice(path.lastIndexOf("node_modules/") + 13))) continue
    const dirRel = path
    const pkgJson = join(ROOT, dirRel, "package.json")
    if (!existsSync(pkgJson)) continue // optional/platform package not installed: not shipped by this build
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as Record<string, unknown>
    const name = String(pkg.name ?? e.name ?? path.slice(path.lastIndexOf("node_modules/") + 13))
    const version = String(pkg.version ?? e.version ?? "?")
    const key = `${name}@${version}`
    if (seen.has(key)) continue
    const files = licenceFiles(dirRel)
    let license = String(e.license ?? (typeof pkg.license === "string" ? pkg.license : "UNKNOWN"))
    // No licence field in package.json (e.g. webgl-constants): name it from the LICENSE file.
    if (license === "UNKNOWN" && files.length && /^\s*MIT License/.test(read(files[0]))) license = "MIT (from its LICENSE file)"
    let { text, from } = files.length
      ? { text: files.map((f) => read(f)).join("\n\n"), from: files }
      : fallbackText(dirRel, license)
    // (L)GPL packages that ship no licence text (sharp's prebuilt libvips): the LGPL requires giving users the LGPL
    // and the GPL it builds on, so append both.
    if (/LGPL-3\.0/.test(license) && !/GNU LESSER GENERAL PUBLIC LICENSE/.test(text)) {
      text += `\n\n${read(LGPL)}\n\n${read(GPL)}`
      from = [...from, LGPL, GPL]
    }
    seen.set(key, { name, version, license, url: repoUrl(pkg), from, text })
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

function electronComponent(): Component | null {
  const dir = "node_modules/electron"
  if (!existsSync(join(ROOT, dir, "package.json"))) return null
  const pkg = JSON.parse(read(`${dir}/package.json`)) as Record<string, unknown>
  return {
    name: "electron",
    version: String(pkg.version),
    license: String(pkg.license ?? "MIT"),
    url: "https://github.com/electron/electron",
    from: [`${dir}/LICENSE`],
    text: read(`${dir}/LICENSE`),
    note:
      "The app shell. Electron bundles Chromium, Node.js and their dependencies; their notices ship inside the app " +
      "as Crease.app/Contents/Resources/LICENSES.chromium.html (electron-builder.config.cjs extraResources).",
  }
}

function repoComponents(): Component[] {
  const out: Component[] = []
  // BOSL2 (see resources/openscad-libraries/BOSL2.SOURCE.md)
  const bosl = "resources/openscad-libraries/BOSL2"
  if (existsSync(join(ROOT, bosl, "LICENSE")))
    out.push({
      name: "BOSL2 (OpenSCAD library)",
      version: "v2.0.766",
      license: "BSD-2-Clause",
      url: "https://github.com/BelfrySCAD/BOSL2",
      from: [`${bosl}/LICENSE`],
      text: read(`${bosl}/LICENSE`),
      note: "Unmodified subset (top-level .scad files). Installed into the user's data folder and put on OPENSCADPATH.",
    })

  // Vendored agent skills (see docs/skills.md); first-party skills have no upstream LICENSE file.
  const skills = "server/agent/skills"
  for (const s of readdirSync(join(ROOT, skills)).sort()) {
    const files = licenceFiles(`${skills}/${s}`)
    if (!files.length) continue
    const src = existsSync(join(ROOT, skills, s, "SOURCE.md")) ? read(`${skills}/${s}/SOURCE.md`) : ""
    const url = src.match(/https:\/\/\S+?(?=[\s)`]|$)/)?.[0] ?? null
    const text = files.map((f) => read(f)).join("\n\n")
    const license = /Apache License/.test(text) ? "Apache-2.0" : /MIT License/.test(text) ? "MIT" : "see text"
    const adapted = files.some((f) => /LICENSE-/.test(f))
    out.push({
      name: `agent skill: ${s}`,
      version: url?.match(/tree\/([0-9a-f]{7})/)?.[1] ?? "-",
      license,
      url,
      from: files,
      text,
      note: adapted
        ? "First-party skill that adapts material from the upstream project named in its SOURCE.md."
        : "Vendored with modifications (a 'Crease notes' section and tool substitutions); changes are recorded in SOURCE.md.",
    })
  }

  // OrcaSlicer-derived slicer profiles (see resources/slicer-profiles/SOURCE.md)
  const prof = "resources/slicer-profiles"
  if (existsSync(join(ROOT, prof, "LICENSE-AGPL-3.0.txt")))
    out.push({
      name: "OrcaSlicer printer/process/filament profiles (flattened and tuned)",
      version: "OrcaSlicer 2.4.2",
      license: "AGPL-3.0 (upstream repository licence)",
      url: "https://github.com/OrcaSlicer/OrcaSlicer/tree/main/resources/profiles",
      from: [`${prof}/SOURCE.md`, `${prof}/LICENSE-AGPL-3.0.txt`],
      text: read(`${prof}/LICENSE-AGPL-3.0.txt`),
      note:
        "resources/slicer-profiles/*/ are derived from OrcaSlicer's bundled Creality and OrcaFilamentLibrary " +
        "presets (inheritance flattened, some values tuned). OrcaSlicer is distributed under the GNU AGPL v3; we " +
        "treat these derived JSON files as covered by it. They are plain-text JSON and are their own source; " +
        "you may copy, modify and redistribute them under the AGPL v3. Details: resources/slicer-profiles/SOURCE.md.",
    })
  return out
}

function proprietaryNotes(): string {
  const dir = "node_modules/@anthropic-ai/claude-agent-sdk"
  if (!existsSync(join(ROOT, dir, "package.json"))) return ""
  const v = (JSON.parse(read(`${dir}/package.json`)) as { version: string }).version
  return [
    RULE,
    `@anthropic-ai/claude-agent-sdk ${v} (JavaScript library)`,
    "Licence: proprietary (Anthropic PBC). Not open source and not covered by Crease's licence (Apache-2.0).",
    RULE,
    read(`${dir}/LICENSE.md`),
    "",
    "Use is governed by Anthropic's Commercial Terms of Service (https://www.anthropic.com/legal/commercial-terms)",
    "and https://code.claude.com/docs/en/legal-and-compliance. Crease does not include the Claude Code CLI",
    "(the SDK's platform package is left out of the app): it runs the user's own, separately installed Claude Code,",
    "unmodified. Each user brings their own Anthropic API key or Claude Code sign-in; Anthropic bills them directly.",
    "",
  ].join("\n")
}

function section(c: Component, sameAs: string | null): string {
  return [
    RULE,
    `${c.name} ${c.version}`,
    `Licence: ${c.license}`,
    ...(c.url ? [`Source: ${c.url}`] : []),
    ...(c.note ? [`Note: ${c.note}`] : []),
    RULE,
    sameAs ? `Licence text (including copyright lines) identical to ${sameAs} above.` : c.text,
    "",
  ].join("\n")
}

export function collect(): { npm: Component[]; electron: Component | null; repo: Component[] } {
  return { npm: npmComponents(), electron: electronComponent(), repo: repoComponents() }
}

export function render(): string {
  const { npm, electron, repo } = collect()
  // Every component gets its own section; a licence text identical to an earlier one (same copyright lines, e.g. a
  // monorepo's packages) is printed once and referenced.
  const all = [...(electron ? [electron] : []), ...repo, ...npm]
  const firstWith = new Map<string, string>()
  const head = [
    "Crease: third-party notices",
    "",
    "Crease is licensed under the Apache License 2.0 (LICENSE, NOTICE). It includes the third-party software",
    "and data listed below. Each is distributed under its own licence, reproduced here. Regenerate with",
    "`npm run notices` (tools/notices.ts); see docs/licenses/INVENTORY.md.",
    "",
    "Not bundled, so not listed: Claude Code, OpenSCAD and OrcaSlicer (installed separately by the user and run as",
    "separate programs), the user's own OpenSCAD libraries, and OrcaSlicer presets the app reads from the user's",
    "OrcaSlicer install at runtime.",
    "",
    "Contents:",
    ...all.map((c) => `  - ${c.name} ${c.version} (${c.license})`),
    "  - @anthropic-ai/claude-agent-sdk (proprietary, see the last section)",
    "",
  ].join("\n")
  const sections = all.map((c) => {
    const key = c.text.replace(/\s+/g, " ").trim()
    const first = key.length > 200 ? firstWith.get(key) : undefined
    if (!first) firstWith.set(key, `${c.name} ${c.version}`)
    return section(c, first ?? null)
  })
  return [head, ...sections, proprietaryNotes()].join("\n").trimEnd() + "\n"
}

function summary(): string {
  const { npm, electron, repo } = collect()
  const counts = new Map<string, number>()
  for (const c of [...npm, ...(electron ? [electron] : [])]) counts.set(c.license, (counts.get(c.license) ?? 0) + 1)
  const lines = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `  ${l}: ${n}`)
  const notable = npm.filter((c) => !/^(MIT|ISC|Apache-2\.0|BSD-[23]-Clause|0BSD|BlueOak-1\.0\.0|MIT-0|CC0-1\.0|Unlicense|Python-2\.0|\(MIT OR CC0-1\.0\)|MIT OR Apache-2\.0|\(MIT OR Apache-2\.0\))$/.test(c.license))
  return [
    `npm production packages shipped: ${npm.length} (+ electron)`,
    ...lines,
    "",
    "Needs attention (non-permissive or unusual):",
    ...notable.map((c) => `  ${c.name}@${c.version}: ${c.license}`),
    "",
    "Repo material:",
    ...repo.map((c) => `  ${c.name}: ${c.license}`),
  ].join("\n")
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--summary")) console.log(summary())
  else if (process.argv.includes("--check")) {
    const ok = existsSync(OUT) && readFileSync(OUT, "utf8") === render()
    console.log(ok ? "THIRD_PARTY_NOTICES.txt is up to date" : "THIRD_PARTY_NOTICES.txt is out of date: run npm run notices")
    process.exit(ok ? 0 : 1)
  } else {
    writeFileSync(OUT, render())
    console.log(`wrote ${OUT}`)
  }
}
