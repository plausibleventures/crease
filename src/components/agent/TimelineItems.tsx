import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react"
import { HandoffRow } from "./HandoffDialog"
import {
  AlertTriangleIcon,
  LightbulbIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  MapPinIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CircleDollarSignIcon,
  FileEditIcon,
  FileTextIcon,
  ImageIcon,
  PauseIcon,
  InfoIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  Loader2Icon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "@/components/icons"
import { relPaths, relPathsDeep, type TimelineItem, type ToolImage } from "@/lib/timeline"
import { friendlyTool, toolOutcome, type ToolItem } from "@/lib/tool-rows"
import { fmtMs } from "@/lib/format"
import { Cost } from "./Cost"
import { cn } from "@/lib/utils"
import { Markdownish } from "./Markdownish"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { askRestore, askTryIdea } from "@/components/versions"
import { useStudio } from "@/stores/studio"

/* eslint-disable @typescript-eslint/no-explicit-any */

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return now
}

function prettyToolName(name: string) {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
  if (m) return { short: m[2], server: m[1] }
  return { short: name, server: null as string | null }
}

/** Spool-palette meaning of a tool: designer edits blue, renders/prints mint, checks yellow, assembly lime. */
function toolHue(name: string): string {
  const n = name.toLowerCase()
  if (n === "edit" || n === "multiedit" || n === "write") return "var(--primary)"
  if (n.includes("check")) return "var(--warn)"
  if (n.includes("render") || n.includes("slice") || n.includes("print")) return "var(--ok)"
  if (n.includes("assembly") || n.includes("motion")) return "var(--move)"
  return "var(--muted-foreground)"
}

function toolIcon(name: string) {
  const n = name.toLowerCase()
  if (n === "edit" || n === "multiedit" || n === "write") return <FileEditIcon />
  if (n === "read") return <FileTextIcon />
  if (n === "glob" || n === "grep") return <SearchIcon />
  if (n === "bash") return <TerminalIcon />
  if (n.includes("render")) return <ImageIcon />
  return <WrenchIcon />
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const o = input as Record<string, any>
  for (const k of ["file_path", "path", "partId", "part_id", "part", "pattern", "command", "message", "description", "url", "query"]) {
    if (typeof o[k] === "string" && o[k]) return o[k]
  }
  const first = Object.entries(o).find(([, v]) => typeof v === "string" || typeof v === "number")
  return first ? `${first[0]}=${String(first[1])}` : ""
}

function imgSrc(i: ToolImage) {
  return i.url ?? `data:${i.mediaType};base64,${i.data}`
}

function Json({ value }: { value: unknown }) {
  let s: string
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  } catch {
    s = String(value)
  }
  return <pre className="max-h-64 overflow-auto rounded-sm bg-background/60 p-1.5 font-mono text-micro leading-snug whitespace-pre-wrap break-all">{s}</pre>
}

function Diff({ oldS, newS }: { oldS: string; newS: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-sm bg-background/60 font-mono text-micro leading-snug">
      {oldS.split("\n").map((l, i) => (
        <div key={`o${i}`} className="bg-err/10 px-1.5 text-err whitespace-pre-wrap">
          - {l}
        </div>
      ))}
      {newS.split("\n").map((l, i) => (
        <div key={`n${i}`} className="bg-ok/10 px-1.5 text-ok whitespace-pre-wrap">
          + {l}
        </div>
      ))}
    </pre>
  )
}

function ToolInputView({ name, input, partial }: { name: string; input: unknown; partial: string }) {
  const o = (input ?? {}) as Record<string, any>
  const n = name.toLowerCase()
  if (n === "edit" && typeof o.old_string === "string" && typeof o.new_string === "string") return <Diff oldS={o.old_string} newS={o.new_string} />
  if (n === "multiedit" && Array.isArray(o.edits))
    return (
      <div className="flex flex-col gap-1">
        {o.edits.map((e: any, i: number) => (
          <Diff key={i} oldS={String(e?.old_string ?? "")} newS={String(e?.new_string ?? "")} />
        ))}
      </div>
    )
  if (n === "write" && typeof o.content === "string")
    return (
      <pre className="max-h-72 overflow-auto rounded-sm bg-background/60 p-1.5 font-mono text-micro leading-snug">
        {o.content.split("\n").map((l: string, i: number) => (
          <div key={i} className="text-ok">
            + {l}
          </div>
        ))}
      </pre>
    )
  if (input === undefined) return partial ? <Json value={partial} /> : null
  return <Json value={input} />
}

