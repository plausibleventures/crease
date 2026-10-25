// Klipper shutdown (SPARKX i7, 2026-10-16): plain words, no firmware text, and a restart.
// Only a local simulated printer (server/printer/sim.ts) on a random port: never a real printer.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canRestartFirmware, FIRMWARE_SENTENCE, firmwareState, firstLine, plainMoonrakerError } from "./klippy"
import { createSimPrinter, SPARKX_SHUTDOWN } from "./sim"

const home = mkdtempSync(join(tmpdir(), "printstudio-klippy-test-"))
process.env.PRINTSTUDIO_HOME = home

// What Moonraker sent back for a cancel on the shut-down i7 (body.error.message).
const CANCEL_REPLY = `{'error': 'WebRequestError', 'message': '${SPARKX_SHUTDOWN}'}`

describe("firmware text", () => {
  it("maps Klipper's state", () => {
    expect(firmwareState("ready")).toBeNull()
    expect(firmwareState(undefined)).toBeNull()
    expect(firmwareState("shutdown")).toBe("shutdown")
    expect(firmwareState("startup")).toBe("startup")
    expect(firmwareState("error")).toBe("error")
    expect(firmwareState("weird")).toBe("error")
    expect(canRestartFirmware("shutdown")).toBe(true)
    expect(canRestartFirmware("error")).toBe(true)
    expect(canRestartFirmware("startup")).toBe(false)
    expect(canRestartFirmware(undefined)).toBe(false)
  })

  it("unwraps SparkX's {code, msg} to its first line, also inside Moonraker's Python repr", () => {
    expect(firstLine(SPARKX_SHUTDOWN)).toBe("Exception in flush_handler")
    expect(firstLine(CANCEL_REPLY)).toBe("Exception in flush_handler")
    expect(firstLine(JSON.stringify({ code: "key1", msg: "Must home axis first: 1.0 2.0\nmore" }))).toBe("Must home axis first: 1.0 2.0")
    expect(firstLine("Printer is ready")).toBe("Printer is ready")
    expect(firstLine("!! Move out of range")).toBe("Move out of range")
  })

  it("turns Moonraker errors into plain sentences, never JSON", () => {
    const shut = plainMoonrakerError("/printer/print/cancel", 400, CANCEL_REPLY)
    expect(shut.message).toBe(FIRMWARE_SENTENCE.shutdown)
    expect(shut.logLine).toBe("/printer/print/cancel -> 400: Exception in flush_handler")
    expect(plainMoonrakerError("/printer/print/cancel", 400, "No print in progress").message).toBe("The printer couldn't stop the print: no print in progress.")
    expect(plainMoonrakerError("/printer/print/start?filename=a.gcode", 404, "File a.gcode does not exist").message).toBe(
      "The printer couldn't start the print: file a.gcode does not exist.",
    )
    expect(plainMoonrakerError("/printer/print/pause", 401, "Unauthorized").message).toMatch(/API key/)
    const odd = plainMoonrakerError("/printer/print/pause", 500, `{"weird": {"nested": [1, 2]}}`)
    expect(odd.message).toBe("The printer couldn't pause the print.")
    expect(plainMoonrakerError("/server/files/upload", 500, "Traceback: KeyError {x}").message).toBe("The printer couldn't take the file.")
  })
})

describe("a printer that shut itself down", () => {
  let base = ""
  let close: () => Promise<void> = async () => {}
  let machineId = ""
  let printer: typeof import("./index")

  beforeAll(async () => {
    const sim = await createSimPrinter({ hostname: "sim-i7", restartSeconds: 0.3 })
    await sim.app.listen({ port: 0, host: "127.0.0.1" })
    const port = (sim.app.server.address() as { port: number }).port
    base = `http://127.0.0.1:${port}`
    close = () => sim.app.close()
    const machines = await import("../machines")
    printer = await import("./index")
    machineId = machines.createMachine({ name: "Sim i7", model: "Creality SPARKX i7", connection: { type: "moonraker", host: "127.0.0.1", port } }).id
  })
  afterAll(async () => {
    await close()
    rmSync(home, { recursive: true, force: true })
  })

  it("restart is refused while it runs fine", async () => {
    const st = await printer.getPrinterStatus(machineId)
    expect(st).toMatchObject({ connected: true, state: "standby" })
    expect(st.firmware).toBeUndefined()
    await expect(printer.restartFirmware(machineId)).rejects.toMatchObject({ statusCode: 409 })
  })

  it("reports shutdown in plain words, refuses print commands, and restarts", async () => {
    await fetch(`${base}/debug/shutdown`, { method: "POST" })
    const st = await printer.getPrinterStatus(machineId)
    expect(st).toMatchObject({ connected: true, state: "error", firmware: "shutdown", message: FIRMWARE_SENTENCE.shutdown })
    expect(JSON.stringify(st)).not.toMatch(/flush_handler|key1|FIRMWARE_RESTART/)

    // No cancel / pause is sent to a shut-down printer.
    for (const fn of [printer.cancelPrint, printer.pausePrint, printer.resumePrint]) {
      const err = await fn(machineId).catch((e: Error & { statusCode?: number }) => e)
      expect(err).toMatchObject({ statusCode: 409, message: FIRMWARE_SENTENCE.shutdown })
    }

    await expect(printer.restartFirmware(machineId)).resolves.toEqual({ ok: true })
    expect((await printer.getPrinterStatus(machineId)).firmware).toBe("startup")
    await new Promise((r) => setTimeout(r, 500))
    const after = await printer.getPrinterStatus(machineId)
    expect(after).toMatchObject({ connected: true, state: "standby" })
    expect(after.firmware).toBeUndefined()
  })

  it("other Moonraker errors arrive as plain sentences", async () => {
    const err = (await printer.cancelPrint(machineId).catch((e: Error) => e)) as Error
    expect(err.message).toBe("The printer couldn't stop the print: no print in progress.")
  })
})
