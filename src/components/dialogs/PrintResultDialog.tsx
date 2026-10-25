import { useEffect, useRef, useState } from "react"
import type {
  FitResult,
  PrintFailureCategory,
  PrintFitTest,
  PrintJobView,
  PrintMeasurement,
  PrintOutcomeRating,
  PrintRecord,
} from "@shared/types"
import { toast } from "sonner"
import {
  CameraIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ImagePlusIcon,
  LightbulbIcon,
  Loader2Icon,
  PlusIcon,
  PrinterIcon,
  RulerIcon,
  StarIcon,
  TriangleAlertIcon,
  XCircleIcon,
  XIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { humanParamName } from "@/lib/param-label"
import { Textarea } from "@/components/ui/textarea"
import { api, errMsg } from "@/lib/api"
import { fileToInputImage } from "@/lib/images"
import { fmtDuration } from "@/lib/format"
import { useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"

const RATINGS: { id: PrintOutcomeRating; label: string; icon: React.ComponentType<{ className?: string }>; tone: string }[] = [
  { id: "great", label: "Great", icon: StarIcon, tone: "border-ok/60 bg-ok/10 text-ok" },
  { id: "ok", label: "OK", icon: CheckCircle2Icon, tone: "border-primary/60 bg-primary/10 text-primary" },
  { id: "problem", label: "Problem", icon: TriangleAlertIcon, tone: "border-warn/60 bg-warn/10 text-warn" },
  { id: "failed", label: "Failed", icon: XCircleIcon, tone: "border-err/60 bg-err/10 text-err" },
]

const CATEGORIES: { id: PrintFailureCategory; label: string }[] = [
  { id: "didnt_stick", label: "Didn't stick" },
  { id: "stringing", label: "Stringing" },
  { id: "warping", label: "Warping" },
  { id: "layer_shift", label: "Layer shift" },
  { id: "spaghetti", label: "Spaghetti" },
  { id: "rough_top", label: "Rough top" },
  { id: "wrong_size", label: "Wrong size / fit" },
  { id: "broke", label: "Broke" },
  { id: "other", label: "Other" },
]

const FITS: { id: FitResult; label: string }[] = [
  { id: "too_tight", label: "Too tight" },
  { id: "just_right", label: "Just right" },
  { id: "too_loose", label: "Too loose" },
]

interface MeasureRow extends Omit<PrintMeasurement, "measuredMm" | "expectedMm"> {
  key: string
  expected: string
  measured: string
}
interface FitRow extends Omit<PrintFitTest, "clearanceMm"> {
  key: string
  clearance: string
}

const HOLE_RE = /hole|bore|inner|inside|slot|socket|pocket|_id$|^id_|cavity|opening/i
const SIZE_RE = /width|length|height|depth|diam|thick|size|^w$|^l$|^h$|^d$|_w$|_l$|_h$|_d$|outer|hole|bore|slot|inner|socket|pocket|opening/i
const CLEAR_RE = /clearance|tolerance|^tol|gap|fit|play/i
const n2 = (v: number) => String(Math.round(v * 100) / 100)
let rowKey = 0
const nextKey = () => `r${++rowKey}`

/** Prefill features to measure from the design: each part's overall size and its size-like parameters. */
async function designFeatures(projectId: string, partIds: string[]): Promise<{ rows: MeasureRow[]; clearance: number | null }> {
  const rows: MeasureRow[] = []
  let clearance: number | null = null
  for (const partId of partIds.slice(0, 2)) {
    const tag = partIds.length > 1 ? `${partId}: ` : ""
    const [params, latest] = await Promise.all([api.parameters(projectId, partId).catch(() => []), api.latest(projectId, partId).catch(() => null)])
    for (const p of params) {
      if (typeof p.value !== "number") continue
      if (CLEAR_RE.test(p.name) && p.value >= 0 && p.value <= 2) {
        clearance ??= p.value
        continue
      }
      if (!SIZE_RE.test(p.name) || p.value < 1 || p.value > 400) continue
      const label = (p.description?.split(/[.(]/)[0].trim() || humanParamName(p.name)).slice(0, 40)
      rows.push({ key: nextKey(), name: `${tag}${label}`, partId, kind: HOLE_RE.test(`${p.name} ${p.description ?? ""}`) ? "hole" : "outside", expected: n2(p.value), measured: "" })
    }
    const size = latest?.render?.stats?.sizeMm
    if (size && !rows.some((r) => r.partId === partId)) {
      ;(["Width (X)", "Depth (Y)", "Height (Z)"] as const).forEach((n, i) =>
        rows.push({ key: nextKey(), name: `${tag}${n}`, partId, kind: "outside", expected: n2(size[i]), measured: "" }),
      )
    }
  }
  return { rows: rows.slice(0, 8), clearance }
}

const ended = (state: string) => (state === "complete" ? "finished" : "stopped")

/**
 * After a logged print ends (print.finished): how did it turn out? Rating, problems, photos, notes, measurements.
 * R2-STATE-01: it first asks in one line, in the layout above the status bar (FinishedPrintAsk), so it covers nothing;
 * the form opens as a dialog only when asked for.
 */
export function PrintResultDialog() {
  const finished = useStudio((s) => s.finishedPrints)
  const blocked = useStudio((s) => s.printRequests.length > 0) // the start confirmation wins
  const dismiss = useStudio((s) => s.dismissFinished)
  const cur = finished[0]
  const open = !!cur?.expanded && !blocked
  return (
    <Dialog open={open} onOpenChange={(o) => !o && cur && dismiss(cur.printId)}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100svh-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[25rem]">
        <DialogTitle className="sr-only">How did the print turn out?</DialogTitle>
        <DialogDescription className="sr-only">Rate the print, add photos and notes.</DialogDescription>
        {open && <ResultCard key={cur.printId} printId={cur.printId} projectId={cur.projectId} state={cur.state} onClose={() => dismiss(cur.printId)} />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The one-line ask after a print ends: "Cable clip finished. How did it go? · Rate it". It sits in the layout (never
 * over the work), names the project, and goes away when you open another project: that project's Overview keeps the
 * "How did it turn out?" step.
 */
export function FinishedPrintAsk() {
  const cur = useStudio((s) => s.finishedPrints[0])
  const blocked = useStudio((s) => s.printRequests.length > 0)
  const name = useStudio((s) => (cur ? (s.projects?.find((p) => p.id === cur.projectId)?.name ?? (s.project?.id === cur.projectId ? s.project.name : null)) : null))
  const routeProject = useStudio((s) => (s.route.name === "project" ? s.route.id : null))
  const dismiss = useStudio((s) => s.dismissFinished)
  const open = useStudio((s) => s.openPrintResult)
  // close on project change: remember where you were when it appeared
  const [seenIn, setSeenIn] = useState<{ id: string | null; at: string | null }>({ id: null, at: null })
  if (cur && seenIn.id !== cur.printId) setSeenIn({ id: cur.printId, at: routeProject })
  useEffect(() => {
    if (cur && !cur.expanded && seenIn.id === cur.printId && routeProject && routeProject !== seenIn.at && routeProject !== cur.projectId) dismiss(cur.printId)
  }, [cur, routeProject, seenIn, dismiss])
  if (!cur || cur.expanded || blocked) return null
  return (
    <div role="status" className="flex h-8 shrink-0 items-center gap-2 border-t border-primary/40 bg-primary/[0.06] px-3 text-xs">
      <PrinterIcon className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="font-medium">{name ?? "Your print"}</span> {ended(cur.state)}. How did it go?
      </span>
      <Button size="xs" onClick={() => open(cur)}>
        Rate it
      </Button>
      <div className="flex-1" />
      <Button size="icon-xs" variant="ghost" onClick={() => dismiss(cur.printId)} aria-label="Ask me later" title="Ask me later">
        <XIcon />
      </Button>
    </div>
  )
}

function ResultCard({ printId, projectId, state, onClose }: { printId: string; projectId: string; state: string; onClose: () => void }) {
  const [record, setRecord] = useState<PrintRecord | null>(null)
  const [job, setJob] = useState<PrintJobView | null>(null)
  const [rating, setRating] = useState<PrintOutcomeRating | null>(state === "complete" ? null : "failed")
  const [cats, setCats] = useState<PrintFailureCategory[]>([])
  const [notes, setNotes] = useState("")
  const [photos, setPhotos] = useState<string[]>([])
  const [measure, setMeasure] = useState<MeasureRow[]>([])
  const [fits, setFits] = useState<FitRow[]>([])
  const [clearance, setClearance] = useState<number | null>(null)
  const [showMeasure, setShowMeasure] = useState(false)
  const [busy, setBusy] = useState<null | "save" | "photo" | "camera" | "lesson">(null)
  const [drag, setDrag] = useState(false)
  const [saved, setSaved] = useState<PrintRecord | null>(null)
  const [lessonText, setLessonText] = useState("")
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await api.getPrint(printId).catch(() => null)
      if (!alive || !r) return
      setRecord(r)
      const o = r.outcome
      if (o) {
        setRating(o.rating)
        setCats(o.categories)
        setNotes(o.notes ?? "")
        setPhotos(o.photos)
        setFits(o.fits.map((f) => ({ ...f, key: nextKey(), clearance: f.clearanceMm != null ? n2(f.clearanceMm) : "" })))
      } else if (r.notes) setNotes(r.notes)
      const j = r.jobId ? await api.projectJob(projectId, r.jobId).catch(() => null) : null
      if (alive) setJob(j)
      const f = await designFeatures(projectId, j?.partIds ?? r.partIds)
      if (!alive) return
      const measured = new Map((o?.measurements ?? []).map((m) => [m.name, m]))
      setMeasure([
        ...f.rows.map((row) => {
          const m = measured.get(row.name)
          if (m) measured.delete(row.name)
          return m?.measuredMm != null ? { ...row, measured: n2(m.measuredMm) } : row
        }),
        ...[...measured.values()].map((m) => ({ ...m, key: nextKey(), expected: n2(m.expectedMm), measured: m.measuredMm != null ? n2(m.measuredMm) : "" })),
      ])
      setClearance(f.clearance)
      if (o && (o.measurements.length || o.fits.length)) setShowMeasure(true)
    })()
    return () => {
      alive = false
    }
  }, [printId, projectId])

  const duration = record?.actualDurationS ?? (record?.finishedAt ? (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000 : null)
  const estimate = record?.estimatedTimeS ?? null

  const uploadFiles = async (files: FileList | File[]) => {
    setBusy("photo")
    try {
      for (const f of [...files].filter((f) => f.type.startsWith("image/")).slice(0, 6)) {
        const img = await fileToInputImage(f)
        const r = await api.addPrintPhoto(printId, { mediaType: img.mediaType, data: img.data })
        setPhotos((p) => [...p, r.name])
      }
    } catch (e) {
      toast.error("Couldn't add the photo", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  const fromCamera = async () => {
    setBusy("camera")
    try {
      const r = await api.addPrintPhoto(printId, { fromCamera: true })
      setPhotos((p) => [...p, r.name])
    } catch (e) {
      toast.error("Couldn't get a camera picture", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  const removePhoto = (name: string) => {
    setPhotos((p) => p.filter((x) => x !== name))
    void api.removePrintPhoto(printId, name).catch(() => {})
  }

  const save = async () => {
    if (!rating) return
    setBusy("save")
    try {
      const num = (s: string) => (s.trim() && isFinite(Number(s)) ? Number(s) : null)
      const r = await api.saveOutcome(printId, {
        rating,
        categories: rating === "great" ? [] : cats,
        notes: notes.trim() || null,
        photos,
        measurements: measure
          .filter((m) => num(m.measured) != null && num(m.expected) != null)
          .map((m) => ({ name: m.name, partId: m.partId ?? null, kind: m.kind, expectedMm: num(m.expected)!, measuredMm: num(m.measured) })),
        fits: fits.filter((f) => f.name.trim()).map((f) => ({ name: f.name, result: f.result, kind: f.kind ?? "sliding", clearanceMm: num(f.clearance) })),
      })
      const lesson = r.outcome?.lesson
      if (lesson?.status === "proposed") {
        setSaved(r)
        setLessonText(lesson.text)
      } else {
        toast.success("Thanks, saved with this print")
        onClose()
      }
    } catch (e) {
      toast.error("Couldn't save how it went", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const decide = async (action: "accept" | "dismiss") => {
    setBusy("lesson")
    try {
      await api.decideLesson(printId, action, action === "accept" ? lessonText.trim() : undefined)
      toast.success(action === "accept" ? "Lesson saved for this printer" : "Saved", {
        description: action === "accept" ? "Remove it any time in Machines." : undefined,
      })
      onClose()
    } catch (e) {
      toast.error("Couldn't save the lesson", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const problem = rating === "problem" || rating === "failed" || rating === "ok"
  const machineName = job?.machineName
  const projectName = useStudio((s) => s.projects?.find((p) => p.id === projectId)?.name ?? (s.project?.id === projectId ? s.project.name : null))

  return (
    // the body of the "How did it turn out?" dialog
    <div
      role="region"
      aria-label="How did the print turn out?"
      onDragOver={(e) => {
        if (saved) return
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (!saved && e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files)
      }}
      className={cn(
        "flex max-h-[calc(100svh-4rem)] min-h-0 w-full flex-col text-xs",
        drag && "border-primary ring-primary/40",
      )}
    >
      <div className="flex items-start gap-2 border-b p-3">
        <PrinterIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{saved ? "Something to remember?" : `${projectName ?? "Print"} ${ended(state)}. How did it go?`}</div>
          <div
            className="truncate text-caption text-muted-foreground"
            title={[record?.gcodeName, estimate != null ? `Estimate ${fmtDuration(estimate)}` : null].filter(Boolean).join(" · ")}
          >
            {duration != null ? `Took ${fmtDuration(duration)}` : (record?.gcodeName ?? "…")}
          </div>
        </div>
        <button
          className="-mt-1 -mr-1 flex size-6 items-center justify-center text-muted-foreground hover:text-foreground"
          onClick={onClose}
          aria-label="Dismiss"
          title="Ask me later"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>

      {saved ? (
        <div className="flex flex-col gap-2.5 p-3">
          <p className="text-muted-foreground">
            Save a lesson for <span className="text-foreground">{machineName ?? "this printer"}</span>? The designer reads it next time.
          </p>
          <div className="flex items-start gap-2 border border-primary/40 bg-primary/5 p-2">
            <LightbulbIcon className="mt-1 size-4 shrink-0 text-primary" />
            <Textarea value={lessonText} onChange={(e) => setLessonText(e.target.value)} aria-label="Lesson" className="min-h-16 border-0 bg-transparent p-0 text-xs focus-visible:ring-0" maxLength={300} />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => void decide("dismiss")} disabled={busy !== null}>
              Not useful
            </Button>
            <Button size="sm" onClick={() => void decide("accept")} disabled={busy !== null || !lessonText.trim()}>
              {busy === "lesson" && <Loader2Icon className="animate-spin" />}
              Save lesson
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="How did it turn out?">
              {RATINGS.map((r) => (
                <button
                  key={r.id}
                  role="radio"
                  aria-checked={rating === r.id}
                  onClick={() => setRating(r.id)}
                  className={cn("flex flex-col items-center gap-1 border p-2 text-muted-foreground hover:text-foreground", rating === r.id && r.tone)}
                >
                  <r.icon className="size-4" />
                  {r.label}
                </button>
              ))}
            </div>

            {problem && (
              <div>
                <div className="ps-label mb-1.5">{rating === "ok" ? "Anything not quite right?" : "What went wrong?"}</div>
                <div className="flex flex-wrap gap-1">
                  {CATEGORIES.map((c) => {
                    const on = cats.includes(c.id)
                    return (
                      <button
                        key={c.id}
                        aria-pressed={on}
                        onClick={() => setCats((x) => (on ? x.filter((y) => y !== c.id) : [...x, c.id]))}
                        className={cn("border px-2 py-1 text-caption text-muted-foreground hover:text-foreground", on && "border-primary/60 bg-primary/10 text-foreground")}
                      >
                        {c.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* details only once there's a rating: one choice at a time */}
            {rating && (
              <>
                <div>
                  <div className="mb-1.5 text-muted-foreground">Photos</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {photos.map((p) => (
                      <div key={p} className="group relative size-14 overflow-hidden border">
                        <img src={api.printPhotoUrl(printId, p)} alt="Print photo" className="size-full object-cover" />
                        <button
                          onClick={() => removePhoto(p)}
                          aria-label="Remove photo"
                          className="absolute top-0 right-0 hidden size-5 items-center justify-center bg-background/80 text-muted-foreground group-hover:flex hover:text-foreground"
                        >
                          <XIcon className="size-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() => fileInput.current?.click()}
                      disabled={busy !== null}
                      className="flex h-14 flex-1 items-center justify-center gap-1.5 border border-dashed text-muted-foreground hover:border-primary/60 hover:text-foreground"
                    >
                      {busy === "photo" ? <Loader2Icon className="size-4 animate-spin" /> : <ImagePlusIcon className="size-4" />}
                      Add photo
                    </button>
                    <button
                      onClick={() => void fromCamera()}
                      disabled={busy !== null}
                      title="Take a picture with the printer's camera"
                      className="flex h-14 w-20 flex-col items-center justify-center gap-1 border text-muted-foreground hover:border-primary/60 hover:text-foreground"
                    >
                      {busy === "camera" ? <Loader2Icon className="size-4 animate-spin" /> : <CameraIcon className="size-4" />}
                      Camera
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) void uploadFiles(e.target.files)
                        e.target.value = ""
                      }}
                    />
                  </div>
                </div>
    
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={problem ? "What did you notice? (where, how bad…)" : "Notes (optional)"}
                  className="min-h-12 text-xs"
                  aria-label="Notes"
                />
    
                <div className="overflow-hidden border">
                  <button className="flex w-full items-center gap-1.5 rounded-none p-2 text-left hover:bg-muted/40" onClick={() => setShowMeasure((v) => !v)} aria-expanded={showMeasure}>
                    <RulerIcon className="size-3.5 text-primary" />
                    <span className="font-medium">Measure it</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title="Helps the next one fit better.">
                      · optional
                    </span>
                    <ChevronDownIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", showMeasure && "rotate-180")} aria-hidden />
                  </button>
                  {showMeasure && (
                    <div className="flex flex-col gap-2 border-t p-2">
                      <p className="text-caption text-muted-foreground">Leave a row empty to skip it.</p>
                      <div className="grid grid-cols-[1fr_4.5rem_4rem_4rem_1.25rem] items-center gap-1 text-caption">
                        <span className="text-muted-foreground">Feature</span>
                        <span className="text-muted-foreground">Kind</span>
                        <span className="text-muted-foreground">Design mm</span>
                        <span className="text-muted-foreground">Measured</span>
                        <span />
                        {measure.map((m, i) => {
                          const set = (patch: Partial<MeasureRow>) => setMeasure((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                          return (
                            <MeasureCells key={m.key} m={m} set={set} remove={() => setMeasure((xs) => xs.filter((_, j) => j !== i))} />
                          )
                        })}
                      </div>
                      <button
                        className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground"
                        onClick={() => setMeasure((xs) => [...xs, { key: nextKey(), name: "", kind: "outside", expected: "", measured: "" }])}
                      >
                        <PlusIcon className="size-3" /> Add a feature
                      </button>
    
                      <div className="ps-label mt-1">Fit test</div>
                      {fits.map((f, i) => {
                        const set = (patch: Partial<FitRow>) => setFits((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                        return (
                          <div key={f.key} className="flex flex-col gap-1 border p-1.5">
                            <div className="flex items-center gap-1">
                              <Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="What fits into what (lid on box)" className="h-7 flex-1" aria-label="Fit name" />
                              <Input
                                value={f.clearance}
                                onChange={(e) => set({ clearance: e.target.value })}
                                placeholder="gap mm"
                                title="Gap per side the design used (from its clearance setting)"
                                className="h-7 w-16"
                                inputMode="decimal"
                                aria-label="Clearance per side"
                              />
                              <button onClick={() => setFits((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove fit" className="text-muted-foreground hover:text-foreground">
                                <XIcon className="size-3" />
                              </button>
                            </div>
                            <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label={`${f.name || "Fit"} result`}>
                              {FITS.map((r) => (
                                <button
                                  key={r.id}
                                  role="radio"
                                  aria-checked={f.result === r.id}
                                  onClick={() => set({ result: r.id })}
                                  className={cn(
                                    "border px-1 py-1 text-caption text-muted-foreground hover:text-foreground",
                                    f.result === r.id && (r.id === "just_right" ? "border-ok/60 bg-ok/10 text-ok" : "border-warn/60 bg-warn/10 text-warn"),
                                  )}
                                >
                                  {r.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )
                      })}
                      <button
                        className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setFits((xs) => [...xs, { key: nextKey(), name: xs.length ? "" : "Parts fit together", result: "just_right", kind: "sliding", clearance: clearance != null ? n2(clearance) : "" }])
                        }
                      >
                        <PlusIcon className="size-3" /> Add a fit test
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t p-3">
            <span className="text-caption text-muted-foreground">{drag ? "Drop to add the photo" : ""}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onClose}>
                Later
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={!rating || busy !== null}>
                {busy === "save" && <Loader2Icon className="animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function MeasureCells({ m, set, remove }: { m: MeasureRow; set: (p: Partial<MeasureRow>) => void; remove: () => void }) {
  const exp = Number(m.expected)
  const got = Number(m.measured)
  const diff = m.measured.trim() && m.expected.trim() && isFinite(exp) && isFinite(got) ? got - exp : null
  return (
    <>
      <Input value={m.name} onChange={(e) => set({ name: e.target.value })} placeholder={m.kind === "hole" ? "e.g. Big hole" : m.kind === "outside" ? "e.g. Width" : "What you measured"} className="h-7" aria-label="Feature" />
      <span title="Outside size, or a hole / slot (inside size)" className="min-w-0">
        <OptionSelect<MeasureRow["kind"]>
          value={m.kind}
          onChange={(kind) => set({ kind })}
          className="w-full"
          aria-label="Kind"
          options={[
            { value: "outside", label: "Outside" },
            { value: "hole", label: "Hole" },
            { value: "other", label: "Other" },
          ]}
        />
      </span>
      <Input value={m.expected} onChange={(e) => set({ expected: e.target.value })} className="h-7" inputMode="decimal" aria-label="Design size (mm)" />
      <Input
        value={m.measured}
        onChange={(e) => set({ measured: e.target.value })}
        placeholder="—"
        className={cn("h-7", diff != null && Math.abs(diff) >= 0.15 && "border-warn/70")}
        inputMode="decimal"
        aria-label="Measured size (mm)"
        title={diff != null ? `${diff >= 0 ? "+" : ""}${Math.round(diff * 100) / 100} mm` : undefined}
      />
      <button onClick={remove} aria-label="Remove feature" className="text-muted-foreground hover:text-foreground">
        <XIcon className="size-3" />
      </button>
    </>
  )
}
