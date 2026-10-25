// Fit test for one printer: print the test piece, then enter which holes fit. New designs use the measured fits.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { api, errMsg, type Tolerances } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

const CLEAR = [0.1, 0.2, 0.3, 0.4]
const HOLES = [2.8, 3.0, 3.2, 3.4, 3.6]

function Choice<T extends number | null>({
  label,
  value,
  options,
  onChange,
  fmt,
}: {
  label: string
  value: T | undefined
  options: T[]
  onChange: (v: T) => void
  fmt: (v: T) => string
}) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {options.map((o) => (
          <button
            key={String(o)}
            role="radio"
            aria-checked={value === o}
            onClick={() => onChange(o)}
            className={cn("h-9 min-w-14 border px-3 text-sm hover:border-primary/60", value === o && "border-primary bg-primary/15 font-medium")}
          >
            {fmt(o)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/** Fit test for one printer (default printer when machineId is omitted): create the test piece, enter results. */
export function FitTestPanel({ machineId }: { machineId?: string | null }) {
  const navigate = useStudio((s) => s.navigate)
  const [press, setPress] = useState<number | null | undefined>(undefined)
  const [slide, setSlide] = useState<number | null | undefined>(undefined)
  const [hole, setHole] = useState<number | null | undefined>(undefined)
  const [saved, setSaved] = useState<Tolerances | null>(null)
  const [busy, setBusy] = useState<"create" | "save" | null>(null)

  useEffect(() => {
    api
      .getTolerances(machineId)
      .then((t) => {
        setSaved(t)
        if (t.pressFitMm != null) setPress(t.pressFitMm)
        if (t.slidingFitMm != null) setSlide(t.slidingFitMm)
        if (t.holeCompensationMm != null) setHole(Math.round((3 + t.holeCompensationMm) * 10) / 10)
      })
      .catch(() => {})
  }, [machineId])

  const create = async () => {
    setBusy("create")
    try {
      const p = await api.useStarter("fit-test", "Fit test")
      if (machineId) await useStudio.getState().setProjectMachine(p.id, machineId).catch(() => {})
      useStudio.getState().setMachineDialog(null)
      navigate({ name: "project", id: p.id })
      toast.success("Fit test created", { description: "Print it, then enter results in the printer's Fit test." })
    } catch (e) {
      toast.error("Couldn't create the fit test", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  const save = async () => {
    setBusy("save")
    try {
      const t = await api.setTolerances(
        {
          ...(press !== undefined ? { pressFitMm: press } : {}),
          ...(slide !== undefined ? { slidingFitMm: slide } : {}),
          ...(hole !== undefined ? { holeCompensationMm: hole == null ? null : Math.round((hole - 3) * 100) / 100 } : {}),
        },
        machineId,
      )
      void useStudio.getState().loadMachines()
      setSaved(t)
      toast.success("Saved: new designs will use these fits")
    } catch (e) {
      toast.error("Couldn't save", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
        <div className="font-medium">1. Print the test piece</div>
        <Button variant="outline" className="self-start" onClick={() => void create()} disabled={busy !== null}>
          {busy === "create" && <Loader2Icon className="animate-spin" />}
          Create fit test
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-4 rounded-lg border bg-card p-3">
        <div className="font-medium">2. Enter what you found</div>
        <Choice
          label="Which square hole holds the peg with a firm push?"
          value={press}
          options={[...CLEAR, null]}
          onChange={setPress}
          fmt={(v) => (v == null ? "None" : `${v}`)}
        />
        <Choice
          label="Which square hole lets the peg slide freely?"
          value={slide}
          options={[...CLEAR, null]}
          onChange={setSlide}
          fmt={(v) => (v == null ? "None" : `${v}`)}
        />
        <Choice
          label="Which round hole fits an M3 screw?"
          value={hole}
          options={[...HOLES, null]}
          onChange={setHole}
          fmt={(v) => (v == null ? "None" : `${v.toFixed(1)}`)}
        />
        <Button className="self-start" onClick={() => void save()} disabled={busy !== null || (press === undefined && slide === undefined && hole === undefined)}>
          {busy === "save" && <Loader2Icon className="animate-spin" />}
          Save results
        </Button>
        {saved && (saved.pressFitMm != null || saved.slidingFitMm != null || saved.holeCompensationMm != null) && (
          <div className="text-xs text-muted-foreground">
            Saved: press {saved.pressFitMm ?? "–"} mm · slide {saved.slidingFitMm ?? "–"} mm · holes{" "}
            {saved.holeCompensationMm == null ? "–" : `${saved.holeCompensationMm >= 0 ? "+" : ""}${saved.holeCompensationMm} mm`}
          </div>
        )}
      </div>
    </>
  )
}
