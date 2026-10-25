// Secret store: API keys and other credentials, kept out of settings.json / machines.json and out of every API
// response. Refs name secrets ("anthropic.apiKey", "machine.<id>.apiKey"); values only leave this module through
// getSecret() for the code that actually needs them (agent spawn env, Moonraker X-Api-Key header).
//
// Storage: <STUDIO_HOME>/secrets.json, mode 0600, {version, entries: {[ref]: {kind, data, last4, updatedAt}}}.
//  - kind "os": data = base64 of a blob encrypted by the configured cipher. In the desktop app that is Electron
//    safeStorage (macOS: key held in the Keychain), passed in by electron/main.ts via startServer({secretCipher}).
//  - kind "plain": data = the value itself. Only when no cipher is available: the standalone/browser-dev server
//    (`npm run dev`). Clearly labelled (source "file") in Settings; the desktop app upgrades such entries to "os"
//    on its next start (migrateLegacySecrets).
// `last4` is kept beside the value so status can be shown without decrypting (and for "os" entries the dev server
// can't decrypt). Values shorter than 12 characters get no last4.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SecretRef, SecretSource, SecretStatus, SecretStoreInfo } from "../shared/types"
import { MACHINES_FILE, SETTINGS_FILE, STUDIO_HOME } from "./config"

export interface SecretCipher {
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

interface Entry {
  kind: "os" | "plain"
  data: string
  last4?: string
  updatedAt: string
}
interface StoreFile {
  version: 1
  entries: Record<string, Entry>
}

let cipher: SecretCipher | null = null
const storeFile = () => join(STUDIO_HOME, "secrets.json")

/** Called once at startup (startServer). With a cipher, new values are encrypted ("os-keychain"). */
export function configureSecretStore(opts: { cipher?: SecretCipher | null }) {
  cipher = opts.cipher ?? null
  plainCache.clear()
}

export function secretStoreInfo(): SecretStoreInfo {
  return cipher
    ? { backend: "os-keychain", encrypted: true, note: "Encrypted with your computer's keychain." }
    : {
        backend: "file",
        encrypted: false,
        note: "Dev server without the desktop app: keys are stored unencrypted in secrets.json (readable only by your user). The desktop app encrypts them on its next start.",
      }
}

// ---- refs ----

const MACHINE_REF = /^machine\.([a-zA-Z0-9_-]{1,80})\.apiKey$/
export const ANTHROPIC_API_KEY_REF = "anthropic.apiKey"
export const machineSecretRef = (machineId: string) => `machine.${machineId}.apiKey`
/** R11b: an agent profile's own API key (profiles created in the Agents screen). */
const PROFILE_REF = /^profile\.([a-zA-Z0-9_-]{1,80})\.apiKey$/
export const profileSecretRef = (profileId: string) => `profile.${profileId}.apiKey`
export const isProfileSecretRef = (ref: string) => PROFILE_REF.test(ref)

/** Refs the API accepts. Future providers add theirs here ("openai.apiKey", ...). */
export function isKnownSecretRef(ref: string): boolean {
  return ref === ANTHROPIC_API_KEY_REF || MACHINE_REF.test(ref) || PROFILE_REF.test(ref)
}
export function machineIdOfRef(ref: string): string | null {
  return MACHINE_REF.exec(ref)?.[1] ?? null
}

// ---- file ----

let fileCache: { mtimeMs: number; store: StoreFile } | null = null
const plainCache = new Map<string, string>() // decrypted "os" values, keyed by ref + data

function readStore(): StoreFile {
  const f = storeFile()
  if (!existsSync(f)) return { version: 1, entries: {} }
  const mtimeMs = statSync(f).mtimeMs
  if (fileCache && fileCache.mtimeMs === mtimeMs) return structuredClone(fileCache.store)
  let store: StoreFile = { version: 1, entries: {} }
  try {
    const j = JSON.parse(readFileSync(f, "utf8"))
    if (j && typeof j.entries === "object") store = { version: 1, entries: j.entries }
  } catch {
    console.error("[secrets] secrets.json is unreadable; treating it as empty") // never log the contents
  }
  fileCache = { mtimeMs, store }
  return structuredClone(store)
}

function writeStore(store: StoreFile) {
  const f = storeFile()
  const tmp = f + ".tmp"
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 })
  chmodSync(tmp, 0o600) // mode is ignored when the tmp file already existed
  renameSync(tmp, f)
  fileCache = null
}

