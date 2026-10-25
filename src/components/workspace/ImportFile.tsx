// R23: bring an STL, 3MF or SCAD file into the project (drag-drop or "Import file"). The server inspects it first;
// this dialog asks only what it must, each with a recommended answer: what size it is (mm vs inch, when the file
// can't say) and where it's from (licence/source; prefilled from a 3MF's own details).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { ImportInspection, ImportSource } from "@shared/types"
import { CheckIcon, CuboidIcon, FileCode2Icon, InfoIcon, Loader2Icon, StarIcon, TriangleAlertIcon, UploadIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { api, errMsg } from "@/lib/api"
import { fmtNum } from "@/lib/format"
import { useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"

export const IMPORT_ACCEPT = ".stl,.3mf,.scad"
const IMPORT_EVENT = "ps:import-file"
/** Open the file picker of the workspace's import (Sidebar, project menu). */
export const requestImport = () => window.dispatchEvent(new Event(IMPORT_EVENT))
export const isImportable = (name: string) => /\.(stl|3mf|scad)$/i.test(name)

const LICENCES = ["Not sure", "CC BY 4.0", "CC BY-SA 4.0", "CC BY-NC 4.0", "CC BY-NC-SA 4.0", "CC0 1.0", "GPL-3.0-or-later", "Personal use only", "All rights reserved"]
const LICENCE_HINT: Record<string, string> = {
  "Not sure": "Fine for printing at home. Check before sharing or selling prints.",
  "CC BY 4.0": "Share and remix with credit, even for money.",
  "CC BY-SA 4.0": "Share and remix with credit; remixes use the same licence.",
  "CC BY-NC 4.0": "Share and remix with credit, but don't sell prints of it.",
  "CC BY-NC-SA 4.0": "Credit, no selling, same licence for remixes.",
  "CC0 1.0": "Anyone can do anything with it.",
  "GPL-3.0-or-later": "Changed versions must be shared under the GPL too.",
  "Personal use only": "Print it for yourself; don't share or sell it.",
  "All rights reserved": "Print it for yourself; don't share or sell it.",
}

type Where = ImportSource["kind"]
const WHERE: { kind: Where; label: string; description: string }[] = [
  { kind: "web", label: "Downloaded from a website", description: "Printables, Thingiverse, MakerWorld…" },
  { kind: "self", label: "I made it", description: "My own design" },
  { kind: "person", label: "Someone gave it to me", description: "A friend, a teacher, a shop…" },
  { kind: "unknown", label: "I'm not sure", description: "That's OK, it's noted as unknown" },
]

const mm = (s: [number, number, number] | undefined) => (s ? `${s.map((v) => fmtNum(v)).join(" × ")} mm` : "")
const inches = (s: [number, number, number] | undefined) => (s ? `${s.map((v) => (v / 25.4).toFixed(1)).join(" × ")} in` : "")

function Choice({ on, rec, label, description, onClick }: { on: boolean; rec?: boolean; label: ReactNode; description?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "flex min-h-10 w-full items-start gap-2.5 border px-2.5 py-1.5 text-left transition-colors outline-none",
        "hover:border-primary/60 hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50",
        on ? "border-primary bg-primary/10" : "border-border bg-background/60",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center border", on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60")}>
        {on && <CheckIcon className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
          {label}
          {rec && (
            <span className="inline-flex h-4 items-center gap-1 rounded-sm bg-primary/15 px-1.5 text-micro text-primary">
              <StarIcon className="size-2.5 fill-current" /> Recommended
            </span>
          )}
        </span>
        {description && <span className="text-xs leading-snug text-muted-foreground">{description}</span>}
      </span>
    </button>
  )
}

/** The label every imported part carries: what you can and can't do with it. */
export function ImportKindNote({ kind, className }: { kind: "mesh" | "scad"; className?: string }) {
  return kind === "mesh" ? (
    <div className={cn("flex items-start gap-2 border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-xs text-foreground", className)}>
      <CuboidIcon className="mt-0.5 size-3.5 shrink-0 text-warn" />
      <span>
        <b className="font-medium">Mesh</b> — can be scaled, rotated and placed, but not reshaped by parameters.
      </span>
    </div>
  ) : (
    <div className={cn("flex items-start gap-2 border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs text-foreground", className)}>
      <FileCode2Icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
      <span>
        <b className="font-medium">OpenSCAD design</b> — editable like your own parts; its settings show up under Parameters.
      </span>
    </div>
  )
}

function ImportDialog({ projectId, ins, onClose }: { projectId: string; ins: ImportInspection; onClose: () => void }) {
  const fromFile = ins.metadata.licence
  const [units, setUnits] = useState<"mm" | "inch">(ins.units.known ?? ins.units.recommended)
  const [where, setWhere] = useState<Where | null>(fromFile || ins.metadata.source ? "web" : null)
  const [url, setUrl] = useState(ins.metadata.source ?? "")
  const [author, setAuthor] = useState(ins.metadata.designer ?? "")
  const [licence, setLicence] = useState(fromFile ?? "Not sure")
  const [name, setName] = useState(ins.suggestedId)
  const [busy, setBusy] = useState(false)
  const refreshProject = useStudio((s) => s.refreshProject)
  const selectPart = useStudio((s) => s.selectPart)
  const setCenterTab = useStudio((s) => s.setCenterTab)
  const licences = fromFile && !LICENCES.includes(fromFile) ? [fromFile, ...LICENCES] : LICENCES
  const size = ins.kind === "mesh" ? (units === "inch" ? ins.sizeIfInch : ins.sizeIfMm) : undefined
  const ready = where !== null && !busy && /^[a-z0-9][a-z0-9-]*$/i.test(name.trim() || ins.suggestedId)

  const add = async () => {
    if (!where) return
    setBusy(true)
    try {
      const r = await api.commitImport(projectId, {
        token: ins.token,
        id: name.trim() || undefined,
        units: ins.kind === "mesh" && !ins.units.known ? units : undefined,
        source: { kind: where, ...(where === "web" && url.trim() ? { url: url.trim() } : {}), ...(where !== "self" && author.trim() ? { author: author.trim() } : {}) },
        licence: where === "self" ? "I made it" : where === "unknown" && licence === "Not sure" ? "Unknown" : licence,
      })
      await refreshProject()
      selectPart(r.part.id)
      setCenterTab("model")
      toast.success(`Added ${r.part.id}`, { description: "Rendering it and running the checks…" })
      onClose()
    } catch (e) {
      toast.error("Couldn't import it", { description: errMsg(e), duration: 12000 })
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadIcon className="size-4 text-primary" /> Add “{ins.fileName}”
          </DialogTitle>
          <DialogDescription>
            {ins.kind === "mesh"
              ? `${ins.format.toUpperCase()} mesh · ${ins.triangles?.toLocaleString()} triangles${size ? ` · ${mm(size)} (${inches(size)})` : ""}`
              : `OpenSCAD file${ins.libraries.length ? ` · uses ${ins.libraries.join(", ")}` : ""}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 text-xs">
          <ImportKindNote kind={ins.kind} />

          {ins.kind === "mesh" && ins.units.ask && (
            <fieldset className="flex flex-col gap-1.5" role="radiogroup">
              <legend className="mb-1 text-sm font-medium text-foreground">What size is it?</legend>
              <p className="-mt-0.5 mb-0.5 text-muted-foreground">{ins.units.why}</p>
              {(ins.units.recommended === "inch" ? (["inch", "mm"] as const) : (["mm", "inch"] as const)).map((u) => (
                <Choice
                  key={u}
                  on={units === u}
                  rec={u === ins.units.recommended}
                  onClick={() => setUnits(u)}
                  label={u === "inch" ? "It was made in inches" : "It was made in millimetres"}
                  description={u === "inch" ? `${inches(ins.sizeIfInch)} (${mm(ins.sizeIfInch)})` : `${mm(ins.sizeIfMm)}: tiny, smaller than a fingernail`}
                />
              ))}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-1.5" role="radiogroup">
            <legend className="mb-1 text-sm font-medium text-foreground">Where's it from?</legend>
            {fromFile && (
              <p className="-mt-0.5 mb-0.5 text-muted-foreground">
                The file says: licence {fromFile}
                {ins.metadata.designer ? `, by ${ins.metadata.designer}` : ""}
                {ins.metadata.title ? ` (“${ins.metadata.title}”)` : ""}.
              </p>
            )}
            {WHERE.map((w, i) => (
              <Choice key={w.kind} on={where === w.kind} rec={i === 0} onClick={() => setWhere(w.kind)} label={w.label} description={w.description} />
            ))}
          </fieldset>

          {(where === "web" || where === "person") && (
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
              {where === "web" && (
                <>
                  <Label htmlFor="imp-url">Link</Label>
                  <Input id="imp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.printables.com/model/…  (optional)" />
                </>
              )}
              <Label htmlFor="imp-author">{where === "web" ? "Made by" : "From"}</Label>
              <Input id="imp-author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={where === "web" ? "The designer's name (optional)" : "Who gave it to you (optional)"} />
              <Label htmlFor="imp-licence">Licence</Label>
              <div className="flex flex-col gap-1">
                <OptionSelect id="imp-licence" value={licence} onChange={setLicence} className="w-56" options={licences.map((l) => ({ value: l, label: l }))} />
                <span className="text-muted-foreground">{LICENCE_HINT[licence] ?? "As the file says."}</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3">
            <Label htmlFor="imp-name">Name</Label>
            <Input id="imp-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} className="font-mono" />
          </div>

          {ins.warnings.length > 0 && (
            <ul className="flex flex-col gap-1">
              {ins.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-muted-foreground">
                  {/not used|wasn't imported|won't/.test(w) ? <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-warn" /> : <InfoIcon className="mt-0.5 size-3 shrink-0 text-primary" />}
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void add()} disabled={!ready} title={where === null ? "Pick where it's from first" : undefined}>
            {busy ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} Add to project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The workspace's import: a hidden file input (opened by requestImport()), drag-and-drop handlers for the
 * workspace, and the dialog. One per workspace.
 */
export function useImportFile(projectId: string) {
  const input = useRef<HTMLInputElement | null>(null)
  const [ins, setIns] = useState<ImportInspection | null>(null)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const inspect = useCallback(
    async (file: File | undefined) => {
      if (!file) return
      if (!isImportable(file.name)) {
        toast.error(`Can't import ${file.name}`, { description: "Crease can import STL, 3MF and SCAD files." })
        return
      }
      const t = toast.loading(`Opening ${file.name}…`)
      try {
        const r = await api.inspectImport(projectId, file)
        toast.dismiss(t)
        setIns(r)
      } catch (e) {
        toast.error(`Couldn't open ${file.name}`, { id: t, description: errMsg(e), duration: 12000 })
      } finally {
        if (input.current) input.current.value = ""
      }
    },
    [projectId],
  )

  useEffect(() => {
    const open = () => input.current?.click()
    window.addEventListener(IMPORT_EVENT, open)
    return () => window.removeEventListener(IMPORT_EVENT, open)
  }, [])

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files")
  const dropHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      depth.current++
      setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setDragging(false)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = "copy"
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = [...e.dataTransfer.files]
      const f = files.find((x) => isImportable(x.name)) ?? files[0]
      if (files.length > 1) toast.info("One file at a time", { description: `Adding ${f?.name}; drop the others after.` })
      void inspect(f)
    },
  }

  const element = (
    <>
      <input ref={input} type="file" accept={IMPORT_ACCEPT} className="hidden" onChange={(e) => void inspect(e.target.files?.[0])} />
      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 border-2 border-dashed border-primary bg-background/90 px-10 py-8 text-center">
            <UploadIcon className="size-6 text-primary" />
            <div className="text-sm font-medium">Drop to add it to this project</div>
            <div className="text-xs text-muted-foreground">STL, 3MF or OpenSCAD (.scad)</div>
          </div>
        </div>
      )}
      {ins && <ImportDialog key={ins.token} projectId={projectId} ins={ins} onClose={() => setIns(null)} />}
    </>
  )
  return { pick: requestImport, inspect, dropHandlers, element }
}