/** Version saved by the designer: "Go back" / "Try another idea from here". */
function CheckpointActions({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const projectId = useStudio((s) => s.project?.id)
  const versions = useStudio((s) => (s.project ? s.checkpoints[s.project.id] : undefined))
  const commit = item.resultText.match(/"commit"\s*:\s*"([0-9a-f]{7,40})"/)?.[1] ?? item.resultText.match(/\b[0-9a-f]{40}\b/)?.[0]
  if (!projectId || !commit) return null
  const input = (item.input ?? {}) as { message?: unknown }
  const label = typeof input.message === "string" ? input.message.replace(/^(agent|user):\s*/, "") : "this version"
  const isCurrent = versions?.list[0]?.commit === commit
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="icon-xs" variant="ghost" title="Version options" aria-label="Version options" onClick={(e) => e.stopPropagation()} />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!isCurrent && (
          <DropdownMenuItem onClick={() => askRestore(projectId, commit, label)}>
            <RotateCcwIcon /> Go back to this version
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => askTryIdea(projectId, isCurrent ? undefined : commit, label)}>
          <LightbulbIcon /> Try another idea from here
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** ✓ done, ✗ failed, a pause mark while the app holds the step back (it is not an error), a spinner while running. */
function OutcomeIcon({ state }: { state: ReturnType<typeof toolOutcome>["state"] }) {
  if (state === "running") return <Loader2Icon className="animate-spin text-primary" />
  if (state === "failed") return <XIcon className="text-err" />
  if (state === "waiting") return <PauseIcon className="text-muted-foreground" />
  return <CheckIcon className="text-ok" />
}

/** The same step several times in a row ("Sliced ×3"): one line; the steps on click. The newest pictures stay. */
export function ToolGroupRow({ label, items, onImage }: { label: string; items: ToolItem[]; onImage: (src: string) => void }) {
  const [open, setOpen] = useState(false)
  const last = items[items.length - 1]
  const outcome = toolOutcome(last)
  const { short } = prettyToolName(last.name)
  return (
    <div className={cn(open && "border border-line bg-surface-2", last.sub && "ml-3")}>
      <button
        className="flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground hover:bg-surface-3"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={outcome.reason ?? undefined}
      >
        <span className="shrink-0 [&_svg]:size-3" style={{ color: toolHue(short) }}>
          {toolIcon(short)}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-caption">
          <span className="shrink-0">{outcome.state === "done" ? label : friendlyTool(short, false)}</span>
          <span className="shrink-0 text-micro">×{items.length}</span>
          {outcome.reason && <span className={cn("min-w-0 truncate", outcome.state === "failed" ? "text-err" : "text-foreground/80")}>· {outcome.reason}</span>}
        </span>
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 [&_svg]:size-3">
          <OutcomeIcon state={outcome.state} />
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-0.5 border-t p-1">
          {items.map((it) => (
            <ToolRow key={it.key} item={{ ...it, sub: false }} onImage={onImage} />
          ))}
        </div>
      ) : (
        last.images.length > 0 && <ToolImages images={last.images} onImage={onImage} />
      )}
    </div>
  )
}

function ToolImages({ images, onImage }: { images: ToolImage[]; onImage: (src: string) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto px-1 pb-1">
      {images.map((im, i) => (
        <button key={i} onClick={() => onImage(imgSrc(im))} className="shrink-0 overflow-hidden border bg-background hover:border-primary/60">
          <img src={imgSrc(im)} alt="" className="h-14 w-auto object-contain" />
        </button>
      ))}
    </div>
  )
}

