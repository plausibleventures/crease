// Sidebar "Files": a quiet tree of the project folder, to copy other files in (picker or drag from Finder) and tidy
// them up. One "+" in the header; Rename, Show in Finder and Delete live in a "⋯" / right-click menu per row.
// Server rules (what's hidden, what can't be changed): server/projects/files.ts.
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { ProjectFileNode } from "@shared/types"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  CuboidIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlusIcon,
} from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api, errMsg } from "@/lib/api"
import { revealFileFn } from "@/lib/desktop"
import { useStudio } from "@/stores/studio"
import { cn } from "@/lib/utils"

export function fmtBytes(n: number | undefined): string {
  if (n == null) return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const iconFor = (n: ProjectFileNode) => {
  if (n.kind === "dir") return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
  if (/\.scad$/i.test(n.name)) return <FileCode2Icon className="size-3.5 shrink-0 text-warn/80" />
  if (/\.(stl|3mf|obj|step|stp)$/i.test(n.name)) return <CuboidIcon className="size-3.5 shrink-0 text-muted-foreground" />
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(n.name)) return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
  return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

const MAX_BYTES = 100 * 1024 * 1024

type Dropped = { file: File; rel: string }

/** Files (and folders, recursively) from a drop; `rel` keeps a dropped folder's own layout. */
async function droppedFiles(dt: DataTransfer): Promise<Dropped[]> {
  const entries = [...dt.items].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null)).filter((e): e is FileSystemEntry => !!e)
  if (!entries.length) return [...dt.files].map((file) => ({ file, rel: file.name }))
  const out: Dropped[] = []
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (out.length > 500) return
    if (e.isFile) {
      const file = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej))
      out.push({ file, rel: prefix + e.name })
    } else if (e.isDirectory) {
      if (e.name.startsWith(".")) return
      const reader = (e as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        for (const c of batch) await walk(c, `${prefix}${e.name}/`)
      }
    }
  }
  for (const e of entries) await walk(e, "")
  return out
}

