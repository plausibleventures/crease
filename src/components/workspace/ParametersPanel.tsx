import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ScadParameter, SharedParamNote } from "@shared/types"
import { Loader2Icon, RotateCcwIcon, ServerCrashIcon, SlidersHorizontalIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { paramLabel } from "@/lib/param-label"
import { groupParams, sharedLabel, splitUnit, type ParamGroup } from "@/lib/param-groups"
import { useUnits } from "@/lib/units"
import { fmtLen, fromUnit, isLengthParam, labelInUnits, lenNumber, parseLen, sliderRange, toUnit } from "@shared/length"
import { DetailsToggle, EmptyState } from "@/components/panel"
import { ImportKindNote } from "./ImportFile"
import { api, errMsg } from "@/lib/api"
import { useRemembered } from "@/lib/use-remembered"
import { partKey, useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"

type Val = number | string | boolean
type Overrides = Record<string, Val>

/**
 * A part's Customizer parameters and its saved values (every render, check and slice uses them). Edits re-render
 * after a short pause; the server turns a settled burst of edits into one version (U2), so Compare and "Go back"
 * see slider changes. A shared setting (`sharedWith`) has one value for every part that has it: the server saves it
 * for all of them and re-renders the others.
 */
function useCustomizer(projectId: string, partId: string | null) {
  const render = useStudio((s) => s.render)
  const rendering = useStudio((s) => (partId ? !!s.rendering[partKey(projectId, partId)] : false))
  const fileChange = useStudio((s) => s.fileChange)
  const part = useStudio((s) => s.project?.parts.find((p) => p.id === partId))
  const [params, setParams] = useState<ScadParameter[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Overrides>({})
  const [notes, setNotes] = useState<SharedParamNote[]>([])
  const lastRender = useStudio((s) => (partId ? s.renders[partKey(projectId, partId)] : undefined))

  // (state resets per part because callers key their component by partId)
  const load = useCallback(async () => {
    if (!partId) return
    try {
      const p = await api.parameters(projectId, partId)
      setParams(Array.isArray(p) ? p : [])
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [projectId, partId])

  useEffect(() => {
    let alive = true
    if (partId)
      api
        .parameters(projectId, partId)
        .then((p) => alive && setParams(Array.isArray(p) ? p : []))
        .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [projectId, partId])

  // reload definitions when the part file changes on disk
  useEffect(() => {
    if (!fileChange || fileChange.projectId !== projectId || !part) return
    // (any .scad: the part may include<> a shared lib file whose settings show here too)
    if (!fileChange.paths.some((p) => p === "*" || p === part.file || p.endsWith(part.file) || p.endsWith(".scad"))) return
    let alive = true
    api
      .parameters(projectId, part.id)
      .then((p) => alive && setParams(Array.isArray(p) ? p : []))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [fileChange, projectId, part])

  // debounce re-render on override changes
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(0)
  const scheduleRender = (next: Overrides) => {
    if (!partId) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      inFlight.current++
      // `{}` (Reset) clears the saved values; anything else replaces them
      void render(projectId, partId, next).finally(() => inFlight.current--)
    }, 350)
  }

  // Saved values: on open, and after each render of this part unless an edit here is still on its way (the agent
  // may have set them with render_part params, or the other copy of these controls did).
  useEffect(() => {
    if (!partId || timer.current || inFlight.current) return
    let alive = true
    api
      .partOverrides(projectId, partId)
      .then((r) => {
        if (!alive || timer.current || inFlight.current) return
        setOverrides(r?.overrides ?? {})
        setNotes(r?.notes ?? [])
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId, partId, lastRender])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  // changing a setting (or Reset) answers its "parts had different values" note
  const dropNotes = (names: string[] | null) => setNotes((ns) => (names ? ns.filter((n) => !names.includes(n.name)) : []))
  const dismissNote = (name: string) => {
    dropNotes([name])
    void api.dismissSharedNotes(projectId, [name]).catch(() => {})
  }

  const setVal = (name: string, v: Val) => {
    dropNotes([name])
    setOverrides((o) => {
      const next = { ...o, [name]: v }
      scheduleRender(next)
      return next
    })
  }
  const reset = () => {
    dropNotes(null)
    setOverrides({})
    scheduleRender({})
  }

  const resetOne = (name: string) => {
    dropNotes([name])
    setOverrides((o) => {
      if (!(name in o)) return o
      const next = { ...o }
      delete next[name]
      scheduleRender(next)
      return next
    })
  }

  return { part, params, error, load, overrides, notes, dismissNote, setVal, reset, resetOne, rendering, dirty: Object.keys(overrides).length > 0 }
}

/** The project's parts with their display names (the guide's names when there is one). */
function useNamedParts(projectId: string) {
  const ids = useStudio((s) => (s.project?.id === projectId ? s.project.parts : undefined))
  const named = useStudio((s) => s.overview[projectId]?.parts)
  return useMemo(() => (ids ?? []).map((p) => ({ id: p.id, name: named?.find((n) => n.id === p.id)?.name ?? p.id })), [ids, named])
}

/**
 * The tools panel's Parameters tab: the selected part's settings, grouped by section. The part's own sections come
 * first and open; sections about another part ("Saucer" while the pot is selected) start closed and offer to select
 * that part. Details show the variable and file names.
 */
export function ParametersPanel({ projectId, partId }: { projectId: string; partId: string | null }) {
  const c = useCustomizer(projectId, partId)
  const [names, setNames] = useRemembered("params-names")
  const parts = useNamedParts(projectId)
  const groups = useMemo(() => groupParams(c.params ?? [], parts, partId), [c.params, parts, partId])
  const partName = parts.find((p) => p.id === partId)?.name ?? partId

  if (!partId) return <EmptyState icon={<SlidersHorizontalIcon />} title="No part selected" />
  if (c.error)
    return (
      <EmptyState
        icon={<ServerCrashIcon />}
        title="Couldn't load parameters"
        detail={c.error}
        action={
          <Button size="sm" variant="outline" onClick={() => void c.load()}>
            Retry
          </Button>
        }
      />
    )
  if (!c.params) return <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading parameters…" />
  if (!c.params.length)
    return <EmptyState icon={<SlidersHorizontalIcon />} title="No Customizer parameters" detail="The design has no settings to change." />

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2 text-caption text-muted-foreground">
        <span
          className="min-w-0 truncate"
          title="Saved with this part. Renders, checks and slices use them. A shared setting changes every part that has it. Each change is saved as a version."
        >
          Settings of <span className="font-medium text-foreground">{partName}</span>
        </span>
        {c.rendering && <Loader2Icon className="size-3 shrink-0 animate-spin" aria-label="Updating" />}
        <div className="flex-1" />
        <DetailsToggle open={names} onToggle={() => setNames((n) => !n)} label="Names" />
        <Button size="xs" variant="ghost" disabled={!c.dirty} onClick={c.reset} title="Back to the design's own values">
          <RotateCcwIcon /> Reset all
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {c.part?.imported && <ImportKindNote kind={c.part.imported.kind} className="mb-3" />}
        <div className="flex max-w-2xl flex-col gap-1">
          {groups.map((g) => (
            <ParamSection key={g.title} g={g} parts={parts} names={names}>
              <SharedNotes notes={c.notes.filter((n) => g.ps.some((p) => p.name === n.name))} ps={g.ps} parts={parts} onDismiss={c.dismissNote} />
              <ParamGrid>
                {g.ps.map((p) => (
                  <ParamRow
                    key={p.name}
                    p={p}
                    value={c.overrides[p.name] ?? p.value}
                    changed={p.name in c.overrides}
                    onChange={(v) => c.setVal(p.name, v)}
                    onReset={() => c.resetOne(p.name)}
                    names={names}
                    shared={!g.sharedWith && p.sharedWith ? sharedLabel(p.sharedWith, parts) : undefined}
                  />
                ))}
              </ParamGrid>
            </ParamSection>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One section of settings: its title, which part it is about, and (for another part's section) closed at first. A
 * shared section says which parts it changes ("Pot and saucer").
 */
function ParamSection({ g, parts, names, children }: { g: ParamGroup; parts: { id: string; name: string }[]; names: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(g.about !== "other")
  const other = g.about === "other" ? (parts.find((p) => p.id === g.partIds[0]) ?? { id: g.partIds[0], name: g.partIds[0] }) : undefined
  return (
    <section className="flex flex-col">
      <div className="flex h-7 items-center gap-2">
        <DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} label={g.title} summary={g.ps.length} className="-ml-1.5 font-medium text-foreground" />
        {g.sharedWith && (
          <span className="shrink-0 text-caption text-muted-foreground" title="One value for these parts. A change here changes them all.">
            {sharedLabel(g.sharedWith, parts)}
          </span>
        )}
        {g.files.length > 0 && names && <span className="truncate font-mono text-micro text-faint">{g.files.join(", ")}</span>}
        <div className="flex-1" />
        {other && (
          <Button size="xs" variant="ghost" onClick={() => useStudio.getState().selectPart(other.id)} title={`These settings shape the ${other.name}. Select it to change them.`}>
            Select {other.name}
          </Button>
        )}
      </div>
      {open && <div className="pb-2">{children}</div>}
    </section>
  )
}

/**
 * Shared settings whose parts had different values before they were joined (older projects): what each part had and
 * the one value they all use now, until changed or dismissed.
 */
function SharedNotes({
  notes,
  ps,
  parts,
  onDismiss,
}: {
  notes: SharedParamNote[]
  ps: ScadParameter[]
  parts: { id: string; name: string }[]
  onDismiss: (name: string) => void
}) {
  const units = useUnits((s) => s.units)
  if (!notes.length) return null
  return (
    <div className="mb-1.5 flex flex-col gap-1">
      {notes.map((n) => {
        const p = ps.find((x) => x.name === n.name)
        const fmt = (v: Val) => (p && isLengthParam(p) && typeof v === "number" ? fmtLen(v, units) : String(v))
        const label = p ? splitUnit(paramLabel(p)).text : n.name
        const had = Object.entries(n.was)
          .filter(([, v]) => v !== n.value)
          .map(([id, v]) => `${parts.find((x) => x.id === id)?.name ?? id} had ${fmt(v)}`)
        return (
          <div key={n.name} className="flex items-center gap-2 text-caption text-muted-foreground">
            <span className="min-w-0 flex-1">
              {label}: {had.join(", ")}. Now {fmt(n.value)} for all.
            </span>
            <Button size="xs" variant="ghost" onClick={() => onDismiss(n.name)}>
              OK
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/** How many settings the Overview shows before "All settings". */
const FIRST = 3

/**
 * U2: the Overview's "Change size": the easiest way to make a design yours, no designer needed. The first few
 * settings show; the rest open in place. Renders nothing for a part without settings.
 */
export function ChangeSize({ projectId, parts }: { projectId: string; parts: { id: string; name: string }[] }) {
  const selected = useStudio((s) => s.selectedPartId)
  const partId = parts.some((p) => p.id === selected) ? selected : (parts[0]?.id ?? null)
  // keyed by part: values and definitions reset per part
  return <ChangeSizeFor key={partId ?? ""} projectId={projectId} partId={partId} parts={parts} />
}

function ChangeSizeFor({ projectId, partId, parts }: { projectId: string; partId: string | null; parts: { id: string; name: string }[] }) {
  const c = useCustomizer(projectId, partId)
  const [all, setAll] = useRemembered("overview-size")
  // this part's own sections first, so the first few are about it
  const ordered = useMemo(() => groupParams(c.params ?? [], parts, partId).flatMap((g) => g.ps), [c.params, parts, partId])
  if (!partId || !ordered.length) return null
  const shown = all ? ordered : ordered.slice(0, FIRST)
  const more = ordered.length - FIRST
  return (
    <section className="col-span-12 flex min-w-0 flex-col gap-1.5" aria-labelledby="change-size">
      <div className="flex h-7 items-center gap-2">
        <h2 id="change-size" className="text-xs font-medium text-foreground">
          Change size
        </h2>
        {parts.length > 1 && (
          <OptionSelect
            aria-label="Part"
            className="h-6 max-w-40 text-caption"
            value={partId}
            onChange={(id) => useStudio.getState().selectPart(id)}
            options={parts.map((p) => ({ value: p.id, label: p.name }))}
          />
        )}
        {c.rendering && <Loader2Icon className="size-3 animate-spin text-muted-foreground" aria-label="Updating" />}
        <div className="flex-1" />
        <Button size="xs" variant="ghost" disabled={!c.dirty} onClick={c.reset} title="Back to the design's own sizes">
          <RotateCcwIcon /> Reset
        </Button>
      </div>
      <div className="rounded-lg border bg-card px-3 py-2.5">
        <ParamGrid wide>
          {shown.map((p) => (
            <ParamRow
              key={p.name}
              p={p}
              value={c.overrides[p.name] ?? p.value}
              changed={p.name in c.overrides}
              onChange={(v) => c.setVal(p.name, v)}
              onReset={() => c.resetOne(p.name)}
              names={false}
              shared={p.sharedWith ? sharedLabel(p.sharedWith, parts) : undefined}
            />
          ))}
        </ParamGrid>
        {more > 0 && (
          <DetailsToggle open={all} onToggle={() => setAll((a) => !a)} label="All settings" summary={ordered.length} className="mt-1.5 -ml-1.5" />
        )}
      </div>
    </section>
  )
}

function ParamGrid({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  // label (wraps) · slider (capped, so it never spans a wide panel) · value with its unit and a reset
  return (
    <div className={cn("grid items-center gap-x-3 gap-y-1.5", wide ? "grid-cols-[minmax(8rem,16rem)_minmax(6rem,20rem)_auto]" : "grid-cols-[minmax(7rem,13rem)_minmax(5rem,16rem)_auto]")}>
      {children}
    </div>
  )
}

/** The number box, its unit beside it, and a reset once the value is changed (a blank keeps the column aligned). */
function ValueCell({ children, unit, changed, onReset, label }: { children?: React.ReactNode; unit?: string | null; changed: boolean; onReset?: () => void; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <div className="w-16">{children}</div>
      <span className="w-5 text-micro text-muted-foreground">{unit ?? ""}</span>
      {changed && onReset ? (
        <Button size="icon-xs" variant="ghost" onClick={onReset} title="Back to the design's value" aria-label={`Reset ${label}`}>
          <RotateCcwIcon />
        </Button>
      ) : (
        <span className="size-6" aria-hidden />
      )}
    </div>
  )
}

/** A length setting in inches: slider + box in inches (fractions like 2 1/2 or 1/16 work in the box), mm to the design. */
function LengthRow({
  id,
  label,
  words,
  mm,
  range,
  onChange,
  changed,
  onReset,
}: {
  id: string
  label: React.ReactNode
  words: string
  mm: number
  range: { min: number; max: number; step: number }
  onChange: (v: Val) => void
  changed: boolean
  onReset?: () => void
}) {
  const r = sliderRange(range, "in")
  const shown = toUnit(mm, "in")
  const text = lenNumber(mm, "in")
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    const v = parseLen(draft, "in")
    setDraft(null)
    if (v != null) onChange(fromUnit(v, "mm", { min: range.min, max: range.max }))
  }
  return (
    <>
      {label}
      <Slider
        aria-label={`${words} (inches)`}
        min={r.min}
        max={r.max}
        step={r.step}
        value={[Math.min(r.max, Math.max(r.min, shown))]}
        onValueChange={(v) => onChange(fromUnit(Array.isArray(v) ? v[0] : (v as number), "in", { min: range.min, max: range.max }))}
      />
      <ValueCell unit="in" changed={changed} onReset={onReset} label={words}>
        <Input
          id={id}
          inputMode="decimal"
          className="h-6 px-1 text-right text-caption"
          value={draft ?? text}
          title={`${Math.round(mm * 100) / 100} mm`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") setDraft(null)
          }}
        />
      </ValueCell>
    </>
  )
}

/** A text setting: applied on Enter or when the box loses focus; Escape puts the saved text back. */
function TextValue({ id, value, onChange }: { id: string; value: string; onChange: (v: Val) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft == null) return
    setDraft(null)
    if (draft !== value) onChange(draft)
  }
  return (
    <Input
      id={id}
      className="h-6 px-1 text-xs"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault()
          commit()
        }
        if (e.key === "Escape") setDraft(null)
      }}
    />
  )
}

function ParamRow({
  p,
  value,
  changed,
  onChange,
  onReset,
  names,
  shared,
}: {
  p: ScadParameter
  value: Val
  changed: boolean
  onChange: (v: Val) => void
  onReset?: () => void
  names: boolean
  /** a shared setting in a section that isn't all shared: the parts it changes ("Pot and saucer") */
  shared?: string
}) {
  const units = useUnits((s) => s.units)
  const inches = units === "in" && isLengthParam(p)
  const { text: words, unit } = splitUnit(labelInUnits(paramLabel(p), isLengthParam(p) ? units : "mm"))
  const id = `param-${p.file ?? ""}-${p.name}`
  // simple: the plain description, wrapped (never cut off); Names (details): the variable name with the description
  // under it. A shared setting says which parts it changes, under the label.
  const sharedLine = shared && (
    <div className="font-sans text-micro text-muted-foreground" title="One value for these parts. A change here changes them all.">
      {shared}
    </div>
  )
  const label = names ? (
    <label htmlFor={id} className="min-w-0 font-mono text-caption leading-tight break-words" title={p.description ? `${p.name}: ${p.description}` : p.name}>
      <span className={changed ? "text-primary" : ""}>{p.name}</span>
      {p.description && <div className="font-sans text-micro text-muted-foreground">{p.description}</div>}
      {sharedLine}
    </label>
  ) : (
    <label htmlFor={id} className={cn("min-w-0 text-caption leading-tight break-words", changed && "text-primary")}>
      {words}
      {sharedLine}
    </label>
  )
  const cell = (box?: React.ReactNode) => (
    <ValueCell unit={unit} changed={changed} onReset={onReset} label={words}>
      {box}
    </ValueCell>
  )

  if (p.type === "boolean")
    return (
      <>
        {label}
        <div>
          <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(!!c)} />
        </div>
        {cell()}
      </>
    )

  if (p.type === "enum" && p.options?.length)
    return (
      <>
        {label}
        <OptionSelect
          id={id}
          className="h-6 w-full"
          value={String(value)}
          onChange={(v) => {
            const opt = p.options!.find((o) => String(o) === v)
            onChange(opt ?? v)
          }}
          options={p.options.map((o) => ({ value: String(o), label: String(o) }))}
        />
        {cell()}
      </>
    )

  if (p.type === "number") {
    const num = Number(value)
    const base = Number(p.value) || 1
    const min = p.min ?? Math.min(0, num)
    const max = p.max ?? Math.max(base * 2, num, 10)
    const step = p.step ?? (Number.isInteger(base) && Number.isInteger(min) && Number.isInteger(max) ? 1 : 0.1)
    // a length in inches: the slider and box show inches, the design still gets mm (shared/length.ts)
    if (inches) return <LengthRow id={id} label={label} words={words} mm={num} range={{ min, max, step }} onChange={onChange} changed={changed} onReset={onReset} />
    return (
      <>
        {label}
        <Slider aria-label={words} min={min} max={max} step={step} value={[num]} onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : (v as number))} />
        {cell(
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            className="h-6 px-1 text-right text-caption"
            value={String(num)}
            step={step}
            onChange={(e) => {
              const n = parseFloat(e.target.value)
              if (!isNaN(n)) onChange(n)
            }}
          />,
        )}
      </>
    )
  }

  return (
    <>
      {label}
      <TextValue id={id} value={String(value)} onChange={onChange} />
      {cell()}
    </>
  )
}
