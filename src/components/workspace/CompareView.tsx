// R22: compare two ideas (or two saved versions) side by side, in plain words: one summary line, same-camera
// pictures (or a 3D overlay: A as a ghost over B), what's different at a glance, parts, settings, the shopping list
// and the decisions only one side has. Read-only; the buttons open an idea or go back to a version.
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react"
import * as THREE from "three"
import { Canvas } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import { toast } from "sonner"
import type { CompareSide, IdeaComparison, Units } from "@shared/types"
import {
  ArrowRightIcon,
  BoxIcon,
  ColumnsIcon,
  CompareIcon,
  LightbulbIcon,
  Loader2Icon,
  MessageSquareIcon,
  OverlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UserIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CanvasGuard, loadRawModel, PartMaterial, type ModelPiece } from "@/components/viewer/shared"
import { askRestore, askTryIdea } from "@/components/versions"
import { api, errMsg } from "@/lib/api"
import { fmtDuration, fmtRelative } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useStagePalette } from "@/lib/stage"
import { useUnits } from "@/lib/units"
import { fmtDims, fmtLenDelta, unitLabel } from "@shared/length"
import { useStudio } from "@/stores/studio"

const SHARED = "(shared)"
const size3 = (v: [number, number, number] | null | undefined, units: Units) => (v ? fmtDims(v, units) : "—")
const signed = (v: number, unit: string, digits = 0) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}${unit}`
const usd = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`)
const val = (v: unknown) => (v == null ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v))

/** The default pair: the open idea vs the most recently changed other idea; one idea: its previous version vs now. */
function defaultPick(ideas: { branch: string; current: boolean; tip: { date: string } }[], versions: { commit: string }[]): { a: string; b: string } | null {
  const cur = ideas.find((i) => i.current)
  const other = ideas.filter((i) => !i.current).sort((x, y) => y.tip.date.localeCompare(x.tip.date))[0]
  if (cur && other) return { a: other.branch, b: cur.branch }
  if (versions.length > 1) return { a: versions[1].commit, b: "current" }
  return null
}

export function CompareView({ projectId }: { projectId: string }) {
  const ideas = useStudio((s) => s.ideas[projectId])
  const versions = useStudio((s) => s.checkpoints[projectId])
  const stored = useStudio((s) => s.comparePick[projectId])
  const openCompare = useStudio((s) => s.openCompare)
  const pick = stored ?? defaultPick(ideas?.ideas ?? [], versions?.list ?? [])
  const [mode, setMode] = useState<"side" | "overlay">("side")
  const [data, setData] = useState<{ key: string; c: IdeaComparison | null; error: string | null } | null>(null)
  // refetch when either side may have moved (a new version on an idea, a switch)
  const stamp = `${ideas?.ideas.map((i) => i.tip.commit).join(",")}|${versions?.list[0]?.commit ?? ""}|${ideas?.current ?? ""}`
  const key = pick ? `${pick.a}|${pick.b}|${stamp}` : ""

  useEffect(() => {
    if (!pick) return
    let live = true
    api
      .compare(projectId, pick.a, pick.b)
      .then((c) => live && setData({ key, c, error: null }))
      .catch((e) => live && setData({ key, c: null, error: errMsg(e) }))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, key])

  if (!pick)
    return (
      <Empty>
        Nothing to compare yet. Use <b>Try another idea</b> (the light bulb) to make a second version of the design, or save a few versions first —
        then compare them here.
      </Empty>
    )
  const loading = !data || data.key !== key
  const c = data?.c && !loading ? data.c : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Picker projectId={projectId} letter="A" value={pick.a} onChange={(a) => openCompare(projectId, a, pick.b)} />
          <Button size="icon-sm" variant="ghost" title="Swap A and B" aria-label="Swap A and B" onClick={() => openCompare(projectId, pick.b, pick.a)}>
            <CompareIcon />
          </Button>
          <Picker projectId={projectId} letter="B" value={pick.b} onChange={(b) => openCompare(projectId, pick.a, b)} />
          <div className="flex-1" />
          <div className="flex gap-px rounded-md border p-px" role="group" aria-label="How to show them">
            <ModeButton on={mode === "side"} onClick={() => setMode("side")} icon={<ColumnsIcon />} label="Side by side" />
            <ModeButton on={mode === "overlay"} onClick={() => setMode("overlay")} icon={<OverlayIcon />} label="Overlay" />
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 border bg-card p-3 text-xs text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Building both side by side… (a first comparison takes a few seconds)
          </div>
        )}
        {!loading && data?.error && (
          <div className="flex items-center gap-2 border border-err/50 bg-err/10 p-3 text-xs text-err">
            <TriangleAlertIcon className="size-4" /> Couldn't compare them: {data.error}
          </div>
        )}
        {c && <Comparison projectId={projectId} c={c} mode={mode} />}
      </div>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-sm text-center text-xs text-muted-foreground">
        <LightbulbIcon className="mx-auto mb-2 size-8 text-warn/70" />
        {children}
      </div>
    </div>
  )
}

