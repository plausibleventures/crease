/**
 * The product name users see (menus, window title, About, build packs, messages). The app was called Print Studio
 * before; internal names (npm package "printstudio", PRINTSTUDIO_* env vars, .studio/ folders) are unchanged.
 *
 * Not Electron's app.name: that stays "printstudio" (package.json "name", no "productName") because it keys the
 * userData folder and the macOS Keychain item that encrypts stored keys. See electron/identity.test.ts.
 */
export const APP_NAME = "Crease"
