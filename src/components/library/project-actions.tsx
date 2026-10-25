// Project lifecycle actions (U4): Rename…, Tags…, Duplicate, Move to Trash…, shared by the Library row menu, the
// project header menu and the command palette. One host with the dialogs is mounted in App.
import { useEffect, useState } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import { Loader2Icon, XIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, errMsg } from "@/lib/api"
import { desktop } from "@/lib/desktop"
import { useStudio } from "@/stores/studio"

export interface ProjectRef {
  id: string
  name: string
  tags?: string[]
}

type Pending = { kind: "rename" | "tags" | "trash"; project: ProjectRef } | null
const usePending = create<{ pending: Pending; set: (p: Pending) => void }>((set) => ({ pending: null, set: (pending) => set({ pending }) }))

export const askRename = (project: ProjectRef) => usePending.getState().set({ kind: "rename", project })
export const askTags = (project: ProjectRef) => usePending.getState().set({ kind: "tags", project })
export const askTrash = (project: ProjectRef) => usePending.getState().set({ kind: "trash", project })

/** After a change: the Library list, the open project and the nav's "back to project" item follow. */
function afterChange(id: string, name: string | null) {
  const st = useStudio.getState()
  st.updateRecentProject(id, name)
  void st.loadProjects()
  if (st.project?.id === id && name !== null) void st.refreshProject()
}

export async function duplicateProject(project: ProjectRef) {
  try {
    const copy = await api.duplicateProject(project.id)
    void useStudio.getState().loadProjects()
    toast.success(`Made a copy: ${copy.name}`, {
      action: { label: "Open", onClick: () => useStudio.getState().navigate({ name: "project", id: copy.id }) },
    })
  } catch (e) {
    toast.error("Couldn't copy the project", { description: errMsg(e) })
  }
}

export function ProjectActionsHost() {
  const pending = usePending((s) => s.pending)
  const set = usePending((s) => s.set)
  const close = () => set(null)
  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-sm">
        {pending?.kind === "rename" && <RenameBody project={pending.project} onDone={close} />}
        {pending?.kind === "tags" && <TagsBody project={pending.project} onDone={close} />}
        {pending?.kind === "trash" && <TrashBody project={pending.project} onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function RenameBody({ project, onDone }: { project: ProjectRef; onDone: () => void }) {
  const [name, setName] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const n = name.trim()
    if (!n || n === project.name) return onDone()
    setBusy(true)
    setError(null)
    try {
      const p = await api.patchProject(project.id, { name: n })
      afterChange(p.id, p.name)
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription className="sr-only">A new name for {project.name}</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Label htmlFor="rename-name">Name</Label>
        <Input id="rename-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        {error && (
          <div className="text-caption text-err" role="alert">
            {error}
          </div>
        )}
      </form>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!name.trim() || busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          Rename
        </Button>
      </DialogFooter>
    </>
  )
}

function TagsBody({ project, onDone }: { project: ProjectRef; onDone: () => void }) {
  const [tags, setTags] = useState<string[]>(project.tags ?? [])
  const [draft, setDraft] = useState("")
  const [known, setKnown] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .catalogTags()
      .then((t) => Array.isArray(t) && setKnown(t.map((x) => x.tag)))
      .catch(() => {})
  }, [])
  const has = (t: string) => tags.some((x) => x.toLowerCase() === t.toLowerCase())
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter(Boolean)
    if (!parts.length) return
    setTags((cur) => {
      const out = [...cur]
      for (const t of parts) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t)
      return out
    })
    setDraft("")
  }
  const save = async () => {
    const all = draft.trim() ? [...tags, ...draft.split(",").map((t) => t.trim()).filter(Boolean)] : tags
    setBusy(true)
    setError(null)
    try {
      const p = await api.patchProject(project.id, { tags: all })
      afterChange(p.id, p.name)
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const suggestions = known.filter((t) => !has(t)).slice(0, 12)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Tags</DialogTitle>
        <DialogDescription>Find {project.name} with the Library's tag filter.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        {tags.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Tags on this project">
            {tags.map((t) => (
              <li key={t} className="flex h-6 items-center gap-1 border border-line-strong bg-surface-2 pr-0.5 pl-2 text-xs">
                {t}
                <Button variant="ghost" size="icon-xs" className="size-5" aria-label={`Remove tag ${t}`} onClick={() => setTags((cur) => cur.filter((x) => x !== t))}>
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            add(draft)
          }}
        >
          <Label htmlFor="tag-new" className="sr-only">
            Add a tag
          </Label>
          <Input id="tag-new" autoFocus value={draft} maxLength={200} onChange={(e) => setDraft(e.target.value)} placeholder="Add a tag, e.g. kitchen" />
          <Button type="submit" variant="outline" disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-caption text-muted-foreground">Used before:</span>
            {suggestions.map((t) => (
              <Button key={t} variant="outline" size="xs" onClick={() => add(t)}>
                {t}
              </Button>
            ))}
          </div>
        )}
        {error && (
          <div className="text-caption text-err" role="alert">
            {error}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

function TrashBody({ project, onDone }: { project: ProjectRef; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inDesktop = !!desktop()
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.trashProject(project.id)
      const st = useStudio.getState()
      if (st.route.name === "project" && st.route.id === project.id) st.navigate({ name: "library" })
      afterChange(project.id, null)
      toast.success(`Moved ${project.name} to the Trash`, {
        description: r.where === "system" ? "To get it back, open the Trash in Finder." : "It is in the .trash folder of your Crease folder.",
      })
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Move “{project.name}” to the Trash?</DialogTitle>
        <DialogDescription>{inDesktop ? "You can put it back from the Trash in Finder." : "It moves to the .trash folder in your Crease folder."}</DialogDescription>
      </DialogHeader>
      {error && (
        <div className="border border-err/40 bg-err/10 p-2 text-caption text-err" role="alert">
          {error}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onDone} autoFocus>
          Cancel
        </Button>
        <Button variant="destructive" onClick={() => void run()} disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          Move to Trash
        </Button>
      </DialogFooter>
    </>
  )
}
