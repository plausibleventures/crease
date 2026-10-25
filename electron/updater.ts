// Auto-update (electron-updater), off unless a feed is configured. Stub for the first public release:
//   PRINTSTUDIO_UPDATE_URL=https://example.com/printstudio/   (a "generic" feed: the folder electron-builder's
//   `--publish` output — latest-mac.yml + the .zip/.dmg — is uploaded to)
// macOS only applies updates to a signed app (Squirrel.Mac), so this stays off until signing is set up
// (see README "Signing and notarization"). Never runs in dev (unpackaged).
import { app } from "electron"

export async function startAutoUpdate(): Promise<void> {
  const feed = process.env.PRINTSTUDIO_UPDATE_URL?.trim()
  if (!app.isPackaged || !feed) return
  try {
    const { default: updater } = await import("electron-updater")
    const { autoUpdater } = updater
    autoUpdater.setFeedURL({ provider: "generic", url: feed })
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on("error", (e) => console.error("[updater]", e?.message ?? e))
    await autoUpdater.checkForUpdatesAndNotify()
  } catch (e) {
    console.error("[updater] check failed", e)
  }
}
