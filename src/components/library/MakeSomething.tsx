// "Make something" (Library button, ⌘N, setup Done, empty Library): what do you want to make? With a designer
// ready: describe it (the project is named from the request, which becomes the first chat message). Always: the
// templates, which need no designer. No designer: one way to set one up. No name prompt (UX round 2).
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, FileIcon, ImagePlusIcon, Loader2Icon, SparklesIcon, XIcon } from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { StarterGrid, useStarters } from "@/components/onboarding/StarterGallery"
import { useSetup } from "@/components/onboarding/setup-state"
import { api, errMsg, type InputImage } from "@/lib/api"
import { openAddDesigner } from "@/lib/add-designer"
import { fileToInputImage } from "@/lib/images"
import { projectTitle } from "@/lib/project-title"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

// Pictures the designer can see; other files (SVG, STL, PDF...) only go to refs/ and are named in the message.
const SENDABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

export function MakeSomethingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-2xl">{open && <MakeSomething onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  )
}

function MakeSomething({ onClose }: { onClose: () => void }) {
  const starters = useStarters()
  const left = useSetup((s) => s.left)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState<"describe" | "empty" | null>(null)
  useEffect(() => {
    void useSetup.getState().refresh()
  }, [])
  // null = still checking: show neither the box nor the set-up line yet
  const designerReady = left === null ? null : !left.includes("designer")

  const open = (id: string) => {
    void useStudio.getState().loadProjects()
    useStudio.getState().navigate({ name: "project", id })
  }

  // Photos and files (drop, paste or the clip): saved to the new project's refs/, pictures also go with the message.
  const [files, setFiles] = useState<{ file: File; url: string | null }[]>([])
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const urls = useRef<string[]>([])
  const addFiles = (list: Iterable<File>) => {
    const added = [...list].map((file) => {
      const url = SENDABLE.has(file.type) ? URL.createObjectURL(file) : null
      if (url) urls.current.push(url)
      return { file, url }
    })
    setFiles((cur) => [...cur, ...added].slice(0, 8))
  }
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])

  const describe = async () => {
    const typed = text.trim()
    if ((!typed && !files.length) || busy) return
    setBusy("describe")
    try {
      const p = await api.createProject(typed ? projectTitle(typed) : "New project")
      const saved: string[] = []
      const images: InputImage[] = []
      for (const { file } of files) {
        try {
          saved.push((await api.uploadFile(p.id, `refs/${file.name || "photo.png"}`, file)).path)
          if (SENDABLE.has(file.type)) images.push(await fileToInputImage(file))
        } catch (e) {
          toast.error(`Couldn't add ${file.name}`, { description: errMsg(e) })
        }
      }
      const request = [typed, saved.length ? `Files: ${saved.join(", ")}` : ""].filter(Boolean).join("\n\n")
      onClose()
      open(p.id)
      const r = await api.sendMessage(p.id, request, images, [])
      useStudio.setState((s) => ({ agent: { ...s.agent, [p.id]: { running: true, sessionId: r?.sessionId ?? null, costUsd: 0 } } }))
    } catch (e) {
      toast.error("Couldn't start it", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const empty = async () => {
    setBusy("empty")
    try {
      const p = await api.createProject("New project")
      onClose()
      open(p.id)
    } catch (e) {
      toast.error("Couldn't make the project", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>What do you want to make?</DialogTitle>
        <DialogDescription>{designerReady ? "Describe it, or start from a template." : "Start from a template. Change its size after."}</DialogDescription>
      </DialogHeader>

      {designerReady && (
        <form
          className={cn("flex flex-col border bg-background focus-within:border-ring dark:bg-input/30", dragging && "border-primary bg-primary/5")}
          onSubmit={(e) => {
            e.preventDefault()
            void describe()
          }}
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
            addFiles(e.dataTransfer.files)
          }}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2" aria-label="Added files">
              {files.map((f, i) => (
                <div key={i} className="group relative flex h-12 items-center overflow-hidden border bg-background" title={f.file.name}>
                  {f.url ? (
                    <img src={f.url} alt={f.file.name} className="h-full w-auto max-w-24 object-contain" />
                  ) : (
                    <span className="flex max-w-32 items-center gap-1 px-2 text-caption text-muted-foreground">
                      <FileIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{f.file.name}</span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-foreground text-background group-hover:flex focus-visible:flex"
                    onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                    aria-label={`Remove ${f.file.name}`}
                  >
                    <XIcon className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            autoFocus
            aria-label="Describe it"
            value={text}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault()
                addFiles(e.clipboardData.files)
              }
            }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void describe()
              }
            }}
            placeholder={dragging ? "Drop photos or files" : "Describe it… a phone stand for my desk"}
            className="min-h-16 resize-none border-0 bg-transparent px-2.5 py-2 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <div className="flex items-center justify-end gap-2 px-2 pb-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => fileRef.current?.click()}
              title="Add photos or files. Put a bank card beside an object for scale."
              aria-label="Add photos or files"
            >
              <ImagePlusIcon />
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ""
              }}
            />
            <span className="min-w-0 flex-1" />
            {text.trim() && <span className="truncate text-caption text-muted-foreground">Project: {projectTitle(text)}</span>}
            <Button type="submit" size="sm" disabled={(!text.trim() && !files.length) || busy !== null}>
              {busy === "describe" ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
              Make it
            </Button>
          </div>
        </form>
      )}

      {designerReady === false && (
        <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
          <SparklesIcon className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-sm">Set up a designer to describe anything</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onClose()
              openAddDesigner()
            }}
          >
            Set up
          </Button>
        </div>
      )}

      <div className="min-h-0 overflow-y-auto">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">Templates</h3>
        {starters === null ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : starters.length ? (
          <StarterGrid starters={starters} onStarted={onClose} />
        ) : (
          <p className="text-xs text-muted-foreground">No templates found.</p>
        )}
      </div>

      <div className="flex justify-end">
        <Button size="xs" variant="link" className="h-auto px-0 text-muted-foreground" onClick={() => void empty()} disabled={busy !== null}>
          {busy === "empty" && <Loader2Icon className="animate-spin" />}
          Start empty
        </Button>
      </div>
    </>
  )
}