function decode(ref: string, e: Entry): string | null {
  if (e.kind === "plain") return e.data
  if (!cipher) return null // encrypted by the desktop app; not readable here
  const k = ref + "\0" + e.data
  const hit = plainCache.get(k)
  if (hit !== undefined) return hit
  try {
    const v = cipher.decrypt(Buffer.from(e.data, "base64"))
    plainCache.set(k, v)
    return v
  } catch {
    console.error(`[secrets] could not decrypt ${ref}`)
    return null
  }
}

export function maskLast4(value: string): string | undefined {
  return value.length >= 12 ? "…" + value.slice(-4) : undefined
}

function validate(value: string): string {
  const v = String(value ?? "").trim()
  if (!v) throw Object.assign(new Error("value is empty"), { statusCode: 400 })
  if (v.length > 4096) throw Object.assign(new Error("value is too long"), { statusCode: 400 })
  if (/[\r\n\0]/.test(v)) throw Object.assign(new Error("value must be one line"), { statusCode: 400 })
  return v
}

// ---- API ----

/** The value, or null when not set (or stored encrypted by the desktop app and not readable here). */
export function getSecret(ref: SecretRef): string | null {
  const e = readStore().entries[ref]
  return e ? decode(ref, e) : null
}

/** Store (replace) a value, then read it back from disk; throws if it doesn't match. */
export function setSecret(ref: SecretRef, value: string): SecretStatus {
  const v = validate(value)
  const store = readStore()
  const entry: Entry = cipher
    ? { kind: "os", data: cipher.encrypt(v).toString("base64"), updatedAt: new Date().toISOString() }
    : { kind: "plain", data: v, updatedAt: new Date().toISOString() }
  const last4 = maskLast4(v)
  if (last4) entry.last4 = last4
  store.entries[ref] = entry
  writeStore(store)
  plainCache.clear()
  if (getSecret(ref) !== v) throw new Error(`secret store write could not be verified for ${ref}`)
  return secretStatus(ref)
}

export function deleteSecret(ref: SecretRef): SecretStatus {
  const store = readStore()
  if (store.entries[ref]) {
    delete store.entries[ref]
    writeStore(store)
    plainCache.clear()
  }
  return secretStatus(ref)
}

/** Masked status. Never includes the value. */
export function secretStatus(ref: SecretRef): SecretStatus {
  const e = readStore().entries[ref]
  if (e) {
    const source: SecretSource = e.kind === "os" ? "os-keychain" : "file"
    const st: SecretStatus = { set: true, source, updatedAt: e.updatedAt }
    if (e.last4) st.last4 = e.last4
    if (e.kind === "os" && !cipher) st.locked = true
    return st
  }
  if (ref === ANTHROPIC_API_KEY_REF && process.env.ANTHROPIC_API_KEY) {
    return { set: true, source: "env", last4: maskLast4(process.env.ANTHROPIC_API_KEY) }
  }
  return { set: false, source: null }
}

export function listSecretStatus(): Record<SecretRef, SecretStatus> {
  const out: Record<string, SecretStatus> = { [ANTHROPIC_API_KEY_REF]: secretStatus(ANTHROPIC_API_KEY_REF) }
  for (const ref of Object.keys(readStore().entries)) out[ref] = secretStatus(ref)
  return out
}

/** The Anthropic API key the agent should use: the stored one, else ANTHROPIC_API_KEY from the environment. */
export function anthropicApiKey(): string | null {
  return getSecret(ANTHROPIC_API_KEY_REF) ?? (process.env.ANTHROPIC_API_KEY || null)
}

// ---- redaction ----

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys (api03, admin, oat...)
]
export const REDACTED = "[redacted]"

