// The designer's questions (Claude Code's AskUserQuestion) as a stepper: one question at a time, a tight list of
// options with the recommended one picked already, Back / Next, and "Use recommended" as a quiet shortcut.
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CheckIcon, ChevronLeftIcon, Loader2Icon, MessageCircleQuestionIcon, PauseIcon, PencilIcon, StarIcon } from "@/components/icons"
import type { AgentAnswers, AgentQuestion, AgentQuestionRequest } from "@shared/types"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"

const REC_RE = /\s*\((recommended)\)\s*$/i
const isRecommended = (q: AgentQuestion, i: number) =>
  q.options.some((o) => REC_RE.test(o.label)) ? REC_RE.test(q.options[i].label) : i === 0
const displayLabel = (label: string) => label.replace(REC_RE, "")
/** The model is told not to add "Other"; we always offer our own, so drop any it adds anyway. */
const visibleOptions = (q: AgentQuestion) => q.options.map((o, i) => ({ o, i })).filter(({ o }) => !/^other\b/i.test(o.label.trim()))
/** "Use recommended": every option marked recommended for multi-select, the recommended one otherwise. */
const recommendedAnswer = (q: AgentQuestion) => {
  const recs = q.options.filter((_, j) => isRecommended(q, j)).map((o) => displayLabel(o.label))
  if (!recs.length) return displayLabel(q.options[0]?.label ?? "")
  return q.multiSelect ? recs.join(", ") : recs[0]
}

/** Option preview HTML in a sandboxed iframe: no scripts, no network, no same-origin access. */
function Preview({ html, title }: { html: string; title: string }) {
  const doc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
      `<style>html,body{margin:0;height:100%;background:#fff;color:#111;font:14px system-ui,sans-serif}` +
      `body{display:flex;align-items:center;justify-content:center;overflow:hidden}` +
      `svg,img{max-width:100%;max-height:100%;height:auto}</style></head><body>${html}</body></html>`,
    [html],
  )
  return <iframe title={title} sandbox="" srcDoc={doc} className="pointer-events-none h-28 w-full border-0 bg-white" />
}

type Sel = { picked: string[]; other: string; otherOn: boolean }
/** Start with the recommended answer picked, so "Next" alone goes with it. */
const initialSel = (q: AgentQuestion): Sel => {
  const recs = visibleOptions(q).filter(({ i }) => isRecommended(q, i))
  const picked = (q.multiSelect ? recs : recs.slice(0, 1)).map(({ o }) => o.label)
  return { picked, other: "", otherOn: false }
}

function answerFor(q: AgentQuestion, s: Sel): string | null {
  // strip "(Recommended)" from every picked label, not just the end of the joined string
  const parts = s.picked.map(displayLabel)
  if (s.otherOn && s.other.trim()) parts.push(s.other.trim())
  if (!parts.length) return null
  return q.multiSelect ? parts.join(", ") : parts[parts.length - 1]
}

function QuestionStep({ q, qi, sel, setSel }: { q: AgentQuestion; qi: number; sel: Sel; setSel: (s: Sel) => void }) {
  const opts = visibleOptions(q)
  const [hover, setHover] = useState<number | null>(null)
  const pickedIdx = q.options.findIndex((o) => sel.picked.includes(o.label))
  const shown = hover ?? pickedIdx
  const previewIdx =
    shown >= 0 && q.options[shown]?.preview
      ? shown
      : (opts.find(({ i }) => isRecommended(q, i) && q.options[i].preview)?.i ?? opts.find(({ o }) => o.preview)?.i)

  const toggle = (label: string) => {
    if (q.multiSelect) {
      const picked = sel.picked.includes(label) ? sel.picked.filter((x) => x !== label) : [...sel.picked, label]
      setSel({ ...sel, picked })
    } else setSel({ picked: [label], other: sel.other, otherOn: false })
  }

  return (
    <fieldset className="flex flex-col gap-1.5" aria-labelledby={`q-${qi}`}>
      <legend id={`q-${qi}`} className="mb-1 text-sm leading-snug font-medium text-foreground">
        {q.question}
        {q.multiSelect && <span className="ml-1 text-caption font-normal text-muted-foreground">(pick any)</span>}
      </legend>

      {previewIdx != null && previewIdx >= 0 && q.options[previewIdx]?.preview && (
        <div className="overflow-hidden border">
          <Preview html={q.options[previewIdx].preview!} title={`Picture of: ${displayLabel(q.options[previewIdx].label)}`} />
        </div>
      )}

      <div role={q.multiSelect ? "group" : "radiogroup"} className="flex flex-col overflow-hidden border border-line">
        {opts.map(({ o, i }) => {
          const on = sel.picked.includes(o.label)
          const rec = isRecommended(q, i)
          return (
            <button
              key={i}
              type="button"
              role={q.multiSelect ? "checkbox" : "radio"}
              aria-checked={on}
              title={o.description || undefined}
              onClick={() => toggle(o.label)}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-none border-b border-line px-2 py-1 text-left text-xs transition-colors outline-none last:border-b-0",
                "hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset",
                on ? "bg-primary/10 text-foreground" : "text-foreground/90",
              )}
            >
              <span
                className={cn(
                  "flex size-3.5 shrink-0 items-center justify-center border",
                  !q.multiSelect && "rounded-full",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/60",
                )}
              >
                {on && <CheckIcon className="size-2.5" />}
              </span>
              <span className="min-w-0 flex-1">{displayLabel(o.label)}</span>
              {rec && <StarIcon className="size-3 shrink-0 text-primary" aria-label="Recommended" />}
            </button>
          )
        })}

        {/* Free text */}
        {sel.otherOn ? (
          <div className="flex min-h-8 items-center gap-2 bg-primary/5 px-2">
            <PencilIcon className="size-3.5 shrink-0 text-primary" />
            <input
              autoFocus
              value={sel.other}
              onChange={(e) => setSel({ ...sel, other: e.target.value, picked: q.multiSelect ? sel.picked : [] })}
              placeholder="Your answer"
              aria-label={`Your own answer to: ${q.question}`}
              className="h-8 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setSel({ ...sel, otherOn: true, picked: q.multiSelect ? sel.picked : [] })}
            className="flex min-h-8 w-full items-center gap-2 rounded-none px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            <PencilIcon className="size-3.5 shrink-0" /> Something else
          </button>
        )}
      </div>
    </fieldset>
  )
}