/** The Files section's pieces for the Sidebar's Section: header action, drop target props and the tree. */
export function useFileBrowser(projectId: string) {
  const [files, setFiles] = useState<ProjectFileNode[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [dropOn, setDropOn] = useState<string | null>(null) // "" = the project folder
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<ProjectFileNode | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [creating, setCreating] = useState<{ parent: string; name: string } | null>(null) // "New folder" name being typed
  const [revealing, setRevealing] = useState(false) // a pick from the header opens the section
  const openCodeFile = useStudio((s) => s.openCodeFile)
  const target = useRef("") // folder the picker adds to
  const input = useRef<HTMLInputElement | null>(null)
  const fileChange = useStudio((s) => s.fileChange)
  const project = useStudio((s) => s.project)
  const selectPart = useStudio((s) => s.selectPart)
  const setCenterTab = useStudio((s) => s.setCenterTab)
  const selected = useStudio((s) => s.codeFile ?? s.project?.parts.find((p) => p.id === s.selectedPartId)?.file)

  const load = useCallback(async () => {
    if (!projectId) return
    try {
      setFiles((await api.listFiles(projectId)).files)
    } catch {
      /* keep the last tree; the section stays quiet */
    }
  }, [projectId])

  // first load, then follow on-disk changes (designer edits, renders, our own uploads), debounced
  const n = fileChange?.projectId === projectId ? fileChange.n : 0
  useEffect(() => {
    const t = setTimeout(() => void load(), n ? 250 : 0)
    return () => clearTimeout(t)
  }, [load, n])

  const upload = async (list: Dropped[], dir: string) => {
    if (!list.length) return
    const tooBig = list.filter((d) => d.file.size > MAX_BYTES)
    for (const d of tooBig) toast.error(`${d.file.name} is over 100 MB`)
    const ok = list.filter((d) => d.file.size <= MAX_BYTES)
    if (!ok.length) return
    setBusy(true)
    const t = toast.loading(ok.length === 1 ? `Adding ${ok[0].file.name}…` : `Adding ${ok.length} files…`)
    let added = 0
    const failed: string[] = []
    for (const d of ok) {
      try {
        await api.uploadFile(projectId, dir ? `${dir}/${d.rel}` : d.rel, d.file)
        added++
      } catch (e) {
        failed.push(`${d.rel}: ${errMsg(e)}`)
      }
    }
    setBusy(false)
    if (dir) setOpen((s) => new Set(s).add(dir))
    if (failed.length)
      toast.error(added ? `Added ${added} · ${failed.length} not added` : "Not added", { id: t, description: failed.slice(0, 4).join("\n"), duration: 12000 })
    else toast.success(added === 1 ? "File added" : `${added} files added`, { id: t })
    void load()
  }

  const pick = (dir: string) => {
    target.current = dir
    // open the Files list too, so the added files show where they went
    setRevealing(true)
    setTimeout(() => setRevealing(false), 0)
    input.current?.click()
  }

  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const doRename = async () => {
    if (!renaming) return
    const r = renaming
    setRenaming(null)
    const name = r.name.trim()
    const from = r.path
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : ""
    if (!name || name === from.slice(parent ? parent.length + 1 : 0)) return
    try {
      await api.renameFile(projectId, from, parent ? `${parent}/${name}` : name)
      void load()
    } catch (e) {
      toast.error("Couldn't rename it", { description: errMsg(e) })
    }
  }

  const doDelete = async (n: ProjectFileNode) => {
    try {
      await api.deleteFile(projectId, n.path)
      void load()
    } catch (e) {
      toast.error("Couldn't delete it", { description: errMsg(e) })
    }
  }

  const openFile = (n: ProjectFileNode) => {
    const part = project?.parts.find((p) => p.file === n.path)
    if (part) {
      selectPart(part.id)
      setCenterTab("model")
    } else if (/\.scad$/i.test(n.name) && !n.readOnly) {
      // a shared .scad (lib/…): open it in the code editor; saving re-renders the parts that include it
      openCodeFile(n.path)
      document.dispatchEvent(new Event("printstudio:show-code"))
    }
  }

  const doNewFolder = async () => {
    if (!creating) return
    const c = creating
    setCreating(null)
    const name = c.name.trim()
    if (!name) return
    try {
      const r = await api.makeFolder(projectId, c.parent ? `${c.parent}/${name}` : name)
      if (c.parent) setOpen((s) => new Set(s).add(c.parent))
      setOpen((s) => new Set(s).add(r.path))
      void load()
    } catch (e) {
      toast.error("Couldn't make the folder", { description: errMsg(e) })
    }
  }
  const newFolder = (parent: string) => {
    if (parent) setOpen((s) => new Set(s).add(parent))
    // after the menu closes, so the input keeps focus
    setTimeout(() => setCreating({ parent, name: "" }), 0)
  }
  const folderInput = (parent: string, depth: number) =>
    creating?.parent === parent && (
      <input
        key={`new:${parent}`}
        autoFocus
        className="mx-2 h-6 border bg-background px-1.5 text-xs outline-none focus:border-primary"
        style={{ marginLeft: 8 + depth * 12 }}
        value={creating.name}
        maxLength={200}
        placeholder="Folder name…"
        spellCheck={false}
        autoComplete="off"
        aria-label="New folder name"
        onChange={(e) => setCreating({ parent, name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter") void doNewFolder()
          if (e.key === "Escape") setCreating(null)
        }}
        onBlur={() => void doNewFolder()}
      />
    )

  const reveal = revealFileFn()
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files")
  // Drops here copy files as they are (no import questions); stopPropagation keeps the workspace's import away.
  const dropProps = (dir: string) => ({
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.stopPropagation()
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.stopPropagation()
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn((d) => (d === dir ? null : d))
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = "copy"
      if (dropOn !== dir) setDropOn(dir)
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDropOn(null)
      void droppedFiles(e.dataTransfer).then((list) => upload(list, dir))
    },
  })

  const row = (n: ProjectFileNode, depth: number): React.ReactNode => {
    const isDir = n.kind === "dir"
    const expanded = open.has(n.path)
    const pad = 8 + depth * 12
    if (renaming?.path === n.path)
      return (
        <input
          key={n.path}
          autoFocus
          className="mx-2 h-6 border bg-background px-1.5 text-xs outline-none focus:border-primary"
          style={{ marginLeft: pad }}
          value={renaming.name}
          maxLength={200}
          aria-label="New name"
          onFocus={(e) => {
            const dot = e.target.value.lastIndexOf(".")
            e.target.setSelectionRange(0, dot > 0 && !isDir ? dot : e.target.value.length)
          }}
          onChange={(e) => setRenaming({ path: n.path, name: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void doRename()
            if (e.key === "Escape") setRenaming(null)
          }}
          onBlur={() => void doRename()}
        />
      )
    const menuOpen = menu === n.path
    return (
      <div key={n.path}>
        <div
          className={cn(
            "group flex h-6 items-center rounded-md pr-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            selected === n.path && "bg-primary/15 text-foreground hover:bg-primary/20",
            isDir && dropOn === n.path && "bg-primary/20 text-foreground outline outline-1 -outline-offset-1 outline-primary",
          )}
          onContextMenu={(e) => {
            if (n.readOnly && !reveal) return
            e.preventDefault()
            setMenu(n.path)
          }}
          {...(isDir && !n.readOnly ? dropProps(n.path) : {})}
        >
          <button
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
            style={{ paddingLeft: pad }}
            onClick={() => (isDir ? toggle(n.path) : openFile(n))}
            aria-expanded={isDir ? expanded : undefined}
          >
            {isDir ? (
              expanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            {iconFor(n)}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {!isDir && <span className="hidden shrink-0 text-micro tabular-nums opacity-70 group-hover:inline">{fmtBytes(n.size)}</span>}
          </button>
          {(!n.readOnly || reveal) && (
            <DropdownMenu open={menuOpen} onOpenChange={(o) => setMenu(o ? n.path : null)}>
              <DropdownMenuTrigger
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground",
                  !menuOpen && "invisible group-hover:visible",
                )}
                aria-label={`More for ${n.name}`}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-36">
                {isDir && !n.readOnly && <DropdownMenuItem onClick={() => pick(n.path)}>Add files</DropdownMenuItem>}
                {isDir && !n.readOnly && <DropdownMenuItem onClick={() => newFolder(n.path)}>New folder</DropdownMenuItem>}
                {!n.readOnly && <DropdownMenuItem onClick={() => setTimeout(() => setRenaming({ path: n.path, name: n.name }), 0)}>Rename</DropdownMenuItem>}
                {reveal && <DropdownMenuItem onClick={() => void reveal(projectId, n.path)}>Show in Finder</DropdownMenuItem>}
                {!n.readOnly && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-err" onClick={() => setDeleting(n)}>
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {isDir && expanded && folderInput(n.path, depth + 1)}
        {isDir && expanded && n.children?.map((c) => row(c, depth + 1))}
      </div>
    )
  }

  // the picker lives in the header action, so "Add files…" works while the section is closed
  const action = (
    <>
    <input
      ref={input}
      type="file"
      multiple
      className="hidden"
      onChange={(e) => {
        const list = [...(e.target.files ?? [])].map((file) => ({ file, rel: file.name }))
        e.target.value = ""
        void upload(list, target.current)
      }}
    />
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Add files or a folder"
        aria-label="Add files or a folder"
        disabled={busy}
      >
        {busy ? <Loader2Icon className="size-3 animate-spin" /> : <PlusIcon className="size-3.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuItem onClick={() => pick("")}>Add files…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => newFolder("")}>New folder</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  )

  const body = (
    <>
      {files && files.length === 0 && <div className="px-3 py-1 text-caption text-muted-foreground">Drop files here.</div>}
      {folderInput("", 0)}
      {files?.map((n) => row(n, 0))}
      {dropOn === "" && <div className="mx-2 mt-1 border border-dashed border-primary px-2 py-1 text-caption text-primary">Drop to copy here</div>}
      <DeleteDialog node={deleting} onClose={() => setDeleting(null)} onDelete={doDelete} />
    </>
  )

  return { action, body, dropProps: dropProps(""), dropping: dropOn !== null, forceOpen: creating !== null || revealing }
}

function DeleteDialog({ node, onClose, onDelete }: { node: ProjectFileNode | null; onClose: () => void; onDelete: (n: ProjectFileNode) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={!!node} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {node && (
          <>
            <DialogHeader>
              <DialogTitle>Delete {node.name}?</DialogTitle>
              <DialogDescription>
                {node.kind === "dir" ? "The folder and everything in it go away." : "The file goes away."}              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await onDelete(node)
                  } finally {
                    setBusy(false)
                    onClose()
                  }
                }}
              >
                {busy && <Loader2Icon className="animate-spin" />}
                Delete
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
