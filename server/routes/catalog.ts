import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { PrintRecord } from "../../shared/types"
import { getDb, getPrint, listCatalog, listPrints, listSessions, listTags, rebuildIndex, setPrintResult } from "../db"
import { installCatalogHooks } from "../db/hooks"
import { isPracticePrint } from "../printer/index"

// OWNER: slicer/printer agent (see shared/api.md "Catalog")
const CatalogQuery = z.object({
  q: z.string().optional(),
  tag: z.string().optional(),
  sort: z.enum(["updated", "created", "name", "printed"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
})
const PrintPatch = z.object({
  result: z.enum(["success", "failed"]).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
})

const httpErr = (statusCode: number, msg: string) => Object.assign(new Error(msg), { statusCode })

/** A print on the built-in practice printer is marked, so the app labels it "Practice" and never asks to rate it. */
const withPractice = (p: PrintRecord): PrintRecord => (isPracticePrint(p) ? { ...p, practice: true } : p)

export default async function catalogRoutes(app: FastifyInstance) {
  installCatalogHooks()
  getDb() // open + migrate; rebuilds from the folders if index.sqlite is missing/empty

  app.get("/api/catalog", async (req) => {
    const q = CatalogQuery.safeParse(req.query)
    if (!q.success) throw httpErr(400, "invalid query: q?, tag?, sort=updated|created|name|printed, limit?")
    // practice prints say so in the Library ("Practice", never "Printed")
    return listCatalog({ query: q.data.q, tag: q.data.tag, sort: q.data.sort, limit: q.data.limit }).map((p) => {
      const rec = p.lastPrint ? getPrint(p.lastPrint.id) : null
      return rec && isPracticePrint(rec) ? { ...p, lastPrint: { ...p.lastPrint!, practice: true } } : p
    })
  })
  app.get("/api/catalog/tags", async () => listTags())
  app.post("/api/catalog/rebuild", async () => rebuildIndex())

  app.get<{ Params: { id: string } }>("/api/projects/:id/sessions", async (req) => listSessions(req.params.id))

  app.get<{ Querystring: { projectId?: string; machineId?: string } }>("/api/prints", async (req) =>
    listPrints(req.query.projectId || undefined, 200, req.query.machineId || undefined).map(withPractice),
  )
  app.get<{ Params: { printId: string } }>("/api/prints/:printId", async (req) => {
    const p = getPrint(req.params.printId)
    if (!p) throw httpErr(404, "print not found")
    return withPractice(p)
  })
  app.post<{ Params: { printId: string } }>("/api/prints/:printId", async (req) => {
    const body = PrintPatch.safeParse(req.body)
    if (!body.success) throw httpErr(400, 'body must be {result?: "success"|"failed"|null, notes?: string|null}')
    const p = setPrintResult(req.params.printId, body.data)
    if (!p) throw httpErr(404, "print not found")
    return p
  })
}
