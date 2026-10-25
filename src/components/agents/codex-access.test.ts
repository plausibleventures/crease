import { describe, expect, it } from "vitest"
import { codexMode, codexModeChange } from "./codex-access"

const sub = { kind: "subscription" as const }
const key = { kind: "api-key" as const, credentialRef: "profile.codex.apiKey" }

describe("Codex sign-in choice", () => {
  it("reads the mode from the profile's auth and Settings.codex.login", () => {
    expect(codexMode(sub, undefined)).toBe("app")
    expect(codexMode(sub, { login: "app" })).toBe("app")
    expect(codexMode(sub, { login: "user" })).toBe("user")
    expect(codexMode(key, { login: "user" })).toBe("api-key")
  })
  it("changes only what differs", () => {
    const keyRef = "profile.codex.apiKey"
    expect(codexModeChange("user", { auth: sub, settings: {}, keyRef })).toEqual({ login: "user" })
    expect(codexModeChange("app", { auth: sub, settings: { login: "user" }, keyRef })).toEqual({ login: "app" })
    expect(codexModeChange("app", { auth: sub, settings: undefined, keyRef })).toEqual({})
    expect(codexModeChange("api-key", { auth: sub, settings: { login: "user" }, keyRef })).toEqual({ auth: key })
    expect(codexModeChange("user", { auth: key, settings: {}, keyRef })).toEqual({ auth: sub, login: "user" })
    expect(codexModeChange("app", { auth: key, settings: {}, keyRef })).toEqual({ auth: sub })
  })
})
