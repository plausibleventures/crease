// Blender parts end to end: the sandbox (no network, no writes outside its folder, no other programs, timeout),
// the build cache, build-pack trust, and a .blend.py part through register -> render -> check -> parameters ->
// orientation. Needs Blender on macOS; skipped elsewhere.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const home = realpathSync(mkdtempSync(join(tmpdir(), "printstudio-blender-")))
process.env.PRINTSTUDIO_HOME = home

type Blender = typeof import("./blender")
type Tools = typeof import("../tools/index")
let blender: Blender
let tools: Tools
let available = false

beforeAll(async () => {
  blender = await import("./blender")
  tools = await import("../tools/index")
  available = process.platform === "darwin" && !!tools.blenderTool()
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

const FIGURE = `# printstudio:sculpt
import printstudio as ps
# --- settings ---
height = 40  # [20:1:80] Height (mm)
# --- end settings ---
s = height / 40
ps.lathe([(10 * s, 0), (10 * s, 3 * s), (6 * s, 5 * s), (3 * s, 20 * s), (0, 22 * s)])
ps.skin([(0, 0, 15 * s), (0, 0, 32 * s), (6 * s, -2 * s, 24 * s)], [(0, 1), (1, 2)], [4 * s, 3 * s, 1.5 * s])
ps.ellipsoid((0, 0, 36 * s), 4.5 * s)
ps.fuse(voxel=0.5)
`

function project(name: string, files: Record<string, string>): string {
  const root = join(home, name)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  mkdirSync(join(root, "build"), { recursive: true })
  return root
}

describe("sandbox profile", () => {
  it("denies network, other programs, Apple events and writes; hides home and the app's data", () => {
    const p = blender.blenderSandboxProfile({ bin: "/Applications/Blender.app/Contents/MacOS/Blender", outDir: "/tmp/x", readDirs: [] })
    expect(p).toContain("(deny network*)")
    expect(p).toContain("(deny process-exec)")
    expect(p).toMatch(/\(allow process-exec \(literal "[^"]*Blender"\)\)/)
    expect(p).toContain("(deny mach-lookup)")
    expect(p).toContain("(deny lsopen)")
    expect(p).toContain("(deny file-write*)")
    expect(p).toMatch(/\(deny file-read\* [^\n]*\(subpath "\/Users"\)/)
    expect(p).toContain(`(subpath "${home}")`) // STUDIO_HOME
  })
})

describe("Blender parts (needs Blender)", () => {
  it("builds a script into an STL and an OpenSCAD wrapper, then reuses the build", async () => {
    if (!available) return
    const root = project("p1", { "parts/fig.blend.py": FIGURE })
    const b = await blender.buildSculpt(root, "fig", "parts/fig.blend.py", { height: 50 })
    expect(b.cached).toBe(false)
    expect(b.bodies).toHaveLength(1)
    const stl = join(root, "build", b.bodies[0].file)
    expect(readFileSync(stl).length).toBeGreaterThan(84 + 50 * 1000)
    const wrapper = readFileSync(b.wrapperAbs, "utf8")
    expect(wrapper).toContain(`import("${b.bodies[0].file}"`)
    expect(wrapper).toContain("height = 40; // [20:1:80] Height (mm)") // the design value (saved values come as -D, like any part)
    const again = await blender.buildSculpt(root, "fig", "parts/fig.blend.py", { height: 50 })
    expect(again.cached).toBe(true)
    expect(again.hash).toBe(b.hash)
    const other = await blender.buildSculpt(root, "fig", "parts/fig.blend.py", { height: 30 })
    expect(other.hash).not.toBe(b.hash)
  }, 120_000)

  it("a script error comes back with the part's file name and line", async () => {
    if (!available) return
    const root = project("p2", { "parts/bad.blend.py": "import printstudio as ps\nps.ellipsoid((0, 0, 5), 5)\nps.no_such_helper()\n" })
    await expect(blender.buildSculpt(root, "bad", "parts/bad.blend.py")).rejects.toThrow(/parts\/bad\.blend\.py", line 3[\s\S]*AttributeError/)
  }, 60_000)

  it("the sandbox stops network, writes outside its folder, reading home and starting programs", async () => {
    if (!available) return
    const homeProbe = join(homedir(), `.printstudio-sandbox-probe-${process.pid}`)
    const root = project("p3", {
      "parts/evil.blend.py": `import os, socket, subprocess
import printstudio as ps
res = []
def t(name, fn):
    try:
        fn()
        res.append(name + "=OK")
    except Exception as e:
        res.append(name + "=DENIED")
t("net", lambda: socket.create_connection(("1.1.1.1", 80), timeout=3))
t("localhost", lambda: socket.create_connection(("127.0.0.1", 5174), timeout=3))
t("write_project", lambda: open(${JSON.stringify(join(home, "p3", "parts", "planted.py"))}, "w").write("x"))
t("write_home", lambda: open(${JSON.stringify(homeProbe)}, "w").write("x"))
t("write_studio_home", lambda: open(${JSON.stringify(join(home, "settings.json"))}, "w").write("x"))
t("read_studio_home", lambda: os.listdir(${JSON.stringify(home)}))
t("read_ssh", lambda: os.listdir(${JSON.stringify(join(homedir(), ".ssh"))}))
t("exec", lambda: subprocess.run(["/bin/echo", "hi"], check=True))
raise RuntimeError(" ".join(res))
`,
    })
    const err = await blender.buildSculpt(root, "evil", "parts/evil.blend.py").catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    const msg = String((err as Error).message)
    for (const probe of ["net", "localhost", "write_project", "write_home", "write_studio_home", "read_studio_home", "read_ssh", "exec"]) expect(msg).toContain(`${probe}=DENIED`)
    expect(existsSync(join(root, "parts", "planted.py"))).toBe(false)
    expect(existsSync(homeProbe)).toBe(false)
  }, 60_000)

  it("stops a script that runs too long", async () => {
    if (!available) return
    const out = realpathSync(mkdtempSync(join(tmpdir(), "ps-blender-loop-")))
    writeFileSync(join(out, "loop.py"), "while True:\n    pass\n")
    const r = await blender.runBlenderSandboxed({ bin: tools.blenderBin(), outDir: out, readDirs: [], python: join(out, "loop.py"), timeoutMs: 4000 })
    rmSync(out, { recursive: true, force: true })
    expect(r.timedOut).toBe(true)
  }, 60_000)

  it("a script from a build pack waits for the user's OK", async () => {
    if (!available) return
    const trust = await import("./sculpt-trust")
    const root = project("p4", { "parts/fig.blend.py": FIGURE.replace("height = 40", "height = 41") })
    trust.blockScripts("p4", [{ rel: "parts/fig.blend.py", content: readFileSync(join(root, "parts", "fig.blend.py")) }])
    await expect(blender.buildSculpt(root, "fig", "parts/fig.blend.py")).rejects.toMatchObject({ code: "BLOCKED" })
    expect(trust.blockedScripts("p4")).toEqual(["parts/fig.blend.py"])
    expect(trust.allowScripts("p4")).toEqual(["parts/fig.blend.py"])
    expect((await blender.buildSculpt(root, "fig", "parts/fig.blend.py")).bodies).toHaveLength(1)
  }, 60_000)
})

describe("the blender-sculpting skill", () => {
  const skillDir = join(__dirname, "..", "agent", "skills", "blender-sculpting")
  it("documents every helper the designer can call", () => {
    const helpers = readFileSync(join(__dirname, "sculpt-py", "printstudio.py"), "utf8")
    const all = /__all__ = \[([\s\S]*?)\]/.exec(helpers)![1].match(/"(\w+)"/g)!.map((x) => x.slice(1, -1))
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8")
    for (const name of all.filter((n) => !["PROJECT", "Vector", "Matrix", "clear"].includes(n))) expect(skill).toContain(`ps.${name}(`)
  })

  it("its template king builds into one printable body", async () => {
    if (!available) return
    const root = project("tpl", { "parts/king.blend.py": readFileSync(join(skillDir, "template-king.blend.py"), "utf8") })
    const b = await blender.buildSculpt(root, "king", "parts/king.blend.py")
    expect(b.bodies).toHaveLength(1)
    expect(b.bodies[0].faces).toBeLessThanOrEqual(blender.MAX_FACES)
  }, 120_000)
})

describe("a Blender part in a project (needs Blender and OpenSCAD)", () => {
  it("registers, renders (with a back view), checks, takes parameters and an orientation", async () => {
    if (!available || !tools.openscadTool()) return
    const store = await import("../projects/store")
    const cad = await import("./index")
    const { applyPyParameters } = await import("./sculpt")
    const p = await store.createProject("Sculpt")
    const root = store.projectDir(p.id)
    rmSync(join(root, "parts", "main.scad"))
    writeFileSync(join(root, "parts", "figure.blend.py"), FIGURE)
    const proj = await store.getProject(p.id)
    expect(proj.parts.map((x) => [x.id, x.file])).toEqual([["figure", "parts/figure.blend.py"]])

    const r = await cad.renderPart(p.id, "figure")
    expect(r.error).toBeUndefined()
    expect(r.images.map((i) => i.view).sort()).toEqual(["back", "bed", "front", "iso", "right", "top"])
    expect(r.stats?.manifold).toBe(true)
    expect(r.stats?.bodies).toBe(1)
    expect(r.stats?.sizeMm[2]).toBeGreaterThan(38)
    expect(r.stats?.bbox.min[2]).toBeCloseTo(0, 1)

    const report = await cad.checkPart(p.id, "figure")
    expect(report.items.length).toBeGreaterThan(0)

    const params = await cad.listParameters(p.id, "figure")
    expect(params).toEqual([expect.objectContaining({ name: "height", value: 40, min: 20, max: 80 })])
    const taller = await cad.renderPart(p.id, "figure", { height: 60 })
    expect(taller.stats!.sizeMm[2]).toBeGreaterThan(r.stats!.sizeMm[2] * 1.3)

    const src = readFileSync(join(root, "parts", "figure.blend.py"), "utf8")
    writeFileSync(join(root, "parts", "figure.blend.py"), applyPyParameters(src, { height: 30 }).source)
    await cad.renderPart(p.id, "figure", {})
    expect((await cad.listParameters(p.id, "figure"))[0].value).toBe(30)

    const o = await cad.setPartOrientation(p.id, "figure", [90, 0, 0])
    expect(o.rotate).toEqual([90, 0, 0])
    const lying = await cad.renderPart(p.id, "figure")
    expect(lying.stats!.sizeMm[1]).toBeGreaterThan(lying.stats!.sizeMm[2]) // now lies on its back
    await cad.unwatchProject()
  }, 240_000)
})
