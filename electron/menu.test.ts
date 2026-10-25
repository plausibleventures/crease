// The native menu can't be clicked headlessly, so this checks the template: items, accelerators, and that each app
// command sends the right IPC to the focused window. (Clicking the real menu by hand is still untested.)
import type { MenuItemConstructorOptions } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"

const sent = vi.fn()
const win = { webContents: { send: sent } }
let focused: typeof win | null = win
vi.mock("electron", () => ({
  app: { name: "printstudio" }, // the real app.name; the menu must say Crease regardless
  BrowserWindow: { getFocusedWindow: () => focused, getAllWindows: () => [win] },
  Menu: { buildFromTemplate: vi.fn((t: unknown) => t), setApplicationMenu: vi.fn() },
}))
const { buildAppMenu, menuTemplate } = await import("./menu")
const { Menu } = await import("electron")

type Item = MenuItemConstructorOptions
const items = (t: Item[]): Item[] => t.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? items(i.submenu) : [])])
const byLabel = (t: Item[], label: string) => items(t).find((i) => i.label === label)
const click = (i: Item | undefined) => (i?.click as unknown as () => void)()

beforeEach(() => {
  sent.mockClear()
  focused = win
})

describe("app menu template", () => {
  const mac = menuTemplate({ dev: false, isMac: true })

  it("has the app commands with their accelerators", () => {
    const want: [string, string | undefined, string][] = [
      ["New Project…", "CmdOrCtrl+N", "new-project"],
      ["Open…", "CmdOrCtrl+O", "open-library"],
      ["Settings…", "CmdOrCtrl+,", "settings"],
      ["About Crease", undefined, "about"],
      ["Command Palette…", "CmdOrCtrl+K", "palette"],
      ["Library", "CmdOrCtrl+1", "go-library"],
      ["Machines", "CmdOrCtrl+2", "go-machines"],
      ["Designers", "CmdOrCtrl+3", "go-designers"],
      ["Back", "CmdOrCtrl+[", "back"],
      ["Keyboard Shortcuts", "CmdOrCtrl+/", "shortcuts"],
    ]
    for (const [label, accel, cmd] of want) {
      const it = byLabel(mac, label)
      expect(it, label).toBeTruthy()
      expect(it!.accelerator, label).toBe(accel)
      sent.mockClear()
      click(it)
      expect(sent, label).toHaveBeenCalledWith("printstudio:command", cmd)
    }
  })

  it("no two items share an accelerator", () => {
    const accels = items(mac).flatMap((i) => (i.accelerator ? [String(i.accelerator)] : []))
    expect(new Set(accels).size).toBe(accels.length)
  })

  it("macOS: About and Settings sit in the app menu; the standard roles are there", () => {
    const appMenu = mac[0].submenu as Item[]
    expect(mac[0].label).toBe("Crease")
    expect(appMenu[0].label).toBe("About Crease")
    expect(appMenu.some((i) => i.label === "Settings…")).toBe(true)
    const roles = items(mac).map((i) => i.role)
    for (const r of ["quit", "close", "undo", "copy", "paste", "windowMenu", "help"]) expect(roles).toContain(r)
    expect(roles).not.toContain("about") // our About opens Settings > About instead of the bare panel
    expect(roles).not.toContain("toggleDevTools")
  })

  it("Windows/Linux: Settings in File, About in Help, Quit in File; dev adds reload + devtools", () => {
    const other = menuTemplate({ dev: true, isMac: false })
    expect(other[0].label).toBe("File")
    expect((other[0].submenu as Item[]).some((i) => i.label === "Settings…")).toBe(true)
    expect((other[0].submenu as Item[]).some((i) => i.role === "quit")).toBe(true)
    const help = other.find((i) => i.role === "help")!
    expect((help.submenu as Item[]).some((i) => i.label === "About Crease")).toBe(true)
    expect(items(other).map((i) => i.role)).toContain("toggleDevTools")
  })

  it("sends to the first window when none is focused", () => {
    focused = null
    click(byLabel(mac, "New Project…"))
    expect(sent).toHaveBeenCalledWith("printstudio:command", "new-project")
  })

  it("buildAppMenu installs the template", () => {
    buildAppMenu({ dev: false })
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1)
  })
})
