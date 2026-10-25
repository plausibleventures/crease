import { useEffect, useMemo, useRef, useState } from "react"
import type { Assembly, AssemblyInfo, AssemblyStep } from "@shared/types"
import { toast } from "sonner"
import {
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  HammerIcon,
  ImageOffIcon,
  LightbulbIcon,

  Loader2Icon,
  FileTextIcon,
  RefreshCwIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/panel"
import { StaleNote } from "./StaleNote"
import { BomDialog } from "./BomDialog"
import { StepScene, hasPlacements } from "@/components/viewer/assembly"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"
import { instanceSteps, letterRange, partLetters } from "@shared/assembly-art"

const ASK_PROMPT =
  "Write an assembly guide for this project: create assembly.json (parts, hardware, tools, steps) and assembly.scad, render the steps, then build the guide."

type Mode = "guide" | "steps"

export function AssemblyView({ projectId }: { projectId: string }) {
  const info = useStudio((s) => s.assembly[projectId])
  const loadError = useStudio((s) => s.assemblyError[projectId])
  const loadAssembly = useStudio((s) => s.loadAssembly)
  const guideValidity = useStudio((s) => s.validity[projectId]?.assembly?.guide)
  const [mode, setMode] = useState<Mode>("guide")
  const [building, setBuilding] = useState(false)
  const [asking, setAsking] = useState(false)
  const [shopOpen, setShopOpen] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const ask = async (text: string) => {
    setAsking(true)
    try {
      const r = await api.sendMessage(projectId, text)
      useStudio.setState((s) => ({
        agent: { ...s.agent, [projectId]: { running: true, sessionId: r?.sessionId ?? null, costUsd: s.agent[projectId]?.costUsd ?? 0 } },
      }))
      toast("Sent to the agent", { description: "Follow along in the agent panel." })
    } catch (e) {
      toast.error("Couldn't send to agent", { description: errMsg(e) })
    } finally {
      setAsking(false)
    }
  }

  const build = async () => {
    setBuilding(true)
    try {
      const r = await api.buildAssemblyGuide(projectId)
      toast.success(`Guide built · ${r.steps} step${r.steps === 1 ? "" : "s"}`)
    } catch (e) {
      toast.error("Couldn't build guide", { description: errMsg(e) })
    } finally {
      setBuilding(false)
      void loadAssembly(projectId)
      useStudio.getState().loadValidity(projectId)
    }
  }

  const open = () => {
    if (info?.guideUrl) window.open(info.guideUrl, "_blank", "noopener")
  }
  const print = () => {
    if (!info?.guideUrl) return
    const w = mode === "guide" ? iframeRef.current?.contentWindow : null
    if (w) {
      w.focus()
      w.print()
      return
    }
    const win = window.open(info.guideUrl, "_blank")
    if (win) win.addEventListener("load", () => win.print(), { once: true })
  }

  if (info === undefined)
    return loadError ? (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="Couldn't load assembly"
        detail={loadError}
        action={
          <Button size="sm" variant="outline" onClick={() => void loadAssembly(projectId)}>
            Retry
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading assembly…" />
    )

  if (!info?.assembly) {
    const invalid = info?.error
    return (
      <EmptyState
        icon={invalid ? <TriangleAlertIcon /> : undefined}
        art={invalid ? undefined : "assembly"}
        title={invalid ? "assembly.json is invalid" : "No assembly guide yet"}
        detail={
          invalid ? (
            <span className="font-mono whitespace-pre-wrap">{invalid}</span>
          ) : (
            "Step-by-step pictures and a parts list."
          )
        }
        action={
          <Button size="sm" onClick={() => void ask(invalid ? `assembly.json fails validation: ${invalid}\nPlease fix it and rebuild the guide.` : ASK_PROMPT)} disabled={asking}>
            {asking ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}
            {invalid ? "Ask the agent to fix it" : "Ask the agent to write one"}
          </Button>
        }
      />
    )
  }

  const a = info.assembly
  const partQty = a.parts.reduce((n, p) => n + (p.qty || 0), 0)
  const hwQty = a.hardware.reduce((n, h) => n + (h.qty || 0), 0)

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden px-2 text-caption whitespace-nowrap">
        <span className="truncate font-medium">{a.title ?? "Assembly"}</span>
        <span className="truncate text-muted-foreground">
          {partQty} part{partQty === 1 ? "" : "s"} · {hwQty} hardware · {a.steps.length} step{a.steps.length === 1 ? "" : "s"}
          {a.timeMinutes ? ` · ~${a.timeMinutes} min` : ""}
        </span>
        <div className="flex-1" />
        <div className="flex shrink-0 gap-px rounded-full border p-px">
          {(["guide", "steps"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn("h-6 rounded-full px-2.5 whitespace-nowrap text-muted-foreground hover:text-foreground", mode === m && "bg-muted text-foreground")}
            >
              {m === "guide" ? "Guide" : "Step-through"}
            </button>
          ))}
        </div>
        <Button size="xs" variant="ghost" onClick={() => void build()} disabled={building} title="Render every step and write build/assembly-guide.html">
          {building ? <Loader2Icon className="animate-spin" /> : info.guideUrl ? <RefreshCwIcon /> : <HammerIcon />}
          {building ? "Building…" : info.guideUrl ? "Rebuild" : "Build guide"}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setShopOpen(true)}
          title="What to print, buy and make: tick what you already have"
        >
          <ShoppingCartIcon /> Shopping list
        </Button>
        <Button size="xs" variant="ghost" onClick={open} disabled={!info.guideUrl} title="Open in a new window">
          <ExternalLinkIcon /> Open
        </Button>
        <Button size="xs" variant="ghost" onClick={print} disabled={!info.guideUrl} title="Print the paper guide, or save it as a PDF">
          <FileTextIcon /> Print guide
        </Button>
      </div>
      <StaleNote validity={guideValidity} onRerun={() => void build()} busy={building} label="Rebuild guide" text="Out of date · rebuild the guide" />
      <BomDialog projectId={projectId} shoppingListUrl={info.shoppingListUrl} open={shopOpen} onOpenChange={setShopOpen} />
      <div className="relative min-h-0 flex-1">
        {mode === "steps" ? (
          <StepThrough assembly={a} info={info} projectId={projectId} />
        ) : info.guideUrl ? (
          <iframe ref={iframeRef} key={info.guideUrl} src={info.guideUrl} title="Assembly guide" className="absolute inset-x-2 top-0 bottom-2 h-[calc(100%-8px)] w-[calc(100%-16px)] rounded-2xl border-0 bg-white" />
        ) : (
          <EmptyState
            icon={building ? <Loader2Icon className="animate-spin" /> : <BookOpenIcon />}
            title={building ? "Rendering steps and building the guide…" : "Guide not built yet"}
            detail={building ? "This can take a minute." : "Ready to build the guide."}
            action={
              !building && (
                <Button size="sm" onClick={() => void build()}>
                  <HammerIcon /> Build guide
                </Button>
              )
            }
          />
        )}
      </div>
    </div>
  )
}

