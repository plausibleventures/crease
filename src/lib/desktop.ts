// What the desktop shell's preload exposes (electron/preload.ts). Absent in the browser dev build.
interface DesktopBridge {
  apiBase: string
  token: string
  isElectron: true
  chooseApp?: (title: string) => Promise<string | null>
  revealFile?: (projectId: string, path: string) => Promise<boolean>
  /** Show the data folder (STUDIO_HOME) in Finder. */
  showDataFolder?: () => Promise<boolean>
  /** App menu commands (electron/menu.ts); returns an unsubscribe function. */
  onCommand?: (fn: (cmd: string) => void) => () => void
}

/** "Show in Finder" for a project file; null in a browser (no such action there). */
export function revealFileFn(): ((projectId: string, path: string) => Promise<boolean>) | null {
  return desktop()?.revealFile ?? null
}

export function desktop(): DesktopBridge | null {
  return (window as unknown as { printStudio?: DesktopBridge }).printStudio ?? null
}

/** Native "choose an app" picker in the desktop app; null when cancelled or in a browser. */
export async function chooseApp(title: string): Promise<string | null> {
  const fn = desktop()?.chooseApp
  return fn ? fn(title) : null
}
