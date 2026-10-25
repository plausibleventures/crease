// Electron main process: runs the Crease server in-process and opens the renderer.
//
// Identity: the product is "Crease" (shared/brand.ts), but Electron's app.name stays "printstudio" (package.json
// "name"). app.name keys the userData folder and the macOS Keychain item ("printstudio Safe Storage") that encrypts
// secrets.json, so changing it would lock every stored API key. Never call app.setName (electron/identity.test.ts).
//
// Prod: Fastify listens on 127.0.0.1:<random port> and also serves the built renderer (dist/), so the
//   UI's relative /api and /ws URLs keep working. A per-launch token is required on /api and /ws; the
//   main process sets it as an httpOnly cookie for that origin before loading the page.
// Dev (PRINTSTUDIO_DEV_URL=http://localhost:5173): Fastify listens on the fixed port 5174 that the Vite
//   proxy targets; the token cookie is set on the Vite origin and forwarded by the proxy.
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from "electron"
import { randomBytes } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { APP_NAME } from "../shared/brand"
import { fixGuiPath } from "../server/tools/shell-path"
import { startAutoUpdate } from "./updater"
import { buildAppMenu } from "./menu"

const HERE = dirname(fileURLToPath(import.meta.url)) // dist-electron/
const ROOT = join(HERE, "..")
const DEV_URL = process.env.PRINTSTUDIO_DEV_URL ?? null

// Paths the server derives from import.meta.url would point inside dist-electron/ once bundled.
process.env.PRINTSTUDIO_SLICER_PROFILES ??= join(ROOT, "resources", "slicer-profiles")
process.env.PRINTSTUDIO_STARTERS ??= join(ROOT, "resources", "starters")
process.env.PRINTSTUDIO_OPENSCAD_LIBRARIES ??= join(ROOT, "resources", "openscad-libraries")

// Opened from Finder/Dock, macOS gives the app launchd's minimal PATH: merge in the login shell's (Homebrew,
// ~/.local/bin, ...) so tool discovery and the designer's Bash see what Terminal sees.
fixGuiPath()

// Local-only printer cameras (R19): Chromium hides this computer's LAN address behind random mDNS names in WebRTC
// offers, which printers (Creality :8000) can't resolve, so without a STUN server no video arrives. Show the real
// host candidates instead; the camera then works on a LAN with no internet. (The server also rewrites any mDNS
// names it still sees, for the plain-browser dev setup.)
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns")

// Test launches (e2e, release smoke tests): a throwaway Chromium profile and no Keychain access, so a second copy
// of the app never shares the real profile or asks for the real Keychain item. Never set in normal use.
if (process.env.PRINTSTUDIO_USER_DATA) app.setPath("userData", process.env.PRINTSTUDIO_USER_DATA)
const NO_KEYCHAIN = process.env.PRINTSTUDIO_NO_KEYCHAIN === "1"

// PRINTSTUDIO_TOKEN lets an e2e harness talk to the API; normally random per launch.
const token = process.env.PRINTSTUDIO_TOKEN || randomBytes(32).toString("hex")
let apiBase = ""
let closeServer: (() => Promise<void>) | null = null

ipcMain.on("printstudio:config", (e) => {
  e.returnValue = { apiBase, token, isElectron: true }
})

// Settings > "Choose…" for OpenSCAD / OrcaSlicer: a native picker (a .app bundle or a binary).
ipcMain.handle("printstudio:choose-app", async (e, title: unknown) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const opts = {
    title: typeof title === "string" ? title.slice(0, 100) : "Choose the app",
    defaultPath: "/Applications",
    properties: ["openFile" as const],
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : (r.filePaths[0] ?? null)
})

// Files section > "Show in Finder": the renderer names a project and a project-relative path; the path is resolved
// with the server's own containment rules (no `..`, no links out of the project), never taken as an absolute path.
ipcMain.handle("printstudio:reveal-file", async (_e, projectId: unknown, rel: unknown) => {
  if (typeof projectId !== "string" || typeof rel !== "string") return false
  const { resolveProjectPath } = await import("../server/projects/store")
  try {
    shell.showItemInFolder(resolveProjectPath(projectId, rel))
    return true
  } catch {
    return false
  }
})

// Settings > About > "Show in Finder": the data folder. No argument from the renderer; the path is the server's own.
ipcMain.handle("printstudio:show-data-folder", async () => {
  const { STUDIO_HOME } = await import("../server/config")
  shell.showItemInFolder(STUDIO_HOME)
  return true
})

