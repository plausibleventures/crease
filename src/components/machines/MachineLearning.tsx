// Machines -> edit printer: what real prints taught us. Calibration (time factor, fit suggestions to apply) and the
// lessons the design partner reads (lessons.md), each removable (undo of an accepted lesson).
import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { CalibrationReport, PrinterLesson, ToleranceSuggestion } from "@shared/types"
import { ClockIcon, LightbulbIcon, Loader2Icon, RulerIcon, Trash2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"

const KEY_LABEL: Record<ToleranceSuggestion["key"], string> = {
  slidingFitMm: "Sliding fit gap",
  pressFitMm: "Press fit gap",
  holeCompensationMm: "Extra hole size",
}

export function MachineCalibration({ machineId, onApplied }: { machineId: string; onApplied: () => void }) {
  const rev = useStudio((s) => s.printsRev)
  const [report, setReport] = useState<CalibrationReport | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [n, setN] = useState(0)

  useEffect(() => {
    let alive = true
    api
      .calibration({ machineId })
      .then((r) => alive && setReport(r))
      .catch(() => alive && setReport(null))
    return () => {
      alive = false
    }
  }, [machineId, rev, n])

  const apply = async (s: ToleranceSuggestion) => {
    setBusy(s.key)
    try {
      await api.setTolerances({ [s.key]: s.suggested }, machineId)
      toast.success(`${KEY_LABEL[s.key]} set to ${s.suggested} mm`)
      setN((x) => x + 1)
      onApplied()
    } catch (e) {
      toast.error("Couldn't save it", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  if (!report) return <p className="text-xs text-muted-foreground">Loading…</p>
  const t = report.time
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-start gap-2">
        <ClockIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        {t.factor != null ? (
          <span
            title={`From your last ${t.prints} print${t.prints === 1 ? "" : "s"}${t.ignored ? `, ${t.ignored} unusual one${t.ignored === 1 ? "" : "s"} ignored` : ""}. Shown times are adjusted.`}
          >
            Prints take <span className="text-foreground">{t.factor}×</span> the slicer's time.
          </span>
        ) : t.ignored ? (
          // finished prints exist, but none was usable (e.g. paused, or far off the estimate): don't say "none yet"
          <span className="text-muted-foreground" title="Paused, or far off the estimate.">
            {t.ignored} unusual print{t.ignored === 1 ? "" : "s"} so far. Times are the slicer's.
          </span>
        ) : (
          <span className="text-muted-foreground">No finished prints yet.</span>
        )}
      </div>
      <div className="flex items-start gap-2">
        <RulerIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        {report.tolerances.length ? (
          <div className="flex flex-1 flex-col gap-1.5">
            {report.tolerances.map((s) => (
              <div key={s.key} className="flex items-center gap-2 border p-2">
                <div className="min-w-0 flex-1">
                  <div>
                    {KEY_LABEL[s.key]}: <span className="text-foreground">{s.suggested} mm</span>
                    <span className="text-muted-foreground"> (now {s.current != null ? `${s.current} mm` : "not set"})</span>
                  </div>
                  <div className="text-caption text-muted-foreground">{s.reason}</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void apply(s)} disabled={busy !== null}>
                  {busy === s.key && <Loader2Icon className="animate-spin" />}
                  Use it
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">
            {report.outcomes ? "Your fits match the saved settings." : "No fit measurements yet."}
          </span>
        )}
      </div>
    </div>
  )
}

export function MachineLessons({ machineId }: { machineId: string }) {
  const rev = useStudio((s) => s.printsRev)
  const [list, setList] = useState<PrinterLesson[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api
      .machineLessons(machineId)
      .then((l) => alive && setList(l))
      .catch(() => alive && setList([]))
    return () => {
      alive = false
    }
  }, [machineId, rev])

  const remove = async (l: PrinterLesson) => {
    setBusy(l.line)
    try {
      setList(await api.removeMachineLesson(machineId, l.line))
      toast.success("Lesson removed")
    } catch (e) {
      toast.error("Couldn't remove it", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  if (!list) return <p className="text-xs text-muted-foreground">Loading…</p>
  if (!list.length)
    return <p className="text-xs text-muted-foreground">No lessons yet.</p>
  return (
    <ul className="flex flex-col divide-y border text-xs" aria-label="Lessons">
      {[...list].reverse().map((l) => (
        <li key={l.line} className="group flex items-start gap-2 p-2">
          <LightbulbIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            {l.text}
            {l.date && <span className="ml-1.5 text-micro text-muted-foreground">{l.date}</span>}
          </span>
          <button
            onClick={() => void remove(l)}
            disabled={busy !== null}
            aria-label="Remove lesson"
            title="Remove (undo) this lesson"
            className="text-muted-foreground opacity-60 group-hover:opacity-100 hover:text-err"
          >
            {busy === l.line ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
          </button>
        </li>
      ))}
    </ul>
  )
}
