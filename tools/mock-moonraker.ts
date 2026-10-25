// OWNER: slicer/printer agent. Fake Moonraker for development (default 127.0.0.1:7125).
//   MOCK_PORT=7135 MOCK_PRINT_SECONDS=20 npx tsx tools/mock-moonraker.ts
// Klipper shutdown (like the SPARKX i7's "Exception in flush_handler"): curl -X POST localhost:7125/debug/shutdown
//   then the app's "Restart printer" (Moonraker POST /printer/firmware_restart) brings it back.
// The simulation itself lives in server/printer/sim.ts (shared with the in-app Practice printer).
import { createSimPrinter } from "../server/printer/sim"

const PORT = Number(process.env.MOCK_PORT ?? process.env.MOCK_MOONRAKER_PORT ?? 7125)
const HOST = process.env.MOCK_MOONRAKER_HOST ?? "127.0.0.1"
const { app, gcodesDir } = await createSimPrinter({
  printSeconds: Number(process.env.MOCK_PRINT_SECONDS ?? 60),
  hostname: process.env.MOCK_HOSTNAME ?? "mock-moonraker",
  log: (m) => console.log(m),
  // MOCK_CFS="none,000000:001001,1743ED:001001,BE1C1C:001001" (slot 1 unset); MOCK_CFS=off for no CFS.
  cfs: process.env.MOCK_CFS === "off" ? null : process.env.MOCK_CFS,
  cancelAtStart: process.env.MOCK_CANCEL_AT_START === "1",
  // MOCK_CREALITY=1: Creality firmware behaviour (frozen print_stats); MOCK_CREALITY_WS_PORT=9999-like push API.
  creality: process.env.MOCK_CREALITY === "1",
  crealityWsPort: process.env.MOCK_CREALITY_WS_PORT ? Number(process.env.MOCK_CREALITY_WS_PORT) : undefined,
})
await app.listen({ port: PORT, host: HOST })
console.log(`[mock] moonraker listening on http://${HOST}:${PORT} (files in ${gcodesDir})`)
