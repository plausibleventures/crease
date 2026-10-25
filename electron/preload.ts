// Sandboxed preload: exposes the server base URL and per-launch token to the renderer.
// The UI can keep using relative /api and /ws (the token also rides along as a cookie);
// window.printStudio is for code that needs an absolute URL or an explicit header.
import { contextBridge, ipcRenderer } from "electron"

const config = ipcRenderer.sendSync("printstudio:config") as { apiBase: string; token: string; isElectron: true }
contextBridge.exposeInMainWorld("printStudio", {
  ...config,
  /** Native file picker for an app (.app bundle or binary); resolves to its path, or null if cancelled. */
  chooseApp: (title: string) => ipcRenderer.invoke("printstudio:choose-app", title) as Promise<string | null>,
  /** Show a project file in Finder (project-relative path; the main process checks it stays in the project). */
  revealFile: (projectId: string, path: string) => ipcRenderer.invoke("printstudio:reveal-file", projectId, path) as Promise<boolean>,
  /** Settings > About "Show in Finder": the data folder (STUDIO_HOME; the main process decides the path). */
  showDataFolder: () => ipcRenderer.invoke("printstudio:show-data-folder") as Promise<boolean>,
  /** App menu commands (electron/menu.ts): "new-project", "settings", … Returns an unsubscribe function. */
  onCommand: (fn: (cmd: string) => void) => {
    const h = (_e: unknown, cmd: unknown) => typeof cmd === "string" && fn(cmd)
    ipcRenderer.on("printstudio:command", h)
    return () => ipcRenderer.removeListener("printstudio:command", h)
  },
})