function ModeButton({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn("flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-caption [&_svg]:size-3.5", on ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {icon}
      {label}
    </button>
  )
}

const LETTER_CLS = { A: "bg-info text-background", B: "bg-primary text-primary-foreground" } as const

function Letter({ l, className }: { l: "A" | "B"; className?: string }) {
  return <span className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-micro font-semibold", LETTER_CLS[l], className)}>{l}</span>
}

function Picker({ projectId, letter, value, onChange }: { projectId: string; letter: "A" | "B"; value: string; onChange: (v: string) => void }) {
  const ideas = useStudio((s) => s.ideas[projectId])
  const versions = useStudio((s) => s.checkpoints[projectId])
  // value -> label for the trigger (the list below groups the same entries)
  const items = useMemo(() => {
    const out: { value: string; label: string }[] = [{ value: "current", label: "Now · the open design" }]
    for (const i of ideas?.ideas ?? []) out.push({ value: i.branch, label: `${i.name}${i.current ? " (open)" : ""}` })
    for (const v of (versions?.list ?? []).slice(0, 20)) out.push({ value: v.commit, label: `“${v.message || "Saved version"}” · ${fmtRelative(v.date)}` })
    if (!out.some((o) => o.value === value)) out.push({ value, label: /^[0-9a-f]{7,40}$/.test(value) ? `Saved version ${value.slice(0, 7)}` : value })
    return out
  }, [ideas, versions, value])
  const currentIdea = ideas?.ideas.find((i) => i.current)?.name
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Letter l={letter} />
      <Select items={items} value={value} onValueChange={(v) => v && onChange(v as string)}>
        <SelectTrigger className="w-64 max-w-[40vw]" aria-label={`Compare ${letter}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value="current">Now · the open design</SelectItem>
          {(ideas?.ideas.length ?? 0) > 0 && (
            <SelectGroup>
              <SelectLabel>Ideas</SelectLabel>
              {ideas!.ideas.map((i) => (
                <SelectItem key={i.branch} value={i.branch}>
                  {i.name}
                  {i.current ? " (open)" : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          {(versions?.list.length ?? 0) > 0 && (
            <SelectGroup>
              <SelectLabel>Saved versions{currentIdea ? ` of ${currentIdea}` : ""}</SelectLabel>
              {versions!.list.slice(0, 20).map((v) => (
                <SelectItem key={v.commit} value={v.commit}>
                  “{v.message || "Saved version"}” · {fmtRelative(v.date)}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function Comparison({ projectId, c, mode }: { projectId: string; c: IdeaComparison; mode: "side" | "overlay" }) {
  return (
    <>
      <section aria-label="Summary" className="border border-primary/40 bg-primary/[0.06] p-3">
        <p className="text-sm text-foreground">{c.summary}</p>
        {c.notes.length > 0 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {c.notes.map((n) => (
              <li key={n} className="text-caption text-muted-foreground">
                {n}
              </li>
            ))}
          </ul>
        )}
      </section>

      {mode === "side" ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Picture projectId={projectId} side={c.a} letter="A" />
          <Picture projectId={projectId} side={c.b} letter="B" />
        </div>
      ) : (
        <Overlay c={c} />
      )}

      <Glance c={c} />
      <div className="grid gap-5 md:grid-cols-2">
        <Parts c={c} />
        <Settings c={c} />
        <Shopping c={c} />
      </div>
      <Decisions c={c} />
      <Designers c={c} />
    </>
  )
}

function Picture({ projectId, side, letter }: { projectId: string; side: CompareSide; letter: "A" | "B" }) {
  const units = useUnits((s) => s.units)
  const ideas = useStudio((s) => s.ideas[projectId])
  const switchIdea = useStudio((s) => s.switchIdea)
  const [busy, setBusy] = useState(false)
  const r = side.ref
  const isOpen = !!ideas?.ideas.find((i) => i.current && i.branch === r.branch)
  const openIdea = async () => {
    if (!r.branch) return
    if (useStudio.getState().agent[projectId]?.running) return void toast("The designer is working", { description: "Stop it first, then open another idea." })
    setBusy(true)
    try {
      await switchIdea(projectId, r.branch)
      toast.success(`Now on: ${r.idea ?? "that idea"}`, { description: "Its files and its own chat are back." })
    } catch (e) {
      toast.error("Couldn't open that idea", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-lg border bg-stage">
        {side.imageUrl ? <img src={side.imageUrl} alt={`${letter}: ${r.label}`} className="size-full object-contain" /> : <BoxIcon className="size-12 text-faint/50" />}
        <span className="absolute top-2 left-2 flex items-center gap-1.5">
          <Letter l={letter} />
          {r.unsaved && <span className="rounded-sm bg-warn px-1.5 py-0.5 text-micro text-background">unsaved changes</span>}
        </span>
        {side.size && (
          <span className="absolute right-2 bottom-2 rounded-sm bg-surface-1/90 px-1.5 py-0.5 text-micro text-foreground">{size3(side.size.mm, units)}</span>
        )}
      </div>
      <figcaption className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{r.label}</div>
          <div className="truncate text-micro text-muted-foreground" title={`${r.message}\n${new Date(r.date).toLocaleString()}\nversion ${r.short}`}>
            {r.kind === "version" ? (r.idea ? `saved version in ${r.idea}` : "saved version") : r.kind === "current" ? "the open design" : "idea, newest version"} · {fmtRelative(r.date)} ·{" "}
            {r.short}
          </div>
        </div>
        {r.kind !== "version" && r.branch && !isOpen && (
          <Button size="xs" variant="outline" onClick={() => void openIdea()} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <ArrowRightIcon />} Open this idea
          </Button>
        )}
        {r.kind === "version" && isOpen && (
          <Button size="xs" variant="outline" onClick={() => askRestore(projectId, r.commit, r.message)}>
            <RotateCcwIcon /> Go back to this
          </Button>
        )}
        {r.kind === "version" && (
          <Button size="xs" variant="ghost" onClick={() => askTryIdea(projectId, r.commit, r.message)} title="Start a separate idea from this version">
            <LightbulbIcon /> New idea from here
          </Button>
        )}
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------------------------------------

function useScene(url: string | null) {
  const [pieces, setPieces] = useState<{ url: string; pieces: ModelPiece[] } | null>(null)
  useEffect(() => {
    if (!url) return
    let live = true
    loadRawModel(url)
      .then((p) => live && setPieces({ url, pieces: p }))
      .catch(() => live && setPieces({ url, pieces: [] }))
    return () => {
      live = false
    }
  }, [url])
  return url && pieces?.url === url ? pieces.pieces : null
}

function Overlay({ c }: { c: IdeaComparison }) {
  const a = useScene(c.a.modelUrl)
  const b = useScene(c.b.modelUrl)
  const pal = useStagePalette()
  const f = c.frame
  if (!f || (!c.a.modelUrl && !c.b.modelUrl))
    return <div className="border bg-card p-3 text-xs text-muted-foreground">No 3D model to overlay for these two.</div>
  const dist = Math.max(40, f.radius) / Math.sin((35 * Math.PI) / 360) * 1.1
  const dir = new THREE.Vector3(0.75, -1.3, 1).normalize().multiplyScalar(dist)
  const off: [number, number, number] = [-f.center[0], -f.center[1], -f.floorZ]
  const h = f.radius
  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-[16/9] overflow-hidden rounded-lg border ps-stage">
        {(!a || !b) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" /> Loading both models…
          </div>
        )}
        <Canvas camera={{ position: [dir.x, dir.y, dir.z + h / 2], fov: 35, near: 0.5, far: dist * 20, up: [0, 0, 1] }} dpr={[1, 2]}>
          <CanvasGuard />
          <ambientLight intensity={0.4} />
          <hemisphereLight args={["#ffffff", "#3b4758", 1.1]} />
          <directionalLight position={[200, -300, 400]} intensity={1.8} />
          <Suspense fallback={null}>
            <group position={off}>
              {b?.map((p, i) => (
                <mesh key={`b${i}`} geometry={p.geometry} renderOrder={1}>
                  <PartMaterial color={p.color ?? "#d9dde5"} />
                </mesh>
              ))}
              {a?.map((p, i) => (
                <mesh key={`a${i}`} geometry={p.geometry} renderOrder={2}>
                  <meshBasicMaterial color="#4cc3ff" transparent opacity={0.16} depthWrite={false} depthTest={false} />
                </mesh>
              ))}
              {a?.map((p, i) => (
                <lineSegments key={`e${i}`} renderOrder={3}>
                  <edgesGeometry args={[p.geometry, 30]} />
                  <lineBasicMaterial color="#4cc3ff" transparent opacity={0.9} depthTest={false} />
                </lineSegments>
              ))}
            </group>
          </Suspense>
          <gridHelper args={[Math.ceil((h * 3) / 10) * 10, Math.ceil((h * 3) / 10), pal.gridMajor, pal.gridMinor]} rotation={[Math.PI / 2, 0, 0]} />
          <OrbitControls makeDefault target={[0, 0, h / 2]} />
        </Canvas>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Letter l="A" /> ghost: {c.a.ref.label}
        </span>
        <span className="flex items-center gap-1.5">
          <Letter l="B" /> solid: {c.b.ref.label}
        </span>
        <span>Drag to turn, scroll to zoom. Both sit where the design puts them.</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2 border-b pb-1">
        <h2 className="ps-label flex-1">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

function Delta({ v, unit, digits = 0, fmt }: { v: number | null; unit?: string; digits?: number; fmt?: (v: number) => string }) {
  if (v == null) return <span className="text-faint">—</span>
  if (Math.abs(v) < Math.pow(10, -digits) / 2) return <span className="text-faint">same</span>
  return <span className={cn("font-mono", v > 0 ? "text-warn" : "text-ok")}>{fmt ? fmt(v) : signed(v, unit ?? "", digits)}</span>
}

function Glance({ c }: { c: IdeaComparison }) {
  const units = useUnits((s) => s.units)
  const t = (s: CompareSide) => s.filament.adjustedS ?? s.filament.timeS
  const pieces = (s: CompareSide) => s.parts.reduce((n, p) => n + p.qty, 0)
  const rows: { label: string; a: ReactNode; b: ReactNode; d: ReactNode }[] = [
    {
      label: c.a.size?.basis === "assembled" ? "size, put together" : c.a.size?.basis === "laid-out" ? "parts side by side" : "size",
      a: size3(c.a.size?.mm, units),
      b: size3(c.b.size?.mm, units),
      d: c.diff.sizeMm ? <span className="font-mono">{c.diff.sizeMm.map((v) => (Math.abs(v) < 0.05 ? "0" : fmtLenDelta(v, units, false))).join(" × ")} {unitLabel(units)}</span> : <span className="text-faint">—</span>,
    },
    { label: "printed pieces", a: pieces(c.a), b: pieces(c.b), d: <Delta v={pieces(c.b) - pieces(c.a)} /> },
    {
      label: c.a.filament.basis === "sliced" ? "filament" : "filament (about)",
      a: c.a.filament.grams != null ? `${Math.round(c.a.filament.grams)} g` : "—",
      b: c.b.filament.grams != null ? `${Math.round(c.b.filament.grams)} g` : "—",
      d: <Delta v={c.diff.grams} unit=" g" />,
    },
    {
      label: c.a.filament.basis === "sliced" ? "print time" : "print time (about)",
      a: fmtDuration(t(c.a)),
      b: fmtDuration(t(c.b)),
      d: <Delta v={c.diff.timeS} fmt={(v) => `${v > 0 ? "+" : "−"}${fmtDuration(Math.abs(v))}`} />,
    },
    {
      label: "cost of supplies",
      a: usd(c.a.cost.totalUsd),
      b: usd(c.b.cost.totalUsd),
      d: <Delta v={c.diff.costUsd} digits={2} fmt={(v) => `${v > 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`} />,
    },
  ]
  return (
    <Section title="at a glance">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-micro text-muted-foreground">
            <th className="py-1 font-normal" />
            <th className="py-1 font-normal">
              <Letter l="A" className="mr-1" />
            </th>
            <th className="py-1 font-normal">
              <Letter l="B" className="mr-1" />
            </th>
            <th className="py-1 font-normal">B compared with A</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t">
              <td className="py-1.5 pr-2 text-muted-foreground">{r.label}</td>
              <td className="py-1.5 pr-2 font-mono">{r.a}</td>
              <td className="py-1.5 pr-2 font-mono">{r.b}</td>
              <td className="py-1.5">{r.d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-caption text-muted-foreground">
        {c.a.filament.basis === "sliced" ? "Filament and time from the slicer" : "Filament and time estimated from the shape"}
        {c.a.filament.calibratedPrints || c.b.filament.calibratedPrints ? ", adjusted by your real print times" : ""}. Cost = filament (about $20/kg) + things to buy.
      </p>
    </Section>
  )
}

const CHANGE: Record<string, { label: string; cls: string }> = {
  added: { label: "only in B", cls: "text-ok" },
  removed: { label: "only in A", cls: "text-err" },
  resized: { label: "new size", cls: "text-warn" },
  qty: { label: "how many", cls: "text-warn" },
  same: { label: "same", cls: "text-faint" },
  changed: { label: "how many", cls: "text-warn" },
}

function Parts({ c }: { c: IdeaComparison }) {
  const units = useUnits((s) => s.units)
  return (
    <Section title="parts">
      <ul className="flex flex-col gap-1">
        {c.diff.parts.map((p) => (
          <li key={p.id} className={cn("flex items-center gap-2 border bg-card px-2.5 py-1.5 text-xs", p.change === "same" && "opacity-60")}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{p.name}</span>
              <span className="text-micro text-muted-foreground">
                {p.change === "resized" ? `${size3(p.a, units)} → ${size3(p.b, units)}` : p.change === "qty" ? `×${p.qtyA} → ×${p.qtyB}` : size3(p.b ?? p.a, units)}
              </span>
            </span>
            <span className={cn("shrink-0 text-right text-micro whitespace-nowrap", CHANGE[p.change].cls)}>{CHANGE[p.change].label}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Settings({ c }: { c: IdeaComparison }) {
  const partName = (id: string) => (id === SHARED ? "shared" : (c.b.parts.find((p) => p.id === id) ?? c.a.parts.find((p) => p.id === id))?.name ?? id)
  return (
    <Section title="settings that differ">
      {c.diff.params.length === 0 ? (
        <p className="text-xs text-muted-foreground">No setting differs{c.diff.parts.some((p) => p.change !== "same") ? " (the changes are in the shape itself)" : ""}.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {c.diff.params.map((p) => (
              <tr key={`${p.partId}.${p.name}`} className="border-t first:border-t-0">
                <td className="py-1.5 pr-2">
                  <div className="text-foreground">{p.description ?? p.name}</div>
                  <div className="font-mono text-micro text-muted-foreground">
                    {partName(p.partId)} · {p.name}
                  </div>
                </td>
                <td className="py-1.5 pr-2 text-right font-mono whitespace-nowrap">
                  <span className="text-muted-foreground">{val(p.a)}</span> <span className="text-faint">→</span> <span className="text-foreground">{val(p.b)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  )
}

function Shopping({ c }: { c: IdeaComparison }) {
  const buys = (s: CompareSide) => s.bom.filter((x) => x.category === "purchased" || x.category === "consumable").length
  return (
    <Section title="things to buy">
      {c.diff.bom.length === 0 ? (
        <p className="text-xs text-muted-foreground">{buys(c.a) || buys(c.b) ? "Same shopping list." : "Nothing to buy for either."}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {c.diff.bom.map((x) => (
            <li key={x.key} className="flex items-center gap-2 border bg-card px-2.5 py-1.5 text-xs">
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              <span className="text-micro text-muted-foreground">
                {x.change === "changed" ? `${val(x.a)} → ${val(x.b)}` : x.change === "added" ? `${val(x.b)}` : `${val(x.a)}`}
              </span>
              <span className={cn("shrink-0 text-right text-micro whitespace-nowrap", CHANGE[x.change].cls)}>{CHANGE[x.change].label}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

const DECISION_ICON = { plan: <SparklesIcon className="size-3.5 text-primary" />, ask: <UserIcon className="size-3.5" />, change: <MessageSquareIcon className="size-3.5 text-muted-foreground" /> }
const DECISION_TITLE = { plan: "The designer's plan", ask: "You asked", change: "Saved change" }

function Decisions({ c }: { c: IdeaComparison }) {
  const col = (s: CompareSide, l: "A" | "B") => (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Letter l={l} /> only in {s.ref.label}
      </div>
      {s.decisions.length === 0 ? (
        <p className="text-caption text-faint">Nothing of its own.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {s.decisions.map((d, i) => (
            <li key={i} className="flex gap-1.5 text-xs" title={`${DECISION_TITLE[d.kind]} · ${new Date(d.at).toLocaleString()}`}>
              <span className="mt-0.5 shrink-0">{DECISION_ICON[d.kind]}</span>
              <span className={cn("min-w-0", d.kind === "ask" && "italic text-muted-foreground")}>{d.kind === "ask" ? `“${d.text}”` : d.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <Section title="why they differ">
      <div className="grid gap-3 sm:grid-cols-2">
        {col(c.a, "A")}
        {col(c.b, "B")}
      </div>
    </Section>
  )
}

const COST_LABEL = { known: "billed", estimated: "estimated", unknown: "cost not reported" } as const

/** R11g: who designed each idea (runtime, model, version) and what that chat cost, labelled known / estimated / unknown. */
function Designers({ c }: { c: IdeaComparison }) {
  if (!c.a.designers?.length && !c.b.designers?.length) return null
  const col = (s: CompareSide, l: "A" | "B") => (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Letter l={l} /> {s.ref.label}
      </div>
      {s.designers.length === 0 ? (
        <p className="text-caption text-faint">No chat on this one.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {s.designers.map((d) => (
            <li key={d.sessionId} className="flex flex-col text-xs" title={d.title}>
              <span className="min-w-0 truncate">
                {d.designer ?? d.runtime}
                {d.model && <span className="text-muted-foreground"> · {d.model}</span>}
                {d.version && <span className="text-micro text-faint"> v{d.version}</span>}
              </span>
              <span className="font-mono text-micro text-muted-foreground">
                {d.designer == null && d.costUsd === 0 ? "no messages yet" : d.costUsd != null ? `$${d.costUsd.toFixed(2)} ${COST_LABEL[d.cost]}` : COST_LABEL.unknown}
                {d.handedOverFrom ? ` · started from ${d.handedOverFrom}'s summary` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <Section title="who designed it">
      <div className="grid gap-3 sm:grid-cols-2">
        {col(c.a, "A")}
        {col(c.b, "B")}
      </div>
    </Section>
  )
}
