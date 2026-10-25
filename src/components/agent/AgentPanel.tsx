import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, DesignersIcon, FreshChatIcon, ImagePlusIcon, LightbulbIcon, Loader2Icon, MapPinIcon, MoreHorizontalIcon, SparklesIcon, SquareIcon, XIcon } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { askFreshChat, askTryWithDesigner } from "./HandoffDialog"
import type { PointAnnotation } from "@shared/types"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, useEscape } from "@/components/panel"
import { useSetup } from "@/components/onboarding/setup-state"
import { openAddDesigner } from "@/lib/add-designer"
import { api, errMsg, type InputImage } from "@/lib/api"
import { fileToInputImage, inputImageSrc } from "@/lib/images"
import { cn } from "@/lib/utils"
import { Cost } from "./Cost"
import { useStudio } from "@/stores/studio"
import { AgentDetailsContext, ProjectRootContext, TimelineRow, ToolGroupRow } from "./TimelineItems"
import { foldRepeats } from "@/lib/tool-rows"
import { DetailsToggle } from "@/components/panel"
import { useRemembered } from "@/lib/use-remembered"
import { ModelSwitcher } from "./ModelSwitcher"
import { askTryIdea } from "@/components/versions"
import { AgentConfigNotice } from "./AgentConfigNotice"
import { PermissionCard } from "./PermissionCard"
import { QuestionCard } from "./QuestionCard"

const NO_ITEMS: never[] = []
const NO_QUESTIONS: never[] = []

// Empty projects: a few ideas to start from. Projects with a design get suggestions computed from the project (R12).
const SUGGESTIONS = ["Make me a phone stand", "Make me something to organize my keys", "Make me a name tag for my backpack"]

