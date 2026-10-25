import { describe, expect, it } from "vitest"
import type { AboutInfo } from "@shared/types"
import { diagnostics, reportBody } from "./diagnostics"

const about: AboutInfo = {
  name: "Crease",
  version: "0.0.1",
  license: "Apache-2.0",
  repoUrl: null,
  issueUrl: null,
  dataDir: "/Users/someone/PrintStudio",
  os: { platform: "darwin", release: "27.0.0", arch: "arm64" },
  runtime: { node: "24.1.0", electron: "44.6.0" },
}

describe("Report a problem summary", () => {
  it("has app, OS and tool versions, and no paths", () => {
    const d = diagnostics(about, {
      openscad: { ok: true, detail: "", path: "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD", version: "2026.10.05" },
      orcaslicer: { ok: true, detail: "", path: "/Users/someone/Apps/OrcaSlicer", version: "2.4.2" },
      claude: { ok: false, detail: "Not found at /Users/someone/.local/bin/claude" },
    })
    expect(d).toBe(
      ["Crease 0.0.1 (desktop app, Electron 44.6.0)", "macOS 27.0.0 arm64 · Node 24.1.0", "OpenSCAD: 2026.10.05", "OrcaSlicer: 2.4.2", "Claude Code: not found"].join("\n"),
    )
    expect(reportBody(d)).not.toMatch(/\/Users|someone|PrintStudio\b/)
  })
  it("drops a version that looks like a path; says when it's the browser build", () => {
    const d = diagnostics({ ...about, runtime: { node: "24", electron: null } }, {
      openscad: { ok: true, detail: "", version: "/Users/someone/x" },
      orcaslicer: { ok: true, detail: "", path: "/x" },
      claude: { ok: null, detail: "" },
    })
    expect(d).toContain("(browser build)")
    expect(d).toContain("OpenSCAD: ?")
    expect(d).toContain("OrcaSlicer: found")
    expect(d).not.toContain("someone")
    expect(d).not.toContain("Blender") // optional: only listed once checked
  })
  it("lists the optional Blender once checked", () => {
    const d = diagnostics(about, {
      openscad: { ok: true, detail: "", version: "2026.10.05" },
      orcaslicer: { ok: true, detail: "", version: "2.4.2" },
      claude: { ok: true, detail: "", version: "2.1.3" },
      blender: { ok: false, detail: "not found" },
    })
    expect(d.split("\n").slice(-1)[0]).toBe("Blender: not found")
  })
})
