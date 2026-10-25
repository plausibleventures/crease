// Bundles the Electron main (with the server inlined) and preload into dist-electron/.
// All npm packages stay external and resolve from node_modules at runtime (the Agent SDK must,
// so it can find its platform CLI binary; better-sqlite3 is an N-API prebuild that loads as-is).
import { build } from "esbuild"
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "dist-electron")

// npm's allow-scripts policy blocks electron's postinstall (binary download); run it if needed.
if (!existsSync(join(ROOT, "node_modules/electron/dist"))) {
  execFileSync(process.execPath, [join(ROOT, "node_modules/electron/install.js")], { stdio: "inherit" })
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const common = { bundle: true, platform: "node", target: "node22", packages: "external", sourcemap: "linked", logLevel: "info" }
await build({
  ...common,
  entryPoints: [join(ROOT, "electron/main.ts")],
  outfile: join(OUT, "main.mjs"),
  format: "esm",
  // ESM output: give bundled CJS-style code a require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
await build({
  ...common,
  entryPoints: [join(ROOT, "electron/preload.ts")],
  outfile: join(OUT, "preload.cjs"),
  format: "cjs",
})
// Files the server locates relative to its own module (import.meta.url) once bundled.
cpSync(join(ROOT, "server/agent/skills"), join(OUT, "skills"), { recursive: true })
// Blender part runner + sculpting helpers (server/cad/blender.ts: new URL("./sculpt-py/", import.meta.url)).
cpSync(join(ROOT, "server/cad/sculpt-py"), join(OUT, "sculpt-py"), { recursive: true })
