import { existsSync } from "node:fs"
import Fastify from "fastify"
import websocket from "@fastify/websocket"
import fastifyStatic from "@fastify/static"
import { eventLog, onEvent } from "./events"
import { buildSnapshot } from "./sync"
import { shutdownAgents } from "./agent/index"
import settingsRoutes from "./routes/settings"
import projectsRoutes from "./routes/projects"
import agentRoutes from "./routes/agent"
import agentProfileRoutes from "./routes/agent-profiles"
import { migrateProfiles } from "./agent/profiles"
import printerRoutes from "./routes/printer"
import catalogRoutes from "./routes/catalog"
import machinesRoutes from "./routes/machines"
import assemblyRoutes from "./routes/assembly"
import onboardingRoutes from "./routes/onboarding"
import secretsRoutes from "./routes/secrets"
import outcomeRoutes from "./routes/outcomes"
import packRoutes from "./routes/pack"
import importRoutes from "./routes/imports"
import fileRoutes from "./routes/files"
import { setAppVersion, setPdfRenderer } from "./pack/index"
import { setTrashHandler } from "./projects/manage"
import { configureSecretStore, migrateLegacySecrets, redactSecrets, type SecretCipher } from "./secrets"

export interface StartServerOptions {
  port?: number // 0 = random free port (Electron)
  host?: string
  /** If set, every /api and /ws request must carry it (x-printstudio-token header, ps_token cookie, or ?token=). */
  token?: string
  /** If set, serve the built renderer (vite build output) from this folder, with SPA fallback. */
  staticDir?: string
  /** OS-backed encryption for the secret store (Electron safeStorage). Without it secrets use the dev fallback
   *  (unencrypted 0600 file; see server/secrets.ts). */
  secretCipher?: SecretCipher | null
  /** Renders an HTML page to PDF (Electron printToPDF), used for the build pack guide. Without it packs carry HTML only. */
  htmlToPdf?: ((html: string) => Promise<Buffer>) | null
  /** Moves a project folder to the OS Trash (Electron shell.trashItem). Without it, "delete" moves projects into
   *  <STUDIO_HOME>/.trash/ (server/projects/manage.ts). */
  trashItem?: ((absPath: string) => Promise<void>) | null
  /** The app version recorded in build packs (Electron: app.getVersion()). */
  appVersion?: string
| null
}

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i

/**
 * Dev mode (no token): only loopback pages may call /api and /ws. Blocks other websites' cross-site requests (incl.
 * bodiless/simple POSTs and WebSocket upgrades, which always carry Origin) and DNS rebinding (Host must be loopback).
 * Non-browser clients (curl, tests, tools) send no Origin and pass.
 */
export function devRequestAllowed(headers: Record<string, string | string[] | undefined>): boolean {
  const host = headers.host
  if (typeof host === "string" && !LOOPBACK_HOST.test(host)) return false
  const origin = headers.origin
  if (origin === undefined) return headers["sec-fetch-site"] !== "cross-site"
  if (typeof origin !== "string" || origin === "null") return false
  try {
    return LOOPBACK_HOST.test(new URL(origin).host)
  } catch {
    return false
  }
}

function tokenOf(req: { headers: Record<string, string | string[] | undefined>; url: string }): string | null {
  const h = req.headers["x-printstudio-token"]
  if (typeof h === "string") return h
  const cookie = typeof req.headers.cookie === "string" ? req.headers.cookie : ""
  const m = cookie.match(/(?:^|;\s*)ps_token=([^;]+)/)
  if (m) return decodeURIComponent(m[1])
  const q = req.url.indexOf("?")
  return q >= 0 ? new URLSearchParams(req.url.slice(q + 1)).get("token") : null
}

