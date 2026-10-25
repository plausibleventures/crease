import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// config.ts reads PRINTSTUDIO_HOME at import time: a fresh, empty home (a first launch).
const home = mkdtempSync(join(tmpdir(), "printstudio-onboarding-test-"))
process.env.PRINTSTUDIO_HOME = home

const machines = await import("./machines")
const config = await import("./config")
const onboarding = await import("./onboarding")
const { stopPractice } = await import("./printer/practice")

afterAll(async () => {
  await stopPractice()
  rmSync(home, { recursive: true, force: true })
})

const sparkx = (connection: { type: "moonraker"; host: string; port: number }, extra: object = {}) => ({
  ...machines.getMachine("practice-printer"),
  id: "sparkx-i7",
  name: "Creality SPARKX i7",
  isPractice: undefined,
  isDefault: true,
  filamentsConfirmed: false,
  connection,
  ...extra,
})

describe("first printer: the practice printer (E2E #2 P1-a, NAV-01)", () => {
  it("a fresh install has no printers; the unsaved practice printer stands in as the default", () => {
    expect(machines.getMachines()).toEqual([])
    expect(machines.getDefaultMachine()).toMatchObject({ id: "practice-printer", isPractice: true, isDefault: true })
    expect(onboarding.placeholderMachine()).toBeUndefined()
  })

  it("choosing the practice printer saves it as the default; choosing it again is a no-op", async () => {
    const r = await onboarding.setupFirstMachine({ practice: true })
    expect(r).toMatchObject({ ok: true, practice: true, machineId: "practice-printer" })
    expect(machines.getMachines().map((m) => m.id)).toEqual(["practice-printer"])
    expect(machines.getDefaultMachine()).toMatchObject({ id: "practice-printer", isPractice: true })
    await onboarding.setupFirstMachine({ practice: true })
    expect(machines.getMachines().map((m) => m.id)).toEqual(["practice-printer"])
  })

  it("a real printer added later does not take over the default (UX round 2: the app asks)", () => {
    const real = machines.createMachine({ name: "Garage", model: "Creality SPARKX i7", connection: { type: "moonraker", host: "192.0.2.9", port: 7125 } })
    expect(real.isDefault).toBe(false)
    expect(machines.getDefaultMachine().id).toBe("practice-printer")
    machines.setDefaultMachine(real.id) // the user said Yes
    expect(machines.getDefaultMachine().id).toBe(real.id)
    machines.deleteMachine(real.id)
    expect(machines.getDefaultMachine().id).toBe("practice-printer")
  })

  it("an older install's placeholder (not set up, dev address) is dropped when the practice printer is chosen", async () => {
    config.writeMachinesFile([sparkx({ type: "moonraker", host: "127.0.0.1", port: 7125 })] as never)
    expect(onboarding.placeholderMachine()?.id).toBe("sparkx-i7")
    await onboarding.setupFirstMachine({ practice: true })
    expect(machines.getMachines().map((m) => m.id)).toEqual(["practice-printer"])
    expect(machines.getDefaultMachine().id).toBe("practice-printer")
  })

  it("a SPARKX with a real address stays (and stays the default) when the practice printer is added", async () => {
    config.writeMachinesFile([sparkx({ type: "moonraker", host: "192.0.2.24", port: 7125 })] as never)
    expect(onboarding.placeholderMachine()).toBeUndefined()
    await onboarding.setupFirstMachine({ practice: true })
    expect(machines.getMachines().map((m) => m.id).sort()).toEqual(["practice-printer", "sparkx-i7"])
    expect(machines.getDefaultMachine().id).toBe("sparkx-i7")
    expect(machines.getMachine("sparkx-i7").connection).toMatchObject({ host: "192.0.2.24" })
  })

  it("an install that finished setup is never touched, even at 127.0.0.1", async () => {
    config.writeMachinesFile([sparkx({ type: "moonraker", host: "127.0.0.1", port: 7125 })] as never)
    config.saveSettings({ onboardedAt: new Date().toISOString() })
    expect(onboarding.placeholderMachine()).toBeUndefined()
    await onboarding.setupFirstMachine({ practice: true })
    expect(machines.getDefaultMachine().id).toBe("sparkx-i7")
    expect(machines.getMachines()).toHaveLength(2)
  })
})