/**
 * Text that follows "You got it right when": drop a repeated prefix and lowercase the first letter
 * ("All five…" -> "all five…") unless it starts an acronym / code / name ("M3", "LED", "I", "PLA").
 */
export function checkClause(text: string): string {
  const t = text.trim().replace(/^(✓\s*)?you got it right when\s*:?\s*/i, "")
  const first = t.match(/^\S+/)?.[0] ?? ""
  const keep = /^I\b/.test(t) || /^[A-Z][A-Z0-9]/.test(first) || /\d/.test(first)
  return keep || !t ? t : t[0].toLowerCase() + t.slice(1)
}

/* ---------- native step-through (tablet friendly) ---------- */

function useItemNames(a: Assembly) {
  return useMemo(() => {
    const m = new Map<string, { label: string; color?: string; kind: "part" | "hardware" | "consumable" }>()
    for (const p of a.parts) m.set(p.id, { label: p.name ?? p.id, color: p.color, kind: "part" })
    for (const h of a.hardware) m.set(h.id, { label: h.name ?? [h.size, h.type].filter(Boolean).join(" "), color: h.color, kind: "hardware" })
    for (const c of a.consumables) m.set(c.id, { label: c.name, kind: "consumable" })
    return m
  }, [a])
}

function StepThrough({ assembly: a, info, projectId }: { assembly: Assembly; info: AssemblyInfo; projectId: string }) {
  const [i, setI] = useState(0) // 0 = "what you need", 1..N = steps
  const total = a.steps.length
  const idx = Math.min(i, total)
  const names = useItemNames(a)
  // part letters (as in the step pictures and on the plates) of the copies each step adds
  const stepLetters = useMemo(() => {
    const steps = instanceSteps(a)
    const letters = partLetters(a)
    return (n: number, id: string) => letterRange([...letters].filter(([k]) => k.startsWith(`${id}#`) && steps.get(k) === n).map(([, l]) => l))
  }, [a])
  // The finished-assembly picture (renders/assembly-complete.png) isn't listed in stepImages; point at it
  // directly (cache-busted by the guide/step version) and let StepImage fall back if it doesn't exist.
  const version = (info.guideUrl ?? info.stepImages[0]?.url ?? "").match(/[?&]v=([^&]+)/)?.[1] ?? ""
  const completeUrl = `/api/projects/${encodeURIComponent(projectId)}/artifacts/renders/assembly-complete.png?v=${version}`
  const live = hasPlacements(a) // placements known: show a live 3D view instead of the static render
  const imgFor = (n: number) => info.stepImages.find((s) => s.n === n)?.url ?? (n === 0 ? completeUrl : null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest("input, textarea, [contenteditable='true'], .monaco-editor")) return
      if (e.key === "ArrowRight" || e.key === "PageDown") setI((v) => Math.min(v + 1, total))
      if (e.key === "ArrowLeft" || e.key === "PageUp") setI((v) => Math.max(v - 1, 0))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [total])

  const step: AssemblyStep | null = idx > 0 ? (a.steps.find((s) => s.n === idx) ?? a.steps[idx - 1] ?? null) : null
  const toolName = (id: string) => a.tools.find((t) => t.id === id)?.name ?? id

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {step ? (
          <div className="mx-auto flex h-full max-w-5xl flex-col gap-3 p-4 lg:flex-row">
            {live ? (
              <StepScene
                projectId={projectId}
                info={info}
                step={step.n}
                className="min-h-72 lg:flex-[3]"
                fallback={<StepImage url={imgFor(step.n)} className="min-h-56 lg:flex-[3]" />}
              />
            ) : (
              <StepImage url={imgFor(step.n)} className="min-h-56 lg:flex-[3]" />
            )}
            <div className="flex flex-col gap-3 lg:flex-[2]">
              <div>
                <div className="ps-label">
                  Step {step.n} of {total}
                </div>
                <div className="text-lg font-semibold">{step.title}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {step.adds.map((it, k) => {
                  const id = typeof it === "string" ? it : it.id
                  const qty = typeof it === "string" ? null : it.qty
                  const n = names.get(id)
                  return (
                    <span key={k} className="flex items-center gap-1.5 border bg-card px-2 py-1 text-xs">
                      {n?.color && <span className="size-2.5 rounded-full border border-foreground/20" style={{ background: n.color }} />}
                      {qty != null && <span className="font-semibold">{qty}×</span>}
                      {stepLetters(step.n, id) && <span className="bg-foreground px-1 font-semibold text-background">{stepLetters(step.n, id)}</span>}
                      {n?.label ?? id}
                    </span>
                  )
                })}
              </div>
              <p className="text-base leading-relaxed">{step.text}</p>
              {step.check && (
                <div className="flex items-start gap-1.5 border border-ok/40 bg-ok/10 px-2 py-1.5 text-sm text-ok">
                  <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <span className="font-medium">You got it right when</span> {checkClause(step.check)}
                  </span>
                </div>
              )}
              {step.warnings?.map((w, k) => (
                <div key={k} className="flex items-start gap-1.5 border border-warn/40 bg-warn/10 px-2 py-1.5 text-sm text-warn">
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" /> {w}
                </div>
              ))}
              {step.tips?.map((w, k) => (
                <div key={k} className="flex items-start gap-1.5 text-sm text-muted-foreground">
                  <LightbulbIcon className="mt-0.5 size-4 shrink-0" /> {w}
                </div>
              ))}
              {step.tools && step.tools.length > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <WrenchIcon className="size-3.5" /> {step.tools.map(toolName).join(", ")}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4 lg:flex-row">
            {live ? (
              <StepScene
                projectId={projectId}
                info={info}
                step={0}
                className="min-h-72 lg:flex-[3]"
                fallback={<StepImage url={imgFor(0)} className="min-h-56 lg:flex-[3]" label="Finished assembly" />}
              />
            ) : (
              <StepImage url={imgFor(0)} className="min-h-56 lg:flex-[3]" label="Finished assembly" />
            )}
            <div className="flex flex-col gap-3 text-sm lg:flex-[2]">
              <div>
                <div className="ps-label">What you need</div>
                <div className="text-lg font-semibold">{a.title ?? "Assembly"}</div>
                {a.summary && <p className="text-muted-foreground">{a.summary}</p>}
              </div>
              <NeedList title="Printed parts" rows={a.parts.map((p) => ({ qty: p.qty, label: p.name ?? p.id, color: p.color, hint: p.notes }))} />
              <NeedList
                title="Hardware"
                rows={a.hardware.map((h) => ({ qty: h.qty, label: h.name ?? [h.size, h.type].filter(Boolean).join(" "), hint: h.purchaseHint ?? h.standard }))}
              />
              <NeedList title="Tools" rows={a.tools.map((t) => ({ label: t.name, hint: t.size }))} />
              <NeedList title="Consumables" rows={a.consumables.map((c) => ({ label: c.name, hint: c.qty }))} />
            </div>
          </div>
        )}
      </div>
      <div className="flex h-14 shrink-0 items-center gap-3 border-t px-3">
        <Button variant="outline" className="h-10 px-4" onClick={() => setI(Math.max(idx - 1, 0))} disabled={idx === 0}>
          <ChevronLeftIcon /> Back
        </Button>
        <div className="flex flex-1 flex-wrap items-center justify-center gap-1">
          {Array.from({ length: total + 1 }, (_, k) => (
            <button
              key={k}
              onClick={() => setI(k)}
              title={k === 0 ? "What you need" : `Step ${k}`}
              className={cn("size-2.5 rounded-full bg-muted-foreground/30 hover:bg-muted-foreground/60", k === idx && "bg-primary hover:bg-primary")}
            />
          ))}
        </div>
        <Button className="h-10 min-w-36 px-6 text-sm" onClick={() => setI(Math.min(idx + 1, total))} disabled={idx >= total}>
          {idx === 0 ? "Start" : idx >= total ? "Done" : "Next"} <ChevronRightIcon />
        </Button>
      </div>
    </div>
  )
}

function StepImage({ url, className, label }: { url: string | null; className?: string; label?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden border bg-white", className)}>
      {url && failed !== url ? (
        <img src={url} alt={label ?? ""} className="max-h-[60vh] w-full object-contain" onError={() => setFailed(url)} />
      ) : (
        <div className="flex flex-col items-center gap-1 p-6 text-xs text-faint">
          <ImageOffIcon className="size-6 opacity-60" />
          Not rendered yet. Use Build guide.
        </div>
      )}
    </div>
  )
}

function NeedList({ title, rows }: { title: string; rows: { qty?: number; label: string; color?: string; hint?: string }[] }) {
  if (!rows.length) return null
  return (
    <div>
      <div className="ps-label mb-1">{title}</div>
      <div className="flex flex-col divide-y border">
        {rows.map((r, k) => (
          <div key={k} className="flex items-center gap-2 px-2 py-1">
            {r.qty != null && <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{r.qty}×</span>}
            {r.color && <span className="size-2.5 shrink-0 rounded-full border border-foreground/20" style={{ background: r.color }} />}
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            {r.hint && <span className="truncate text-caption text-muted-foreground">{r.hint}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
