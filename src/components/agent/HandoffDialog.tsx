// R11g: portable handoff, in plain words. One dialog mounted at the app root shows what the next designer will be told
// (the app's summary, editable) before switching designers, starting a fresh chat with a summary, or trying an idea
// with another designer. The timeline row marks where a chat started from a summary and opens it.
import { useEffect, useState } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import type { AgentProfilesResponse, HandoffPreview, HandoffRecord } from "@shared/types"
import { HandoffIcon, Loader2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

type Kind = "switch" | "fresh" | "idea"
interface Req {
  projectId: string
  kind: Kind
  preview: HandoffPreview
  target: { profileId: string | null; model: string | null } | null
}
const useHandoff = create<{ req: Req | null; set: (r: Req | null) => void; summary: { projectId: string; handoffId: string } | null; show: (s: { projectId: string; handoffId: string } | null) => void }>(
  (set) => ({ req: null, set: (req) => set({ req }), summary: null, show: (summary) => set({ summary }) }),
)

const busyAgent = (projectId: string) => !!useStudio.getState().agent[projectId]?.running

/**
 * The designer picked in the chat header. Same runtime (or nothing said yet): switch right away (it resumes natively).
 * Another runtime with a conversation: show the handoff first. Returns false when the switch was cancelled/failed.
 */
export async function switchDesigner(projectId: string, profileId: string | null, model: string | null, apply: () => Promise<void>): Promise<void> {
  let preview: HandoffPreview
  try {
    preview = await api.handoffPreview(projectId, "switch", { profileId, model })
  } catch {
    return apply() // no preview (older server): the plain switch
  }
  if (!preview.needed) return apply()
  if (busyAgent(projectId)) return void toast("The designer is working", { description: "Stop it first, then switch designers." })
  useHandoff.getState().set({ projectId, kind: "switch", preview, target: { profileId, model } })
}

/** "Start a fresh chat with a summary": same designer, a clean conversation that starts from the app's summary. */
export async function askFreshChat(projectId: string) {
  if (busyAgent(projectId)) return void toast("The designer is working", { description: "Stop it first, then start a fresh chat." })
  try {
    const preview = await api.handoffPreview(projectId, "fresh")
    if (!preview.needed) return void toast("Nothing to summarize yet", { description: "This chat is empty." })
    useHandoff.getState().set({ projectId, kind: "fresh", preview, target: null })
  } catch (e) {
    toast.error("Couldn't prepare the summary", { description: errMsg(e) })
  }
}

/** "Try this with another designer": a new idea whose chat starts on another designer from this chat's summary. */
export async function askTryWithDesigner(projectId: string) {
  if (busyAgent(projectId)) return void toast("The designer is working", { description: "Stop it first, then try another designer." })
  try {
    const [profiles, choice] = await Promise.all([api.agentProfiles(), api.projectAgent(projectId)])
    const other = profiles.profiles.find((p) => p.runtime !== choice.effective.runtime) ?? profiles.profiles.find((p) => p.id !== choice.effective.profileId)
    if (!other) return void toast("Only one designer is set up", { description: "Add another designer in Agents to compare them." })
    const target = { profileId: other.id, model: null }
    const preview = await api.handoffPreview(projectId, "idea", target)
    useHandoff.getState().set({ projectId, kind: "idea", preview, target })
  } catch (e) {
    toast.error("Couldn't prepare the summary", { description: errMsg(e) })
  }
}

const TITLE: Record<Kind, (p: HandoffPreview) => string> = {
  switch: (p) => `Hand over to ${p.to.name}?`,
  fresh: () => "Start a fresh chat with a summary?",
  idea: () => "Try this with another designer",
}

export function HandoffHost() {
  const req = useHandoff((s) => s.req)
  const setReq = useHandoff((s) => s.set)
  const summary = useHandoff((s) => s.summary)
  const show = useHandoff((s) => s.show)
  return (
    <>
      {req && <HandoffDialog key={`${req.projectId}:${req.kind}:${req.preview.fromSessionId}`} req={req} onClose={() => setReq(null)} />}
      {summary && <SummaryDialog projectId={summary.projectId} handoffId={summary.handoffId} onClose={() => show(null)} />}
    </>
  )
}

function HandoffDialog({ req, onClose }: { req: Req; onClose: () => void }) {
  const { preview, kind, projectId } = req
  const [mode, setMode] = useState<"new" | "resume">("new")
  const generated = mode === "resume" && preview.resumeMarkdown ? preview.resumeMarkdown : preview.markdown
  // the user's edit; null = the app's wording (which follows the new-chat / earlier-chat choice)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? generated
  const edited = draft !== null
  const [busy, setBusy] = useState(false)
  const [profiles, setProfiles] = useState<AgentProfilesResponse | null>(null)
  const [target, setTarget] = useState(req.target)
  const [title, setTitle] = useState("")
  useEffect(() => {
    if (kind === "idea") void api.agentProfiles().then(setProfiles, () => {})
  }, [kind])

  const toName = kind === "idea" ? (profiles?.profiles.find((p) => p.id === target?.profileId)?.name ?? preview.to.name) : preview.to.name
  const run = async () => {
    setBusy(true)
    const markdown = edited && text.trim() !== generated.trim() ? text : undefined
    try {
      if (kind === "idea") {
        await api.tryWithDesigner(projectId, { profileId: target?.profileId ?? null, model: target?.model ?? null, ...(markdown ? { markdown } : {}), ...(title.trim() ? { title: title.trim() } : {}) })
        toast.success(`Now trying it with ${toName}`, { description: "Ask for the change, then compare." })
      } else if (mode === "resume" && preview.resume) {
        await api.startHandoff(projectId, { reason: "switch", ...req.target!, mode: "resume", resumeSessionId: preview.resume.sessionId, ...(markdown ? { markdown } : {}) })
        toast.success(`Back with ${preview.resume.designer}`, { description: "It's told what changed since, with your next message." })
      } else {
        await api.startHandoff(projectId, { reason: kind, ...(req.target ?? {}), ...(markdown ? { markdown } : {}) })
        toast.success(kind === "fresh" ? "Fresh chat started" : `Handed over to ${preview.to.name}`, { description: "The summary goes with your next message." })
      }
      await useStudio.getState().resync(projectId)
      onClose()
    } catch (e) {
      toast.error("Couldn't hand over", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }

  const fromName = preview.from?.name ?? "the earlier chat"
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="flex max-h-[min(88vh,760px)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HandoffIcon className="size-4 text-primary" /> {TITLE[kind](preview)}
          </DialogTitle>
          <DialogDescription>
            {kind === "fresh"
              ? `A new chat with ${preview.to.name}, without the long history. It starts from this summary instead.`
              : kind === "idea"
                ? `Makes a separate copy of the design (a new idea) and gives it to another designer, starting from this summary. Your current idea and its chat stay as they are; compare the two afterwards.`
                : mode === "resume"
                  ? `${preview.resume?.designer ?? preview.to.name} picks up its earlier chat and reads this summary of what changed since.`
                  : `Chats don't carry over between designers. ${preview.to.name} starts a new chat and reads this summary first.`}{" "}
            Crease wrote it from your project, not the AI. Fix anything wrong or missing.
          </DialogDescription>
        </DialogHeader>

        {kind === "idea" && (
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
            <span className="text-muted-foreground">Designer</span>
            <Select
              items={(profiles?.profiles ?? []).map((p) => ({ value: p.id, label: p.name }))}
              value={target?.profileId ?? ""}
              onValueChange={(v) => setTarget({ profileId: (v as string) || null, model: null })}
            >
              <SelectTrigger size="sm" aria-label="Designer for the new idea">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(profiles?.profiles ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    <span className="text-muted-foreground">{p.runtime === preview.from?.runtime ? "same kind as now" : ""}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">Name</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Tried with ${toName}`} className="h-7 text-xs" />
          </div>
        )}

        {preview.resume && kind === "switch" && (
          <div className="flex flex-col gap-1" role="radiogroup" aria-label="How to continue">
            {(
              [
                ["new", `Start a new chat with ${preview.to.name}`, "It reads the summary below first."],
                ["resume", `Continue the earlier ${preview.resume.designer} chat`, `“${preview.resume.title}” picks up where it left off, and is told what changed since.`],
              ] as const
            ).map(([m, label, hint]) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn("flex flex-col items-start border px-2.5 py-1.5 text-left", mode === m ? "border-primary bg-primary/5" : "border-line-strong hover:border-primary/50")}
              >
                <span className="font-medium">{label}</span>
                <span className="text-caption text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="ps-label">Here's what {kind === "fresh" ? "the fresh chat" : `${toName}`} will be told</span>
            {edited && text.trim() !== generated.trim() && (
              <button
                className="text-caption text-primary hover:underline"
                onClick={() => setDraft(null)}
              >
                Undo my edits
              </button>
            )}
          </div>
          <Textarea
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Handoff summary"
            spellCheck={false}
            className="min-h-64 flex-1 resize-none font-mono text-micro leading-relaxed"
          />
          <span className="text-caption text-muted-foreground">
            From {fromName}. Your design files, versions and prints stay the same; the earlier chat stays in Sessions.
          </span>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={busy || !text.trim() || (kind === "idea" && !target)}>
            {busy && <Loader2Icon className="animate-spin" />}
            {kind === "fresh" ? "Start the fresh chat" : kind === "idea" ? `Try it with ${toName}` : mode === "resume" ? "Continue that chat" : `Hand over to ${preview.to.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Read the summary": exactly what the designer was told, and whether it has gone yet. */
function SummaryDialog({ projectId, handoffId, onClose }: { projectId: string; handoffId: string; onClose: () => void }) {
  const [rec, setRec] = useState<HandoffRecord | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.handoff(projectId, handoffId).then(setRec, (e) => setErr(errMsg(e)))
  }, [projectId, handoffId])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(88vh,760px)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <HandoffIcon className="size-4 text-primary" /> The summary {rec?.to.name ?? "the designer"} was given
          </DialogTitle>
          <DialogDescription>
            {rec
              ? `${rec.deliveredAt ? `Sent with your first message (${new Date(rec.deliveredAt).toLocaleString()}).` : "It goes with your next message."}${rec.edited ? " You edited it before the switch." : ""} Written by Crease from the project${rec.from ? `, after the chat with ${rec.from.name}` : ""}.`
              : (err ?? "Loading…")}
          </DialogDescription>
        </DialogHeader>
        <pre className="min-h-0 flex-1 overflow-y-auto border bg-background/60 p-3 font-mono text-micro leading-relaxed whitespace-pre-wrap">{rec?.markdown}</pre>
      </DialogContent>
    </Dialog>
  )
}

/** Timeline marker: "Handed over from Claude (Opus) — read the summary". */
export function HandoffRow({ label, handoffId }: { label: string; handoffId: string }) {
  const project = useStudio((s) => s.project)
  const show = useHandoff((s) => s.show)
  const [head, link] = label.includes(" — ") ? [label.slice(0, label.lastIndexOf(" — ")), label.slice(label.lastIndexOf(" — ") + 3)] : [label, "read the summary"]
  return (
    <div className="flex items-center gap-2 border-y border-primary/25 bg-primary/5 px-2 py-1.5 text-caption" role="note">
      <HandoffIcon className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        {head}
        {" — "}
        <button className="text-primary underline-offset-2 hover:underline" onClick={() => project && show({ projectId: project.id, handoffId })}>
          {link}
        </button>
      </span>
    </div>
  )
}
