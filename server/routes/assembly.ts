import type { FastifyInstance } from "fastify"
import type { SourcingStoreInfo } from "../../shared/types"
import {
  buildAssemblyGuide,
  checkAssemblyMotion,
  getAssemblyInfo,
  getPartsBin,
  getProjectBom,
  renderAssemblyStep,
  setPartsBin,
  setProjectHave,
} from "../assembly/index"
import { DEFAULT_SOURCING, STORES } from "../assembly/stores"

// OWNER: assembly. See shared/api.md "Assembly guides".
export default async function assemblyRoutes(app: FastifyInstance) {
  // Store registry for the Settings "Buying hardware" section (search templates stay server-side).
  app.get("/api/sourcing/stores", async () => {
    const stores: SourcingStoreInfo[] = STORES.map(({ id, label, countries, suits, note, verified }) => ({
      id,
      label,
      countries,
      suits,
      note: note ?? null,
      verified,
    }))
    const countries = [...new Set(STORES.flatMap((s) => s.countries).filter((c) => c !== "*"))].sort()
    return { stores, countries, defaults: DEFAULT_SOURCING }
  })

  app.get<{ Params: { id: string } }>("/api/projects/:id/assembly", async (req) => getAssemblyInfo(req.params.id))

  app.post<{ Params: { id: string } }>("/api/projects/:id/assembly/guide", async (req) => {
    const r = await buildAssemblyGuide(req.params.id)
    return { guideUrl: r.url, steps: r.steps, art: r.art, ...(r.artNote ? { artNote: r.artNote } : {}) }
  })

  app.post<{ Params: { id: string } }>("/api/projects/:id/assembly/check-motion", async (req) => checkAssemblyMotion(req.params.id))

  app.post<{ Params: { id: string; n: string }; Body: { explode?: number; pose?: Record<string, number> } | undefined }>(
    "/api/projects/:id/assembly/steps/:n/render",
    async (req) => {
      const r = await renderAssemblyStep(req.params.id, Number(req.params.n), { explode: req.body?.explode, pose: req.body?.pose })
      return { n: r.n, url: r.url, cached: r.cached, ...(r.art ? { art: r.art } : {}), ...(r.artNote ? { artNote: r.artNote } : {}) }
    },
  )

  // Practical BOM (R17): categories, "I already have this", packs, substitutions, estimated cost of what's left to buy.
  app.get<{ Params: { id: string } }>("/api/projects/:id/bom", async (req) => getProjectBom(req.params.id))
  app.put<{ Params: { id: string }; Body: { key: string; have: boolean | null } }>("/api/projects/:id/bom/have", async (req) =>
    setProjectHave(req.params.id, req.body?.key, req.body?.have ?? null),
  )
  app.get("/api/parts-bin", async () => getPartsBin())
  app.put<{ Body: { key: string; name: string; inBin: boolean } }>("/api/parts-bin", async (req) =>
    setPartsBin(req.body?.key, req.body?.name, req.body?.inBin),
  )
}
