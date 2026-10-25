import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import Editor, { type OnMount } from "@monaco-editor/react"
import { toast } from "sonner"
import { FileCode2Icon, Loader2Icon, RotateCcwIcon, SaveIcon, ServerCrashIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { EmptyState, Kbd } from "@/components/panel"
import { useTheme } from "@/components/theme-provider"
import { api, errMsg } from "@/lib/api"
import { defineStudioTheme, monaco, registerOpenScad } from "@/lib/monaco"
import { useStudio } from "@/stores/studio"

registerOpenScad()
defineStudioTheme()

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export default function CodeEditor({ projectId }: { projectId: string }) {
  const part = useStudio((s) => s.project?.parts.find((p) => p.id === s.selectedPartId))
  // a shared .scad opened from Files (lib/…); otherwise the selected part's file
  const other = useStudio((s) => s.codeFile)
  const path = other ?? part?.file
  if (!path) return <EmptyState icon={<FileCode2Icon />} title="No part selected" />
  // keyed by file so all editor state resets when the file changes
  return <FileEditor key={path} projectId={projectId} path={path} shared={!!other && other !== part?.file} />
}

function FileEditor({ projectId, path, shared }: { projectId: string; path: string; shared?: boolean }) {
  const fileChange = useStudio((s) => s.fileChange)
  const { theme } = useTheme()

  const [content, setContent] = useState<string>("")
  const [saved, setSaved] = useState<string | null>(null) // last loaded/saved content
  const [error, setError] = useState<string | null>(null)
  const loading = saved === null && !error
  const [saving, setSaving] = useState(false)
  const [externalChange, setExternalChange] = useState(false)

  const dirty = saved !== null && content !== saved

  const load = useCallback(async () => {
    try {
      const r = await api.readFile(projectId, path)
      setContent(r.content ?? "")
      setSaved(r.content ?? "")
      setError(null)
      setExternalChange(false)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [projectId, path])

  useEffect(() => {
    let alive = true
    api
      .readFile(projectId, path)
      .then((r) => {
        if (!alive) return
        setContent(r.content ?? "")
        setSaved(r.content ?? "")
      })
      .catch((e) => alive && setError(errMsg(e)))
    return () => {
      alive = false
    }
  }, [projectId, path])

  // react to on-disk changes (agent edits, external editor)
  const contentRef = useRef({ content, saved })
  useLayoutEffect(() => {
    contentRef.current = { content, saved }
  }, [content, saved])
  // Only the open file counts, and only if its disk content really differs from what we last
  // loaded/saved (our own saves and unrelated .studio/ writes also fire project.changed).
  const seenChange = useRef(fileChange?.n ?? 0) // ignore events from before this editor mounted
  useEffect(() => {
    if (!fileChange || fileChange.projectId !== projectId || fileChange.n <= seenChange.current) return
    seenChange.current = fileChange.n
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "")
    if (!fileChange.paths.some((p) => p === "*" || norm(p) === norm(path))) return
    let alive = true
    api
      .readFile(projectId, path)
      .then((r) => {
        if (!alive) return
        const disk = r.content ?? ""
        const { content: c, saved: sv } = contentRef.current
        if (sv === null || disk === sv) return
        if (c === sv) {
          // no local edits: just follow the file
          setContent(disk)
          setSaved(disk)
        } else if (disk !== c) setExternalChange(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [fileChange, projectId, path])

  const savingRef = useRef(false)
  const save = useCallback(async () => {
    const { content: c, saved: sv } = contentRef.current
    if (savingRef.current || sv === null || c === sv) return // in flight, not loaded, or clean
    savingRef.current = true
    setSaving(true)
    try {
      await api.writeFile(projectId, path, c)
      setSaved(c)
      setExternalChange(false)
    } catch (e) {
      toast.error("Save failed", { description: errMsg(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [projectId, path])

  const saveRef = useRef(save)
  useLayoutEffect(() => {
    saveRef.current = save
  }, [save])

  const onMount: OnMount = (editor) => {
    // Monaco keybinding (works when the editor has focus, incl. Electron)…
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
  }

  // …plus a capture-phase window handler, which runs before Monaco and before the browser's own
  // "Save page" (Chrome), wherever focus is. save() is idempotent, so both firing is fine.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key.toLowerCase() !== "s" && e.code !== "KeyS") return
      e.preventDefault()
      void saveRef.current()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])


  return (
    <div className="flex h-full flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-2 text-caption text-muted-foreground">
        <FileCode2Icon className="size-3.5 text-warn/80" />
        <span className="min-w-0 truncate font-mono text-foreground">{path}</span>
        {shared && (
          <span className="hidden truncate md:inline" title="Not a part. Saving updates the parts that include it.">
            · shared file
          </span>
        )}
        {dirty && <span className="size-1.5 bg-foreground/70 rounded-full" title="Unsaved changes" />}
        {externalChange && (
          <span className="flex items-center gap-1 text-warn">
            Changed on disk
            <Button
              size="xs"
              variant="outline"
              onClick={() => void load()}
              title="Discard your unsaved edits and load the file from disk"
            >
              <RotateCcwIcon /> Reload
            </Button>
          </span>
        )}
        <div className="flex-1" />
        <span className="hidden sm:inline">
          <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd> <Kbd>S</Kbd> save &amp; render
        </span>
        <Button size="xs" variant={dirty ? "default" : "ghost"} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
          Save
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {error ? (
          <EmptyState
            icon={<ServerCrashIcon />}
            title="Couldn't load file"
            detail={error}
            action={
              <Button size="sm" variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            }
          />
        ) : loading ? (
          <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading…" />
        ) : (
          <Editor
            language="openscad"
            theme={theme === "light" ? "vs" : "workshop-dark"}
            value={content}
            onChange={(v) => setContent(v ?? "")}
            onMount={onMount}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderLineHighlight: "line",
              lineNumbersMinChars: 3,
              padding: { top: 6 },
              fontFamily: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              fontLigatures: false,
              lineHeight: 19,
            }}
          />
        )}
      </div>
    </div>
  )
}
