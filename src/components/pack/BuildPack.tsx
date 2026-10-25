// Build packs (R16): export a project as one shareable .zip, and open such a zip as a new project.
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { LICENSES, type BuildPackImportResult, type BuildPackPreview } from "@shared/types"
import { CircleCheckIcon, DownloadIcon, Loader2Icon, PackageIcon, ShieldCheckIcon, TriangleAlertIcon, UploadIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"

const LICENSE_HINT: Record<string, string> = {
  "All rights reserved": "Others can build it for themselves, but not share or sell copies of the design.",
  "CC BY 4.0": "Anyone can share and remix it, even commercially, as long as they credit you.",
  "CC BY-SA 4.0": "Share and remix with credit; remixes must use the same licence.",
  "CC BY-NC 4.0": "Share and remix with credit, but not for money.",
  "CC BY-NC-SA 4.0": "Share and remix with credit, not for money, same licence for remixes.",
  "CC0 1.0": "No rights reserved: anyone can do anything with it.",
  MIT: "Permissive software-style licence: keep the notice, otherwise anything goes.",
  "GPL-3.0-or-later": "Copyleft: changed versions must be shared under the GPL too.",
}

const ROLE_LABEL: Record<string, [string, string]> = {
  source: ["design file", "design files"],
  guide: ["assembly guide", "assembly guide files"],
  bom: ["shopping list file", "shopping list files"],
  render: ["picture", "pictures"],
  model: ["STL model", "STL models"],
  gcode: ["G-code file", "G-code files"],
  notes: ["print notes file", "print notes files"],
  info: ["readme", "readmes"],
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function ExportPackDialog({ projectId, open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-xl">{open && <ExportBody projectId={projectId} onDone={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function ExportBody({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [license, setLicense] = useState<string | null>(null)
  const [description, setDescription] = useState<string | null>(null)
  const [includeGcode, setIncludeGcode] = useState(false)
  const [includeNotes, setIncludeNotes] = useState(false)
  const [preview, setPreview] = useState<BuildPackPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .packPreview(projectId, { license: license ?? undefined, includeGcode, includeNotes })
      .then((p) => {
        if (!alive) return
        setPreview(p)
        setLicense((l) => l ?? p.license)
        setDescription((d) => d ?? p.description ?? "")
      })
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [projectId, license, includeGcode, includeNotes])

  const exportNow = async () => {
    setBusy(true)
    try {
      const name = await api.exportPack(projectId, { license: license ?? undefined, description: description ?? undefined, includeGcode, includeNotes })
      toast.success(`Saved ${name}`, { description: "Share it as is: whoever opens it gets the design, guide and shopping list." })
      onDone()
    } catch (e) {
      toast.error(`Couldn't export: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const byRole = new Map<string, { n: number; bytes: number }>()
  for (const f of preview?.files ?? []) {
    const cur = byRole.get(f.role) ?? { n: 0, bytes: 0 }
    byRole.set(f.role, { n: cur.n + 1, bytes: cur.bytes + f.bytes })
  }
  const total = (preview?.files ?? []).reduce((n, f) => n + f.bytes, 0)
  const current = preview?.gcode.filter((g) => !g.stale.length) ?? []
  const stale = preview?.gcode.filter((g) => g.stale.length) ?? []

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <PackageIcon className="size-4 text-primary" /> Export build pack
        </DialogTitle>
        <DialogDescription>
          One .zip with what someone needs to print and build this: design files, assembly guide, shopping list, pictures. It opens in Crease on
          any computer.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pr-1 text-xs">
        {error && <div className="text-err">{error}</div>}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pack-desc">What it is</Label>
          <Textarea
            id="pack-desc"
            rows={2}
            value={description ?? ""}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A small box with a hinged lid that snaps shut on magnets."
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Licence</Label>
          <Select items={LICENSES.map((l) => ({ value: l, label: l }))} value={license} onValueChange={(v) => v && setLicense(v as string)}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {LICENSES.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {license && <div className="text-muted-foreground">{LICENSE_HINT[license] ?? ""}</div>}
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-2">
            <Checkbox checked={includeGcode} onCheckedChange={(v) => setIncludeGcode(!!v)} disabled={!current.length} className="mt-0.5" />
            <span>
              <span className="font-medium">Include sliced G-code</span>
              <span className="block text-muted-foreground">
                {current.length ? "Only prints on the exact printer and settings it was sliced for:" : "Nothing sliced and up to date yet."}
              </span>
              {current.map((g) => (
                <span key={g.jobId} className="block font-mono text-caption text-muted-foreground">
                  {g.partIds.join(", ")}
                  {g.plate ? ` · plate ${g.plate}` : ""}: {g.label}
                </span>
              ))}
              {stale.length > 0 && (
                <span className="block text-caption text-warn">
                  {stale.length} out-of-date slice{stale.length === 1 ? "" : "s"} left out (slice again to include).
                </span>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <Checkbox checked={includeNotes} onCheckedChange={(v) => setIncludeNotes(!!v)} disabled={!preview?.notes} className="mt-0.5" />
            <span>
              <span className="font-medium">Include print notes</span>
              <span className="block text-muted-foreground">
                {preview?.notes ? `${preview.notes} print${preview.notes === 1 ? "" : "s"} from this computer: dates, outcomes and your notes.` : "No prints recorded yet."}
              </span>
            </span>
          </label>
        </div>

        {preview ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border p-2">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <CircleCheckIcon className="size-3.5 text-ok" /> Included · {fmtBytes(total)}
              </div>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {[...byRole.entries()].map(([role, v]) => (
                  <li key={role}>
                    {v.n} {ROLE_LABEL[role]?.[v.n === 1 ? 0 : 1] ?? role}
                  </li>
                ))}
                <li>{preview.guidePdf === "yes" ? "Guide as PDF too" : preview.guidePdf === "no-renderer" ? "Guide as HTML (PDF needs the desktop app)" : "No guide yet"}</li>
                <li>Checksums for every file</li>
              </ul>
            </div>
            <div className="border p-2">
              <div className="mb-1 flex items-center gap-1 font-medium">
                <ShieldCheckIcon className="size-3.5 text-primary" /> Left out
              </div>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {preview.excluded.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          !error && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        )}
        {preview?.warnings.map((w) => (
          <div key={w} className="flex items-start gap-1.5 text-warn">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {w}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void exportNow()} disabled={busy || !preview}>
          {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
          Export .zip
        </Button>
      </DialogFooter>
    </>
  )
}

/** Hidden file picker + result dialog. `pick()` opens the picker. */
export function useImportPack() {
  const input = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BuildPackImportResult | null>(null)
  const navigate = useStudio((s) => s.navigate)
  const loadProjects = useStudio((s) => s.loadProjects)

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    const t = toast.loading(`Checking ${file.name}…`)
    try {
      const r = await api.importPack(file)
      toast.dismiss(t)
      setResult(r)
      void loadProjects()
    } catch (e) {
      toast.error(`Couldn't open the build pack`, { id: t, description: errMsg(e), duration: 12000 })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ""
    }
  }

  const element = (
    <>
      <input ref={input} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
      <Dialog open={!!result} onOpenChange={(o) => !o && setResult(null)}>
        <DialogContent className="sm:max-w-md">
          {result && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <PackageIcon className="size-4 text-primary" /> Opened “{result.project.name}”
                </DialogTitle>
                <DialogDescription>It's a new project on this computer; the original is untouched.</DialogDescription>
              </DialogHeader>
              <ul className="flex flex-col gap-1.5 text-xs">
                <li className="flex items-center gap-1.5">
                  <CircleCheckIcon className="size-3.5 text-ok" /> {result.verified} files checked against their checksums
                </li>
                <li className="flex items-center gap-1.5">
                  <ShieldCheckIcon className="size-3.5 text-primary" /> Licence: {result.license}
                </li>
                <li className="flex items-start gap-1.5">
                  <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                  {result.disabledAgentConfig.length
                    ? `The pack came with assistant settings (${result.disabledAgentConfig.join(", ")}). They stay off until you turn them on.`
                    : "No assistant settings came with it."}
                </li>
                {result.warnings
                  .filter((w) => !w.startsWith("The pack had assistant settings"))
                  .map((w) => (
                    <li key={w} className="flex items-start gap-1.5 text-muted-foreground">
                      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warn" /> {w}
                    </li>
                  ))}
              </ul>
              <DialogFooter>
                <Button variant="outline" onClick={() => setResult(null)}>
                  Close
                </Button>
                <Button
                  onClick={() => {
                    const id = result.project.id
                    setResult(null)
                    navigate({ name: "project", id })
                  }}
                >
                  Open project
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
  return { pick: () => input.current?.click(), busy, element }
}

export function ImportPackButton() {
  const { pick, busy, element } = useImportPack()
  return (
    <>
      <Button size="sm" variant="outline" onClick={pick} disabled={busy} title="Open a build pack (.zip) as a new project">
        {busy ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} Import pack
      </Button>
      {element}
    </>
  )
}