async function loadWithRetry(win: BrowserWindow, url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      await win.loadURL(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 500)) // Vite may still be starting in dev
    }
  }
  throw new Error("could not load " + url)
}

async function createWindow(pageUrl: string) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: APP_NAME,
    show: false,
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep the 3D viewer and live timeline updating while the window is behind other windows.
      backgroundThrottling: false,
    },
  })
  const origin = new URL(pageUrl).origin
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin !== origin) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })
  win.once("ready-to-show", () => win.show())
  await loadWithRetry(win, pageUrl)
  return win
}

/**
 * OS-backed encryption for the server's secret store (API keys): safeStorage, whose key lives in the macOS
 * Keychain (DPAPI on Windows, libsecret/kwallet on Linux). Null when unavailable, or on Linux's insecure
 * "basic_text" backend; the server then falls back to its labelled dev store (see server/secrets.ts).
 */
function secretCipher() {
  if (NO_KEYCHAIN || !safeStorage.isEncryptionAvailable()) return null
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return null
  return {
    encrypt: (plain: string) => safeStorage.encryptString(plain),
    decrypt: (data: Buffer) => safeStorage.decryptString(data),
  }
}

/** Build pack guide PDF: load the self-contained guide HTML in a hidden, script-less window and print it. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const file = join(app.getPath("temp"), `printstudio-guide-${randomBytes(6).toString("hex")}.html`)
  writeFileSync(file, html)
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
  } finally {
    win.destroy()
    rmSync(file, { force: true })
  }
}

async function main() {
  await app.whenReady()
  // Dev runs inside Electron's own bundle, so the Dock would show Electron's icon; packaged builds get build/icon.png.
  if (DEV_URL) app.dock?.setIcon(join(ROOT, "build", "icon.png"))
  const { startServer } = await import("../server/index")
  shutdownAgents = (await import("../server/agent/index")).shutdownAgents
  const { app: server, address } = await startServer({
    host: "127.0.0.1",
    // PRINTSTUDIO_PORT / PORT when set (fixed port, e.g. for demos or e2e); otherwise dev: 5174 (the Vite proxy
    // target), prod: random.
    port: Number(process.env.PRINTSTUDIO_PORT || process.env.PORT || (DEV_URL ? 5174 : 0)),
    token,
    staticDir: DEV_URL ? undefined : join(ROOT, "dist"),
    secretCipher: secretCipher(),
    htmlToPdf,
    // Library "Move to Trash": the project folder goes to the OS Trash (restorable from Finder)
    trashItem: (abs: string) => shell.trashItem(abs),
    appVersion: app.getVersion(),
  })
  closeServer = () => server.close()
  apiBase = address
  console.log(`[electron] server listening at ${address}`)
  const pageUrl = DEV_URL ?? address + "/"
  await session.defaultSession.cookies.set({
    url: new URL(pageUrl).origin,
    name: "ps_token",
    value: token,
    httpOnly: true,
    sameSite: "strict",
  })
  buildAppMenu({ dev: !!DEV_URL })
  const win = await createWindow(pageUrl)
  // Test hook: PRINTSTUDIO_SCREENSHOT=<file.png> captures the window a few seconds after load.
  const shot = process.env.PRINTSTUDIO_SCREENSHOT
  if (shot) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage()
      writeFileSync(shot, img.toPNG())
      console.log(`[electron] screenshot written to ${shot}`)
    }, Number(process.env.PRINTSTUDIO_SCREENSHOT_DELAY_MS ?? 4000))
  }
  void startAutoUpdate()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(pageUrl)
  })
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
// Agent CLI processes must not outlive the app: end sessions synchronously on quit, and on fatal errors.
// (A SIGKILL'd app is covered by the per-session watchdog in server/agent/spawn.ts.)
let shutdownAgents: (() => void) | null = null
app.on("before-quit", () => {
  try {
    shutdownAgents?.()
  } catch (e) {
    console.error("[electron] agent shutdown failed", e)
  }
  void closeServer?.()
})
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => app.quit())
process.on("uncaughtException", (e) => {
  console.error("[electron] uncaught exception", e)
  shutdownAgents?.()
  app.exit(1)
})

main().catch((e) => {
  console.error("[electron] startup failed", e)
  app.exit(1)
})