/** Every secret value this process knows (readable store entries + env keys), longest first. */
function knownValues(): string[] {
  const vals = new Set<string>()
  const entries = readStore().entries
  for (const ref of Object.keys(entries)) {
    const v = decode(ref, entries[ref])
    if (v && v.length >= 6) vals.add(v)
  }
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length >= 6) vals.add(process.env.ANTHROPIC_API_KEY)
  return [...vals].sort((a, b) => b.length - a.length)
}

/** Replace any known secret value or API-key-looking token in `text` with "[redacted]". */
export function redactSecrets(text: string, extra: string[] = []): string {
  if (!text) return text
  let out = text
  for (const v of [...extra.filter((x) => x && x.length >= 6), ...knownValues()]) {
    if (out.includes(v)) out = out.split(v).join(REDACTED)
  }
  for (const re of PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/** Redact a JSON-serialisable value (returns the same object when nothing needed redacting). */
export function redactDeep<T>(value: T): T {
  const json = JSON.stringify(value)
  if (json === undefined) return value
  const red = redactSecrets(json)
  return red === json ? value : (JSON.parse(red) as T)
}

// ---- migration ----

export interface SecretMigrationReport {
  migrated: SecretRef[] // moved out of settings.json / machines.json
  upgraded: SecretRef[] // plain (dev fallback) entries re-encrypted with the OS keychain
  failed: SecretRef[] // left where they were; retried on the next start
}

function atomicWriteJson(file: string, value: unknown) {
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, file)
}

/** Store `value` under `ref` unless the store already has one; true when the store now holds a usable/locked value. */
function moveIn(ref: string, value: string, report: SecretMigrationReport): boolean {
  try {
    const cur = secretStatus(ref)
    if (cur.set && cur.source !== "env") return true // the store wins; the legacy copy is stale
    setSecret(ref, value) // verifies by reading back
    report.migrated.push(ref)
    return true
  } catch (e) {
    report.failed.push(ref)
    console.error(`[secrets] could not migrate ${ref}: ${redactSecrets((e as Error).message, [value])}`)
    return false
  }
}

/**
 * Startup migration (idempotent):
 *  1. settings.json `anthropicApiKey` -> "anthropic.apiKey";
 *  2. machines.json `connection.apiKey` -> "machine.<id>.apiKey";
 *  3. with a cipher, "plain" entries (dev fallback) are re-encrypted.
 * The plaintext is removed from the JSON only after the store write is verified.
 */
export function migrateLegacySecrets(): SecretMigrationReport {
  const report: SecretMigrationReport = { migrated: [], upgraded: [], failed: [] }

  if (existsSync(SETTINGS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"))
      if (raw && typeof raw === "object" && "anthropicApiKey" in raw) {
        const v = typeof raw.anthropicApiKey === "string" ? raw.anthropicApiKey.trim() : ""
        if (!v || moveIn(ANTHROPIC_API_KEY_REF, v, report)) {
          delete raw.anthropicApiKey
          atomicWriteJson(SETTINGS_FILE, raw)
        }
      }
    } catch {
      console.error("[secrets] settings.json migration skipped (unreadable)")
    }
  }

  if (existsSync(MACHINES_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(MACHINES_FILE, "utf8"))
      const list: { id?: string; connection?: { apiKey?: unknown } }[] = Array.isArray(raw) ? raw : Array.isArray(raw?.machines) ? raw.machines : []
      let changed = false
      for (const m of list) {
        if (!m?.connection || !("apiKey" in m.connection) || !m.id) continue
        const v = typeof m.connection.apiKey === "string" ? m.connection.apiKey.trim() : ""
        if (!v || moveIn(machineSecretRef(m.id), v, report)) {
          delete m.connection.apiKey
          changed = true
        }
      }
      if (changed) atomicWriteJson(MACHINES_FILE, Array.isArray(raw) ? { version: 1, machines: list } : raw)
    } catch {
      console.error("[secrets] machines.json migration skipped (unreadable)")
    }
  }

  if (cipher) {
    const store = readStore()
    for (const [ref, e] of Object.entries(store.entries)) {
      if (e.kind !== "plain") continue
      try {
        setSecret(ref, e.data)
        report.upgraded.push(ref)
      } catch {
        report.failed.push(ref)
        console.error(`[secrets] could not encrypt ${ref}; left in the fallback file`)
      }
    }
  }
  return report
}
