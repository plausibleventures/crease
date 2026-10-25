// Settings > About: the app's name, version, licence, where its data lives and (when package.json names one) the
// project's repository. The tool versions come from the setup checks (onboarding.ts systemChecks).
import { readFileSync } from "node:fs"
import { arch, platform, release } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { APP_NAME } from "../shared/brand"
import type { AboutInfo } from "../shared/types"
import { STUDIO_HOME } from "./config"
import { appVersion } from "./pack/index"

type Pkg = { name?: string; license?: string; repository?: string | { url?: string }; bugs?: string | { url?: string } }

function readPkg(): Pkg | null {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const dir of [join(here, ".."), here, process.cwd()]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Pkg
      if (pkg.name === "printstudio") return pkg
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * A browsable https URL for package.json's `repository` ("github:o/r", "o/r", "git+https://…/r.git",
 * "git@github.com:o/r.git"), or null when there is none or it isn't one we understand.
 */
export function repoUrlOf(repository: Pkg["repository"]): string | null {
  const raw = (typeof repository === "string" ? repository : repository?.url)?.trim()
  if (!raw) return null
  let m = raw.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (m) return `https://github.com/${m[1]}/${m[2]}`
  m = raw.match(/^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}/${m[3]}`
  m = raw.match(/^(?:git\+)?(https?):\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/)
  if (m) return `https://${m[2]}/${m[3]}/${m[4]}`
  return null
}

/** Where "Report a problem" opens a new issue: GitHub repos only (other hosts have no prefilled-issue URL). */
export function issueUrlOf(repoUrl: string | null): string | null {
  return repoUrl && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repoUrl) ? `${repoUrl}/issues/new` : null
}

export function aboutInfo(): AboutInfo {
  const pkg = readPkg()
  const repoUrl = repoUrlOf(pkg?.repository)
  return {
    name: APP_NAME,
    version: appVersion(),
    license: pkg?.license ?? "Apache-2.0",
    repoUrl,
    issueUrl: issueUrlOf(repoUrl),
    dataDir: STUDIO_HOME,
    os: { platform: platform(), release: release(), arch: arch() },
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
  }
}
