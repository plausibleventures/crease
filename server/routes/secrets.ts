import type { FastifyInstance } from "fastify"
import { getMachines } from "../machines"
import { ANTHROPIC_API_KEY_REF, deleteSecret, isKnownSecretRef, listSecretStatus, machineIdOfRef, secretStoreInfo, setSecret } from "../secrets"
import { syncProfilesWithAnthropicKey } from "../agent/profiles"
import { emit } from "../events"

// OWNER: secrets (see shared/api.md "Secrets"). Responses carry masked status only, never values.
const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

function checkRef(ref: string) {
  if (!isKnownSecretRef(ref)) throw httpErr(400, `unknown secret: ${ref}`)
  const machineId = machineIdOfRef(ref)
  if (machineId && !getMachines().some((m) => m.id === machineId)) throw httpErr(404, `machine not found: ${machineId}`)
}

export default async function secretsRoutes(app: FastifyInstance) {
  app.get("/api/secrets", async () => ({ store: secretStoreInfo(), secrets: listSecretStatus() }))

  app.put<{ Params: { ref: string }; Body: { value?: unknown } | undefined }>("/api/secrets/:ref", async (req) => {
    checkRef(req.params.ref)
    const value = req.body?.value
    if (typeof value !== "string") throw httpErr(400, "body must be {value: string}")
    const st = setSecret(req.params.ref, value)
    // Older clients (Settings' key field): the Claude profile on this ref follows the key, as before profiles.
    if (req.params.ref === ANTHROPIC_API_KEY_REF && syncProfilesWithAnthropicKey(true)) emit({ type: "agent.profiles.changed" })
    return st
  })

  app.delete<{ Params: { ref: string } }>("/api/secrets/:ref", async (req) => {
    checkRef(req.params.ref)
    const st = deleteSecret(req.params.ref)
    if (req.params.ref === ANTHROPIC_API_KEY_REF && syncProfilesWithAnthropicKey(false)) emit({ type: "agent.profiles.changed" })
    return st
  })
}
