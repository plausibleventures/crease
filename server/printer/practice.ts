// The built-in "Practice printer": a simulated Moonraker (server/printer/sim.ts) served in-process on a
// random localhost port, so it works in the packaged app without the dev mock.
import { createSimPrinter } from "./sim"

let started: Promise<{ port: number; close: () => Promise<void> }> | null = null

/** Start (once) and return the practice printer's local port. */
export async function practicePort(): Promise<number> {
  started ??= (async () => {
    const { app } = await createSimPrinter({ printSeconds: Number(process.env.PRACTICE_PRINT_SECONDS ?? 60), hostname: "practice-printer (mock)" })
    await app.listen({ port: 0, host: "127.0.0.1" })
    const addr = app.server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    return { port, close: () => app.close() }
  })()
  return (await started).port
}

export async function stopPractice() {
  const s = started
  started = null
  if (s) await (await s).close()
}
