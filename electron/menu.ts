// Native application menu (U4): standard macOS menus and shortcuts. App commands are sent to the focused window's
// renderer as "printstudio:command" (src/lib/commands.ts runs them), so the menu and the browser build's keyboard
// handler share one list of commands. electron/menu.test.ts checks the template (the real menu can't be clicked
// headlessly).
import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron"
import { APP_NAME } from "../shared/brand"

/** Must match AppCommand in src/lib/commands.ts. */
export type MenuCommand = "new-project" | "open-library" | "settings" | "about" | "palette" | "shortcuts" | "go-library" | "go-machines" | "go-designers" | "back"

const send = (cmd: MenuCommand) => () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send("printstudio:command", cmd)
}

/** The menu template; `isMac` puts About and Settings in the app menu (elsewhere: Help and File). */
export function menuTemplate(opts: { dev: boolean; isMac?: boolean }): MenuItemConstructorOptions[] {
  const isMac = opts.isMac ?? process.platform === "darwin"
  const settings: MenuItemConstructorOptions = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: send("settings") }
  // Settings > About (version, licence, data folder, tool versions, Report a problem) rather than the bare panel
  const about: MenuItemConstructorOptions = { label: `About ${APP_NAME}`, click: send("about") }
  return [
    ...(isMac
      ? [
          {
            label: APP_NAME, // not app.name: that stays "printstudio" (see main.ts)
            submenu: [
              about,
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Project…", accelerator: "CmdOrCtrl+N", click: send("new-project") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: send("open-library") },
        { type: "separator" },
        ...(isMac ? [] : [settings, { type: "separator" } as MenuItemConstructorOptions]),
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Command Palette…", accelerator: "CmdOrCtrl+K", click: send("palette") },
        { type: "separator" },
        { label: "Library", accelerator: "CmdOrCtrl+1", click: send("go-library") },
        { label: "Machines", accelerator: "CmdOrCtrl+2", click: send("go-machines") },
        { label: "Designers", accelerator: "CmdOrCtrl+3", click: send("go-designers") },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: send("back") },
        { type: "separator" },
        ...(opts.dev ? ([{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] satisfies MenuItemConstructorOptions[]) : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: send("shortcuts") },
        ...(isMac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, about]),
      ],
    },
  ]
}

export function buildAppMenu(opts: { dev: boolean }) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(opts)))
}
