// Electron identity continuity after the Crease rename. Electron's app.name comes from package.json "productName",
// else "name" (set by Electron before main.ts runs). It names:
//   - the userData folder: ~/Library/Application Support/<app.name> (Chromium state: localStorage, cookies, caches);
//   - on macOS, the Keychain item "<app.name> Safe Storage" whose key encrypts secrets.json (safeStorage).
// Existing installs (dev `electron .` and packaged builds alike) run as "printstudio". If app.name changed, stored API
// keys would no longer decrypt. electron-builder's productName ("Crease") only names the .app bundle, the Dock and
// the artifacts; it does not reach the packaged package.json. Renaming app.name needs a key migration first.
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const builder = createRequire(import.meta.url)("../electron-builder.config.cjs")

describe("Electron identity (userData folder + Keychain item)", () => {
  it("app.name stays printstudio", () => {
    expect(pkg.name).toBe("printstudio")
    expect(pkg.productName).toBeUndefined()
    expect(builder.extraMetadata?.name).toBeUndefined()
    expect(builder.extraMetadata?.productName).toBeUndefined()
  })

  it("main.ts never renames the app or moves userData", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8")
    expect(main).not.toMatch(/app\.setName\(|app\.name\s*=/)
    // The only allowed move is the test-launch override (a throwaway profile for e2e runs).
    for (const line of main.split("\n").filter((l) => /setPath\(\s*["']userData/.test(l))) expect(line).toMatch(/PRINTSTUDIO_USER_DATA/)
  })

  it("the bundle is named Crease", () => {
    expect(builder.productName).toBe("Crease")
  })
})