export function AgentPanel({ projectId }: { projectId: string }) {
  const timeline = useStudio((s) => s.timelines[projectId])
  const tlError = useStudio((s) => s.timelineError[projectId])
  const status = useStudio((s) => s.agent[projectId])
  const questions = useStudio((s) => s.questions[projectId] ?? NO_QUESTIONS)
  const permissions = useStudio((s) => s.permissions[projectId] ?? NO_QUESTIONS)
  const project = useStudio((s) => s.project)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [pending, setPending] = useState<{ text: string; after: number; images: InputImage[] } | null>(null)
  const [images, setImages] = useState<InputImage[]>([])
  const allPins = useStudio((s) => s.pins[projectId])
  const pendingPins = useMemo(() => (allPins ?? []).filter((p) => !p.sent), [allPins])
  const removePin = useStudio((s) => s.removePin)
  const setHoverPin = useStudio((s) => s.setHoverPin)
  const [dragging, setDragging] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  useEscape(!!zoom, () => setZoom(null))
  const projectIdeas = useStudio((s) => s.overview[projectId]?.suggestions) ?? NO_ITEMS
  const hasDesign = useStudio((s) => s.overview[projectId]?.hasDesign)
  // U2: plain steps by default; Details (remembered) shows tool names, inputs, times and costs
  const [details, setDetails] = useRemembered("agent")

  // "Ask the designer" / "Describe what to make" elsewhere (the overview) focuses the composer, maybe with a draft.
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(
    () =>
      useStudio.subscribe((s, prev) => {
        const f = s.composerFocus
        if (f.n === prev.composerFocus.n) return
        if (f.draft) setText((t) => (t.trim() ? t : f.draft!))
        setTimeout(() => {
          const el = inputRef.current
          if (!el) return
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
        }, 0)
      }),
    [],
  )

  const items = timeline?.items ?? NO_ITEMS
  const running = !!status?.running
  // runs of the same step fold into one line; the designer's last word (once it stops) shows in full
  const entries = useMemo(() => foldRepeats(items), [items])
  const latestText = useMemo(() => {
    if (running) return null
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]
      if (it.kind === "user") return null
      if (it.kind === "text" && !it.sub) return it.key
    }
    return null
  }, [items, running])
  // no designer ready and nothing said yet: the chat can't answer, so it says so instead of offering a box
  const designerMissing = useSetup((s) => !!s.left?.includes("designer"))
  useEffect(() => {
    void useSetup.getState().refresh()
  }, [projectId])
  const session = project?.sessions.find((s) => s.id === (status?.sessionId ?? project.activeSessionId))

  // hide the optimistic bubble once the server echoes the message
  const showPending = useMemo(
    () => !!pending && !items.slice(pending.after).some((it) => it.kind === "user" && it.text.trim() === pending.text.trim()),
    [items, pending],
  )

  const addFiles = async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith("image/"))
    if (!list.length) return
    const added: InputImage[] = []
    for (const f of list) {
      try {
        added.push(await fileToInputImage(f))
      } catch (e) {
        toast.error("Couldn't attach image", { description: errMsg(e) })
      }
    }
    setImages((cur) => [...cur, ...added].slice(0, 8))
  }

  // stick-to-bottom autoscroll
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true)
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, pending, questions])

  const send = async (msg?: string) => {
    const t = (msg ?? text).trim()
    let imgs = msg ? [] : images
    const pinsNow = msg ? [] : pendingPins
    if ((!t && !imgs.length && !pinsNow.length) || sending) return
    // While the agent is waiting on a question, typed text answers it (the agent is blocked until then).
    const q = questions[0]
    if (q && t && !imgs.length && !pinsNow.length) {
      setText("")
      try {
        await api.answerQuestion(projectId, q.requestId, Object.fromEntries(q.questions.map((x) => [x.question, t])), Object.fromEntries(q.questions.map((x) => [x.question, "The user typed this reply instead of picking an option."])))
      } catch (e) {
        setText(t)
        toast.error("Couldn't send your answer", { description: errMsg(e) })
      }
      return
    }
    // pinned spots: structured annotations + a picture of the view with the numbered pins
    const annotations: PointAnnotation[] = pinsNow.map((p) => ({
      n: p.n,
      partId: p.partId,
      ...(p.instance !== undefined ? { instance: p.instance } : {}),
      point: p.point,
      ...(p.assemblyPoint ? { assemblyPoint: p.assemblyPoint } : {}),
      normal: p.normal,
      hint: p.hint,
      note: p.note,
    }))
    if (pinsNow.length) {
      const shot = useStudio.getState().viewerCapture?.()
      if (shot) imgs = [...imgs, { mediaType: "image/jpeg", data: shot.slice(shot.indexOf(",") + 1) }]
      useStudio.getState().markPinsSent(projectId)
      useStudio.getState().setPinMode(false)
    }
    setSending(true)
    setPending({ text: t, after: items.length, images: imgs })
    setText("")
    if (!msg) setImages([])
    stick.current = true
    try {
      const r = await api.sendMessage(projectId, t, imgs, annotations)
      useStudio.setState((s) => ({
        agent: { ...s.agent, [projectId]: { running: true, sessionId: r?.sessionId ?? s.agent[projectId]?.sessionId ?? null, costUsd: s.agent[projectId]?.costUsd ?? 0 } },
      }))
    } catch (e) {
      setPending(null)
      setText(t)
      if (!msg) setImages(imgs)
      toast.error("Couldn't send", { description: errMsg(e) })
    } finally {
      setSending(false)
    }
  }

  const stop = async () => {
    setStopping(true)
    try {
      await api.stopAgent(projectId)
    } catch (e) {
      toast.error("Couldn't stop", { description: errMsg(e) })
    } finally {
      setStopping(false)
    }
  }

  const noDesigner = designerMissing && items.length === 0 && !running && !showPending && questions.length === 0

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <SparklesIcon className={running ? "size-3.5 animate-pulse text-primary" : "size-3.5 text-muted-foreground"} />
        <div className="ps-label min-w-[4.5rem] flex-1 truncate" title={session?.title}>
          Designer{session && details ? <span className="font-normal normal-case"> · {session.title}</span> : null}
        </div>
        <DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} />
        {!running && items.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" title="More chat options" aria-label="More chat options" />}>
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => askTryIdea(projectId)}>
                <LightbulbIcon /> Try another idea
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void askFreshChat(projectId)}>
                <FreshChatIcon /> Fresh chat
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void askTryWithDesigner(projectId)}>
                <DesignersIcon /> Try another designer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <ModelSwitcher projectId={projectId} />
        {details && <Cost usd={status?.costUsd} className="text-caption text-muted-foreground" />}
        {running && (
          <Button size="xs" variant="destructive" onClick={() => void stop()} disabled={stopping} title="Stop the designer">
            {stopping ? <Loader2Icon className="animate-spin" /> : <SquareIcon className="fill-current" />}
            Stop
          </Button>
        )}
      </div>

      <AgentConfigNotice projectId={projectId} />

      <div ref={scrollRef} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !showPending && questions.length === 0 ? (
          <EmptyState
            art="agent"
            title={tlError ? "Chat unavailable" : hasDesign ? "What should change?" : "What should we make?"}
            detail={tlError ?? undefined}
            action={
              noDesigner ? undefined : (
                <div className="mt-1 flex flex-col items-stretch gap-1">
                  {(hasDesign && projectIdeas.length ? projectIdeas : SUGGESTIONS).map((s) => (
                    <button key={s} onClick={() => void send(s)} className="border bg-card px-2 py-1.5 text-left text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground">
                      {s}
                    </button>
                  ))}
                </div>
              )
            }
          />
        ) : (
          <div className="flex flex-col gap-1.5 p-2">
            <AgentDetailsContext.Provider value={details}>
            <ProjectRootContext.Provider value={timeline?.root ?? null}>
              {entries.map((e) =>
                e.kind === "group" ? (
                  <ToolGroupRow key={e.key} label={e.label} items={e.items} onImage={setZoom} />
                ) : (
                  <TimelineRow key={e.item.key} item={e.item} onImage={setZoom} latest={e.item.key === latestText} />
                ),
              )}
            </ProjectRootContext.Provider>
            </AgentDetailsContext.Provider>
            {showPending && pending && (
              <div className="ml-6 flex flex-col gap-1 self-end border border-primary/20 bg-primary/5 px-2.5 py-1.5 opacity-70">
                {pending.images.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {pending.images.map((im, i) => (
                      <img key={i} src={inputImageSrc(im)} alt="" className="h-12 w-auto border object-contain" />
                    ))}
                  </div>
                )}
                {pending.text && <div className="whitespace-pre-wrap">{pending.text}</div>}
              </div>
            )}
            {questions.map((q) => (
              <QuestionCard key={q.requestId} projectId={projectId} request={q} />
            ))}
            {permissions.map((r) => (
              <PermissionCard key={r.requestId} projectId={projectId} request={r} />
            ))}
            {running && questions.length === 0 && permissions.length === 0 && (
              <div className="flex items-center gap-2 text-caption text-muted-foreground" role="status">
                <span className="ps-cursor" /> working
              </div>
            )}
          </div>
        )}
      </div>

      {noDesigner ? (
        // nothing to reply yet: one line and a way to set a designer up, not a box that can't answer (UX round 2)
        <div className="flex h-10 shrink-0 items-center gap-1.5 border-t px-3 text-xs" role="status">
          <span className="text-muted-foreground">No designer yet</span>
          <span aria-hidden className="text-faint">·</span>
          <Button size="xs" variant="link" className="h-auto px-0" onClick={openAddDesigner}>
            Set up
          </Button>
        </div>
      ) : (
        <div
          className="shrink-0 border-t p-2"
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes("Files")) {
              e.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            setDragging(false)
            void addFiles(e.dataTransfer.files)
          }}
        >
          {items.length > 0 && !running && questions.length === 0 && projectIdeas.length > 0 && !text.trim() && (
            <div className="mb-1.5 flex flex-wrap gap-1" aria-label="Suggestions for this project">
              {projectIdeas.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  className="border border-line-strong bg-card px-2 py-0.5 text-caption text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {pendingPins.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {pendingPins.map((p) => (
                <span
                  key={p.n}
                  onMouseEnter={() => setHoverPin(p.n)}
                  onMouseLeave={() => setHoverPin(null)}
                  className="group flex max-w-full items-center gap-1 border border-pin/40 bg-pin/10 py-0.5 pr-1 pl-1.5 text-caption"
                  title={`${p.partId ?? "model"} · ${p.hint}`}
                >
                  <MapPinIcon className="size-3 shrink-0 text-pin" />
                  <span className="font-semibold">{p.n}</span>
                  <span className="min-w-0 truncate">{p.note || p.hint}</span>
                  <button
                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      removePin(projectId, p.n)
                      setHoverPin(null)
                    }}
                    aria-label={`Remove pin ${p.n}`}
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className={cn("flex flex-col border bg-background focus-within:border-ring dark:bg-input/30", dragging && "border-primary bg-primary/5")}>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                {images.map((im, i) => (
                  <div key={i} className="group relative border bg-background">
                    <img src={inputImageSrc(im)} alt="" className="h-12 w-auto max-w-24 rounded-[5px] object-contain" />
                    <button
                      className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-foreground text-background group-hover:flex"
                      onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}
                      title="Remove"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              ref={inputRef}
              onPaste={(e) => {
                const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"))
                if (files.length) {
                  e.preventDefault()
                  void addFiles(files)
                }
              }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={
                dragging
                  ? "Drop images"
                  : questions.length
                    ? "Or type an answer"
                    : pendingPins.length
                      ? "Anything else about the pins?"
                      : hasDesign
                        ? "Describe a change or ask a question"
                        : running || items.length > 0
                          ? "Reply"
                          : "Make me a phone stand"
              }
              className="max-h-40 min-h-14 resize-none border-0 bg-transparent px-2 py-1.5 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center gap-1 px-1.5 pb-1.5 text-micro text-muted-foreground">
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => fileRef.current?.click()}
                title="Add a photo. Put a bank card beside the object for scale."
              >
                <ImagePlusIcon />
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files)
                  e.target.value = ""
                }}
              />
              <div className="flex-1" />
              <Button size="icon-xs" onClick={() => void send()} disabled={(!text.trim() && !images.length && !pendingPins.length) || sending} title="Send (Enter). Shift+Enter for a new line.">
                {sending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
              </Button>
            </div>
          </div>
        </div>
      )}

      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-8" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-h-full max-w-full object-contain" />
          <XIcon className="absolute top-3 right-3 size-5 text-white/80" />
        </div>
      )}
    </div>
  )
}
