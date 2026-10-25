// App-wide commands (U4): one list shared by the native menu (electron/menu.ts), the browser build's keyboard
// shortcuts, the command palette (⌘K) and the shortcuts sheet (?).
import { create } from "zustand"
import { desktop } from "@/lib/desktop"
import { useStudio } from "@/stores/studio"

export type AppCommand =
  | "new-project"
  | "open-library"
  | "settings"
  | "about"
  | "palette"
  | "shortcuts"
  | "go-library"
  | "go-machines"
  | "go-designers"
  | "back"

/** Overlays the commands open (mounted once in App). */
export const useAppOverlays = create<{
  palette: boolean
  shortcuts: boolean
  newProject: boolean
  set: (p: Partial<{ palette: boolean; shortcuts: boolean; newProject: boolean }>) => void
}>((set) => ({ palette: false, shortcuts: false, newProject: false, set: (p) => set(p) }))

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export const modKey = (k: string) => (isMac ? `⌘${k}` : `Ctrl+${k}`)

export function runCommand(cmd: AppCommand) {
  const st = useStudio.getState()
  const ov = useAppOverlays.getState()
  switch (cmd) {
    case "new-project":
      ov.set({ palette: false, shortcuts: false, newProject: true })
      return
    case "open-library":
      ov.set({ palette: false })
      st.navigate({ name: "library" })
      // the Library mounts its search box on the next frame
      setTimeout(() => document.getElementById("library-search")?.focus(), 50)
      return
    case "settings":
      ov.set({ palette: false, shortcuts: false })
      st.setSettingsOpen(true)
      return
    case "about":
      ov.set({ palette: false, shortcuts: false })
      st.setSettingsOpen(true, "about")
      return
    case "palette":
      ov.set({ palette: !ov.palette, shortcuts: false })
      return
    case "shortcuts":
      ov.set({ shortcuts: !ov.shortcuts, palette: false })
      return
    case "go-library":
      return st.navigate({ name: "library" })
    case "go-machines":
      return st.navigate({ name: "machines" })
    case "go-designers":
      return st.navigate({ name: "agents" })
    case "back":
      window.history.back()
      return
  }
}

/** The shortcuts sheet's list; `keys` uses the platform's modifier. */
export function shortcutList(): { group: string; items: { label: string; keys: string }[] }[] {
  return [
    {
      group: "Everywhere",
      items: [
        { label: "Command palette", keys: modKey("K") },
        { label: "New project", keys: modKey("N") },
        { label: "Open a project", keys: modKey("O") },
        { label: "Settings", keys: modKey(",") },
        { label: "Keyboard shortcuts", keys: "?" },
      ],
    },
    {
      group: "Go to",
      items: [
        { label: "Library", keys: modKey("1") },
        { label: "Machines", keys: modKey("2") },
        { label: "Designers", keys: modKey("3") },
        { label: "Back", keys: modKey("[") },
      ],
    },
    {
      group: "In a project",
      items: [
        { label: "Save code", keys: modKey("S") },
        { label: "Close a panel or dialog", keys: "Esc" },
      ],
    },
  ]
}

const isEl = (t: EventTarget | null): t is HTMLElement => typeof HTMLElement !== "undefined" && t instanceof HTMLElement

function isEditable(t: EventTarget | null): boolean {
  if (!isEl(t)) return false
  return t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")
}

/** Keydown → command. In the desktop app the menu owns the ⌘ shortcuts (accelerators); only "?" is handled here. */
export function commandForKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target">, inDesktop: boolean, mac = isMac): AppCommand | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) {
    if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditable(e.target)) return "shortcuts"
    return null
  }
  if (inDesktop || e.altKey) return null
  const k = e.key.toLowerCase()
  // the code editor keeps its own ⌘K chords
  if (k === "k") return isEl(e.target) && e.target.closest(".monaco-editor") ? null : "palette"
  if (e.shiftKey) return null
  switch (k) {
    case "n":
      return "new-project"
    case "o":
      return "open-library"
    case ",":
      return "settings"
    case "1":
      return "go-library"
    case "2":
      return "go-machines"
    case "3":
      return "go-designers"
    case "[":
      return "back"
    case "/":
      return "shortcuts"
    default:
      return null
  }
}

/** Install the keyboard shortcuts and the desktop menu bridge; returns a cleanup. */
export function installCommands(): () => void {
  const bridge = desktop()
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.repeat) return
    const cmd = commandForKey(e, !!bridge?.onCommand)
    if (!cmd) return
    e.preventDefault()
    runCommand(cmd)
  }
  window.addEventListener("keydown", onKey)
  const off = bridge?.onCommand?.((c) => runCommand(c as AppCommand))
  // onboarding's "Start a new project" and similar callers
  const onNew = () => runCommand("new-project")
  document.addEventListener("printstudio:new-project", onNew)
  return () => {
    window.removeEventListener("keydown", onKey)
    off?.()
    document.removeEventListener("printstudio:new-project", onNew)
  }
}