export async function startServer(opts: StartServerOptions = {}) {
  configureSecretStore({ cipher: opts.secretCipher ?? null })
  setPdfRenderer(opts.htmlToPdf ?? null)
  setTrashHandler(opts.trashItem ?? null)
  if (opts.appVersion) setAppVersion(opts.appVersion)
  const migration = migrateLegacySecrets() // refs only, never values
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.cookie", 'req.headers["x-printstudio-token"]', 'req.headers["x-api-key"]', "req.headers.authorization"],
    },
    bodyLimit: 50 * 1024 * 1024,
  })
  if (migration.migrated.length || migration.upgraded.length) app.log.info({ secrets: migration }, "secrets moved into the secret store")
  if (migration.failed.length) app.log.warn({ secrets: migration }, "some secrets could not be moved into the secret store; retrying next start")
  // R11b: settings.model + the Anthropic key ref -> the default "Claude" agent profile (verified read-back; no key).
  const profiles = migrateProfiles()
  if (profiles.migrated) app.log.info("agent settings moved into the default Claude profile")
  if (!profiles.verified) app.log.warn({ error: profiles.error }, "agent profile migration not verified; using settings until the next start")
  if (!opts.secretCipher) app.log.warn("secret store: no OS encryption (not running in the desktop app); keys are kept in a 0600 file")
  await app.register(websocket)

  if (opts.token) {
    const token = opts.token
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return
      if (tokenOf(req) !== token) return reply.status(401).send({ error: "unauthorized" })
    })
  } else {
    const loopbackOnly = LOOPBACK_HOST.test(opts.host ?? "127.0.0.1")
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api") && !req.url.startsWith("/ws")) return
      // bound to a LAN address on purpose: skip the Host check, keep the Origin check
      const headers = loopbackOnly ? req.headers : { ...req.headers, host: undefined }
      if (!devRequestAllowed(headers)) return reply.status(403).send({ error: "forbidden origin" })
    })
  }

  app.get("/api/health", async () => ({ ok: true }))
  // R08: /ws?since=<last eventSeq>&instance=<instanceId>. First frame is ws.hello; on "replay" the missed events
  // follow in order, then live ones. Replay + subscribe happen synchronously, so no event can fall in between.
  app.get<{ Querystring: { since?: string; instance?: string } }>("/ws", { websocket: true }, (socket, req) => {
    const since = req.query.since != null && req.query.since !== "" ? Number(req.query.since) : null
    const { hello, events } = eventLog.resume(since, req.query.instance ?? null)
    socket.send(JSON.stringify(hello))
    for (const json of events) socket.send(json)
    const off = onEvent((_e, json) => socket.send(json))
    // liveness: lets a client notice a socket that died silently (laptop sleep, network change)
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify({ type: "ws.ping", eventSeq: eventLog.lastSeq, instanceId: eventLog.instanceId }))
    }, 15_000)
    ping.unref()
    socket.on("close", () => {
      clearInterval(ping)
      off()
    })
  })
  app.get<{ Querystring: { projectId?: string } }>("/api/sync/snapshot", async (req) => buildSnapshot(req.query.projectId || null))

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const message = redactSecrets(err.message ?? "")
    app.log.error({ err: { type: err.name, message, stack: redactSecrets(err.stack ?? "") } })
    reply.status(err.statusCode ?? 500).send({ error: message })
  })

  await app.register(settingsRoutes)
  await app.register(projectsRoutes)
  await app.register(agentRoutes)
  await app.register(agentProfileRoutes)
  await app.register(printerRoutes)
  await app.register(catalogRoutes)
  await app.register(machinesRoutes)
  await app.register(assemblyRoutes)
  await app.register(onboardingRoutes)
  await app.register(secretsRoutes)
  await app.register(outcomeRoutes)
  await app.register(packRoutes)
  await app.register(importRoutes)
  await app.register(fileRoutes)

  if (opts.staticDir) {
    if (!existsSync(opts.staticDir)) app.log.warn(`renderer build not found at ${opts.staticDir} (run vite build)`)
    await app.register(fastifyStatic, { root: opts.staticDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) return reply.sendFile("index.html")
      return reply.status(404).send({ error: "not found" })
    })
  }

  // Close agent sessions (and kill their CLI processes) when the server closes.
  app.addHook("onClose", async () => shutdownAgents())

  // Dev (browser): fixed port 5174 behind the Vite proxy, no token. Electron: port 0 + per-launch token.
  const address = await app.listen({ port: opts.port ?? Number(process.env.PORT ?? 5174), host: opts.host ?? "127.0.0.1" })
  return { app, address }
}

/**
 * Kill agent CLI processes on every way out of a standalone server: signals (Ctrl-C, tsx watch restarts), fatal
 * errors, and the end of the event loop. Hard kills (SIGKILL) are covered by the per-session watchdog in
 * server/agent/spawn.ts. Electron installs its own (electron/main.ts).
 */
export function installShutdownHandlers() {
  let done = false
  const shutdown = (code: number) => {
    if (!done) {
      done = true
      try {
        shutdownAgents()
      } catch (e) {
        console.error("[server] agent shutdown failed", e)
      }
    }
    process.exit(code)
  }
  process.once("SIGINT", () => shutdown(130))
  process.once("SIGTERM", () => shutdown(143))
  process.once("SIGHUP", () => shutdown(129))
  process.once("beforeExit", () => shutdownAgents())
  process.on("uncaughtException", (e) => {
    console.error("[server] uncaught exception", e)
    shutdown(1)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installShutdownHandlers()
  startServer().catch((e) => {
    console.error(e)
    shutdownAgents()
    process.exit(1)
  })
}