export function QuestionCard({ projectId, request }: { projectId: string; request: AgentQuestionRequest }) {
  const qs = request.questions
  const [sels, setSels] = useState<Sel[]>(() => qs.map(initialSel))
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState<"send" | "decide" | "pause" | null>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [request.requestId])

  const q = qs[step]
  const last = step === qs.length - 1
  const current = answerFor(q, sels[step])

  const submit = async (a: AgentAnswers, notes: Record<string, string> | undefined, kind: "send" | "decide") => {
    setBusy(kind)
    try {
      await api.answerQuestion(projectId, request.requestId, a, notes)
    } catch (e) {
      toast.error("Couldn't send your answer", { description: errMsg(e) })
      setBusy(null)
    }
  }
  const send = () => {
    const a: AgentAnswers = {}
    qs.forEach((x, i) => {
      const v = answerFor(x, sels[i])
      if (v) a[x.question] = v
    })
    if (Object.keys(a).length === qs.length) void submit(a, undefined, "send")
  }
  const next = () => {
    if (!current) return
    if (last) send()
    else {
      setStep(step + 1)
      setTimeout(() => nextRef.current?.focus(), 0)
    }
  }
  const pause = async () => {
    setBusy("pause")
    try {
      await api.pauseAtQuestion(projectId, request.requestId)
    } catch (e) {
      toast.error("Couldn't pause", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  const decide = () => {
    const a: AgentAnswers = {}
    const notes: Record<string, string> = {}
    for (const x of qs) {
      a[x.question] = recommendedAnswer(x)
      notes[x.question] = "The user chose “You decide”: go with your recommendation."
    }
    void submit(a, notes, "decide")
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="The designer has a question"
      className="ps-enter flex flex-col gap-2 rounded-lg border border-primary/40 bg-card p-2.5"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          next()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-muted-foreground">
        <MessageCircleQuestionIcon className="size-3.5 shrink-0 text-primary" />
        <span>{qs.length > 1 ? `Question ${step + 1} of ${qs.length}` : "Question"}</span>
        {request.paused && (
          <span className="flex items-center gap-1" role="status" title="The designer waits for your answer or message.">
            <span aria-hidden className="text-faint">·</span>
            <PauseIcon className="size-3" /> Paused
          </span>
        )}
        {qs.length > 1 && (
          <span className="flex gap-0.5" aria-hidden>
            {qs.map((_, i) => (
              <i key={i} className={cn("h-1 w-3 rounded-full", i <= step ? "bg-primary" : "bg-line-strong")} />
            ))}
          </span>
        )}
        {/* the actions stay together; in a narrow panel they wrap under the label instead of clipping */}
        <div className="ml-auto flex items-center gap-1">
          {!request.paused && (
            <Button size="xs" variant="ghost" onClick={() => void pause()} disabled={!!busy} title="Stop for now. Answer when you're ready." className="text-muted-foreground">
              {busy === "pause" ? <Loader2Icon className="animate-spin" /> : <PauseIcon />}
              Pause
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={decide} disabled={!!busy} title="Go with the starred answers" className="text-muted-foreground">
            {busy === "decide" ? <Loader2Icon className="animate-spin" /> : <StarIcon className="text-primary" />}
            Use recommended
          </Button>
        </div>
      </div>

      <QuestionStep
        key={step}
        q={q}
        qi={step}
        sel={sels[step]}
        setSel={(s) => setSels((cur) => cur.map((x, j) => (j === step ? s : x)))}
      />

      <div className="flex items-center gap-1.5">
        {step > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setStep(step - 1)} disabled={!!busy}>
            <ChevronLeftIcon /> Back
          </Button>
        )}
        <div className="flex-1" />
        <Button ref={nextRef} size="sm" onClick={next} disabled={!current || !!busy}>
          {busy === "send" ? <Loader2Icon className="animate-spin" /> : last ? <CheckIcon /> : null}
          {last ? "Send" : "Next"}
        </Button>
      </div>
    </div>
  )
}