const ToolRow = memo(function ToolRow({ item, onImage }: { item: ToolItem; onImage: (src: string) => void }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const running = item.status === "running"
  const now = useNow(running)
  const start = Date.parse(item.startedAt)
  const end = item.endedAt ? Date.parse(item.endedAt) : running ? now : NaN
  const dur = end - start
  const { short, server } = prettyToolName(item.name)
  const root = useContext(ProjectRootContext)
  const summary = relPaths(summarizeInput(item.input), root)
  const LIMIT = 3000
  const result = relPaths(item.resultText ?? "", root)
  const details = useContext(AgentDetailsContext)
  const outcome = toolOutcome(item)

  return (
    <div className={cn("ps-enter", open && "border border-line bg-surface-2", item.sub && "ml-3")}>
      <div className="flex h-6 w-full items-center">
        <button
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground hover:bg-surface-3"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={details ? undefined : `${short}${summary ? ` · ${summary}` : ""}`}
        >
          <span className="shrink-0 [&_svg]:size-3" style={{ color: toolHue(short) }}>
            {toolIcon(short)}
          </span>
          {!details ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-caption" title={outcome.reason ?? undefined}>
              <span className="shrink-0">{friendlyTool(short, outcome.state === "done" || running)}</span>
              {outcome.reason && (
                <span className={cn("min-w-0 truncate", outcome.state === "failed" ? "text-err" : "text-foreground/80")}>· {outcome.reason}</span>
              )}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-caption text-foreground/80" title={server ?? undefined}>
                {short}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-caption">{summary}</span>
              <span className="shrink-0 text-micro tabular-nums">{isFinite(dur) && dur >= 0 ? fmtMs(dur) : ""}</span>
            </>
          )}
          <span className="shrink-0 [&_svg]:size-3">
            <OutcomeIcon state={outcome.state} />
          </span>
        </button>
        {short === "save_checkpoint" && item.status === "done" && <CheckpointActions item={item} />}
      </div>
      {item.images.length > 0 && <ToolImages images={item.images} onImage={onImage} />}
      {open && (
        <div className="flex flex-col gap-1.5 border-t p-1.5">
          <div>
            <div className="ps-label mb-0.5">Input</div>
            <ToolInputView name={short} input={relPathsDeep(item.input, root)} partial={relPaths(item.partialInput, root)} />
          </div>
          {(result || !running) && (
            <div>
              <div className="ps-label mb-0.5">Result</div>
              {result ? (
                <>
                  <pre
                    className={cn(
                      "max-h-72 overflow-auto bg-background/60 p-1.5 font-mono text-micro leading-snug whitespace-pre-wrap break-all",
                      item.status === "error" && "text-err",
                    )}
                  >
                    {full || result.length <= LIMIT ? result : result.slice(0, LIMIT) + "…"}
                  </pre>
                  {result.length > LIMIT && (
                    <button className="text-micro text-primary hover:underline" onClick={() => setFull((f) => !f)}>
                      {full ? "Show less" : `Show all (${result.length.toLocaleString()} chars)`}
                    </button>
                  )}
                </>
              ) : (
                <div className="text-caption text-muted-foreground">(no text output)</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

/** A finished AskUserQuestion: the answers on one line, the questions on click. While it waits, the question card
 * below the timeline is the only place it shows. */
function AskedRow({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false)
  if (item.status === "running") return null
  const qs: { question: string; header?: string }[] = Array.isArray((item.input as any)?.questions) ? (item.input as any).questions : []
  const answers = new Map<string, string>()
  for (const m of (item.resultText ?? "").matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) answers.set(m[1], m[2])
  const clean = (a: string) => a.replace(/\s*\(recommended\)/gi, "")
  const skipped = item.status === "error"
  // Codex marks a question "failed" when its turn ends before the answer; the card stays open and the answer comes
  // back as the user's next message, so the row says nothing useful.
  if (skipped && !item.resultText?.trim()) return null
  // Paused, or the user wrote in the chat instead: the "Paused" notice or their message says it; the answer, if
  // any, comes as their next message.
  if (skipped && /paused you|wrote a new message instead|hasn't answered yet/i.test(item.resultText ?? "")) return null
  const line = qs.map((q) => answers.get(q.question)).filter(Boolean).map((a) => clean(a!)).join(" · ")
  return (
    <div className={cn("text-caption", item.sub && "ml-3")}>
      <button className="flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left text-muted-foreground hover:bg-surface-3" onClick={() => setOpen((o) => !o)}>
        <MessageCircleQuestionIcon className="size-3 shrink-0 text-primary" />
        <span className="shrink-0">{skipped ? "Skipped" : "You chose"}</span>
        {!skipped && <span className="min-w-0 flex-1 truncate text-foreground">{line}</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 border-l border-primary/30 py-0.5 pl-2 ml-2.5">
          {qs.map((q, i) => {
            const a = answers.get(q.question)
            return (
              <div key={i}>
                <span className="text-muted-foreground">{q.question}</span>
                {a && <span className="text-foreground"> → {clean(a)}</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The agent's assumptions after discovery (studio share_plan tool), shown as a checklist. */
function PlanRow({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const input = (item.input ?? {}) as { title?: string; bullets?: unknown }
  const bullets = Array.isArray(input.bullets) ? input.bullets.map(String) : []
  if (!bullets.length) return null
  return (
    <div className="flex flex-col gap-1 border-l-2 border-primary/50 py-0.5 pl-2">
      <div className="flex items-center gap-1.5 text-caption font-medium text-foreground">
        <ListChecksIcon className="size-3.5 text-primary" />
        {input.title || "My plan"}
      </div>
      <ul className="flex flex-col gap-0.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs leading-snug">
            <CheckIcon className="mt-0.5 size-3 shrink-0 text-primary" />
            <Markdownish text={b} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function Thinking({ item }: { item: Extract<TimelineItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-muted-foreground">
      <button className="flex items-center gap-1 text-caption hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        <BrainIcon className={cn("size-3", item.streaming && "animate-pulse")} />
        {item.streaming ? "Thinking…" : "Thought"}
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && <div className="mt-1 border-l-2 pl-2 text-caption whitespace-pre-wrap italic">{item.text}</div>}
    </div>
  )
}

function Raw({ json }: { json: unknown }) {
  const [open, setOpen] = useState(false)
  const type = (json as any)?.type ?? typeof json
  let preview: string
  try {
    preview = JSON.stringify(json)
  } catch {
    preview = String(json)
  }
  return (
    <div className="font-mono text-micro text-muted-foreground/80">
      <button className="flex w-full items-center gap-1 text-left hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="shrink-0">{String(type)}</span>
        {!open && <span className="truncate opacity-60">{preview.slice(0, 160)}</span>}
      </button>
      {open && <Json value={json} />}
    </div>
  )
}

/** A long designer message shows its first three lines, with "More" to read the rest. */
function Clamped({ text, streaming, latest }: { text: string; streaming?: boolean; latest?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  // the designer's latest message (its result, the next step) shows in full; older ones fold to three lines
  const [open, setOpen] = useState(!!latest)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || streaming) return
    // longer than the three-line fold, measured the same way open or folded (a short message gets no More/Less)
    setLong(el.scrollHeight > parseFloat(getComputedStyle(el).fontSize) * 4.2 + 2)
  }, [text, open, streaming])
  const clamp = !open && !streaming
  return (
    <div>
      <div ref={ref} className={cn(clamp && "max-h-[4.2em] overflow-hidden", clamp && long && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]")}>
        <Markdownish text={text} />
      </div>
      {!streaming && long && (
        <button className="text-caption text-primary hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  )
}

/** End of a turn. Simple: only a stop shows. With the panel's Details: one quiet line (time, cost). */
function ResultRow({ item }: { item: Extract<TimelineItem, { kind: "result" }> }) {
  const root = useContext(ProjectRootContext)
  const details = useContext(AgentDetailsContext)
  if (!details && !item.isError) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-micro text-muted-foreground/80", item.isError && "text-err")}>
      {item.isError ? <AlertTriangleIcon className="size-3" /> : <CheckIcon className="size-3" />}
      <span>{item.isError ? `Stopped: ${item.subtype}` : "Done"}</span>
      {details && item.durationMs != null && <span>{fmtMs(item.durationMs)}</span>}
      {details && item.costUsd != null && <Cost usd={item.costUsd} />}
      {item.isError && item.text && <div className="w-full font-mono whitespace-pre-wrap">{relPaths(item.text, root)}</div>}
    </div>
  )
}

/** Under a message the designer hasn't read: it reads it at its next step, or Stop came first. */
function DeliveryNote({ delivery }: { delivery: "waiting" | "dropped" }) {
  const waiting = delivery === "waiting"
  const Icon = waiting ? ClockIcon : XIcon
  return (
    <div className="flex items-center gap-1 px-0.5 text-micro text-muted-foreground" title={waiting ? "The designer reads it after its current step." : "Stopped before the designer read it."} data-delivery={delivery}>
      <Icon className="size-3" />
      {waiting ? "Waiting" : "Not read"}
    </div>
  )
}

/** Project folder for display: paths in the timeline are shown relative to it (raw JSON keeps full paths). */
export const ProjectRootContext = createContext<string | null>(null)

/** U2: the designer panel's "Details" (remembered): raw tool names, inputs, durations and costs in the timeline. */
export const AgentDetailsContext = createContext(false)

export function TimelineRow({ item, onImage, latest }: { item: TimelineItem; onImage: (src: string) => void; latest?: boolean }) {
  const root = useContext(ProjectRootContext)
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-6 flex flex-col items-end gap-0.5 self-end">
          <div className={cn("flex flex-col gap-1.5 border border-primary/30 bg-primary/10 px-2.5 py-1.5", item.delivery && "opacity-70")}>
            {item.images && item.images.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {item.images.map((im, i) => (
                  <button key={i} onClick={() => onImage(imgSrc(im))} className="overflow-hidden border bg-background hover:border-primary/60">
                    <img src={imgSrc(im)} alt="" className="h-16 w-auto object-contain" />
                  </button>
                ))}
              </div>
            )}
            {item.annotations && item.annotations.length > 0 && (
              <div className="flex flex-col gap-0.5">
                {item.annotations.map((a) => (
                  <div key={a.n} className="flex items-start gap-1 text-caption" title={`${a.partId ?? "model"} · ${a.hint} · (${a.point.join(", ")}) mm`}>
                    <MapPinIcon className="mt-0.5 size-3 shrink-0 text-pin" />
                    <span className="font-semibold">{a.n}</span>
                    <span className="min-w-0">
                      {a.note || <span className="italic text-muted-foreground">(no note)</span>}
                      <span className="text-muted-foreground">
                        {" "}
                        · {a.partId ?? "model"}, {a.hint}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {item.text && <div className="whitespace-pre-wrap">{item.text}</div>}
          </div>
          {item.delivery && <DeliveryNote delivery={item.delivery} />}
        </div>
      )
    case "text":
      return (
        <div className={cn("px-0.5", item.sub && "ml-3 text-muted-foreground")}>
          <Clamped key={latest ? "latest" : "older"} text={relPaths(item.text, root)} streaming={item.streaming} latest={latest} />
          {item.streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/70 align-middle" />}
        </div>
      )
    case "thinking":
      return <Thinking item={item} />
    case "tool":
      if (item.name === "AskUserQuestion") return <AskedRow item={item} />
      if (item.name.endsWith("__share_plan")) return <PlanRow item={item} />
      return <ToolRow item={item} onImage={onImage} />
    case "result":
      return <ResultRow item={item} />
    case "error":
      return (
        item.code === "claude_auth" ? (
          <div className="flex flex-col items-start gap-2 border border-err/40 bg-err/10 px-3 py-2.5">
            <div className="flex items-start gap-1.5 text-sm text-err">
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
              <span>{item.text}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => useStudio.getState().navigate({ name: "agents" })}>
              Open Agents
            </Button>
          </div>
        ) : item.code === "budget.exceeded" ? (
          <div className="flex flex-col items-start gap-2 border border-warn/40 bg-warn/10 px-3 py-2.5">
            <div className="flex items-start gap-1.5 text-sm text-warn">
              <CircleDollarSignIcon className="mt-0.5 size-4 shrink-0" />
              <span>{item.text}</span>
            </div>
            <Button size="sm" variant="outline" onClick={() => useStudio.getState().navigate({ name: "agents" })}>
              Change the budget
            </Button>
          </div>
        ) : (
          <div className="flex items-start gap-1.5 border border-err/40 bg-err/10 px-2 py-1.5 text-err">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <div className="font-mono text-caption whitespace-pre-wrap break-all">{relPaths(item.text, root)}</div>
          </div>
        )
      )
    case "system":
      return (
        <div className="flex items-center gap-1.5 text-micro text-muted-foreground/80">
          <InfoIcon className="size-3" />
          {item.label}
        </div>
      )
    case "handoff":
      return <HandoffRow label={item.label} handoffId={item.handoffId} />
    case "raw":
      return <Raw json={item.json} />
  }
}
