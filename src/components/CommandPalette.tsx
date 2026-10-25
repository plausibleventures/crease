// ⌘K command palette, the "?" shortcuts sheet and the app-wide New project dialog (U4). Keyboard-first: type to
// filter, ↑/↓ to move, Enter to run, Esc to close.
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import type { AgentProfileView, CatalogProject } from "@shared/types"
import {
  BotIcon,
  CodeIcon,
  CompareIcon,
  CopyIcon,
  FolderIcon,
  InfoIcon,
  KeyboardIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  ScissorsIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon,
  BoxIcon,
} from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useTheme } from "@/components/theme-provider"
import { MakeSomethingDialog } from "@/components/library/MakeSomething"
import { askRename, duplicateProject } from "@/components/library/project-actions"
import { machineState } from "@/components/machines/MachinesScreen"
import { blockFor, sendBuild, sliceBuild } from "@/components/workspace/build-actions"
import { api, errMsg } from "@/lib/api"
import { modKey, runCommand, shortcutList, useAppOverlays } from "@/lib/commands"
import { fuzzyScore } from "@/lib/fuzzy"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

interface Item {
  id: string
  group: "Actions" | "Go to" | "Projects" | "Printers" | "Designers" | "Theme"
  label: string
  /** extra words to match on */
  keywords?: string
  hint?: string
  icon: React.ReactNode
  run: () => void
  /** why it can't run now (shown instead of running it) */
  off?: string | null
}

const GROUP_ORDER: Item["group"][] = ["Actions", "Go to", "Projects", "Printers", "Designers", "Theme"]

export function AppOverlays() {
  const newProject = useAppOverlays((s) => s.newProject)
  const set = useAppOverlays((s) => s.set)
  return (
    <>
      <CommandPalette />
      <ShortcutsSheet />
      <MakeSomethingDialog open={newProject} onOpenChange={(o) => set({ newProject: o })} />
    </>
  )
}

function CommandPalette() {
  const open = useAppOverlays((s) => s.palette)
  const set = useAppOverlays((s) => s.set)
  return (
    <Dialog open={open} onOpenChange={(o) => set({ palette: o })}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 p-0 sm:max-w-lg">
        {open && <PaletteBody close={() => set({ palette: false })} />}
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({ close }: { close: () => void }) {
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const [projects, setProjects] = useState<CatalogProject[] | null>(() => (useStudio.getState().libraryQuery.q || useStudio.getState().libraryQuery.tag ? null : useStudio.getState().projects))
  const [designers, setDesigners] = useState<AgentProfileView[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const { theme, setTheme } = useTheme()

  const route = useStudio((s) => s.route)
  const project = useStudio((s) => s.project)
  const partId = useStudio((s) => s.selectedPartId)
  const machines = useStudio((s) => s.machines)
  const inProject = route.name === "project" && project?.id === route.id ? project : null
  const canCompare = useStudio((s) => (inProject ? (s.ideas[inProject.id]?.ideas.length ?? 0) > 1 || (s.checkpoints[inProject.id]?.list.length ?? 0) > 1 : false))
  const target = useStudio((s) => (inProject ? s.targetMachineId(inProject.id) : null))
  // R2-FLOW-02: Print waits for "Make it fit" (or another failing check), as on the toolbar
  const ov = useStudio((s) => (inProject ? s.overview[inProject.id] : undefined))
  const block = blockFor(ov)
  const printOff = block?.reason ?? null
  const sliceOff = block?.slice ? block.reason : null

  useEffect(() => {
    // the full list, whatever the Library is filtered to
    api
      .catalog({})
      .then((p) => Array.isArray(p) && setProjects(p))
      .catch(() => {})
    api
      .agentProfiles()
      .then((r) => setDesigners(r.profiles))
      .catch(() => {})
  }, [])

  const items = useMemo<Item[]>(() => {
    const go = (fn: () => void) => () => {
      close()
      fn()
    }
    const out: Item[] = [{ id: "new", group: "Actions", label: "New project", hint: modKey("N"), icon: <PlusIcon />, run: go(() => runCommand("new-project")) }]
    if (inProject) {
      const pid = inProject.id
      out.push(
        { id: "slice", group: "Actions", label: "Slice", keywords: "prepare gcode", icon: <ScissorsIcon />, run: go(() => void sliceBuild(pid, partId)), off: sliceOff },
        { id: "print", group: "Actions", label: "Print", keywords: "send printer", icon: <SendIcon />, run: go(() => void sendBuild(pid, partId)), off: printOff },
        { id: "code", group: "Actions", label: "Show code", keywords: "openscad editor", icon: <CodeIcon />, run: go(() => document.dispatchEvent(new CustomEvent("printstudio:show-code"))) },
      )
      if (canCompare) out.push({ id: "compare", group: "Actions", label: "Compare ideas", keywords: "versions", icon: <CompareIcon />, run: go(() => useStudio.getState().setCenterTab("compare")) })
      out.push(
        { id: "rename", group: "Actions", label: "Rename project", icon: <PencilIcon />, run: go(() => askRename({ id: pid, name: inProject.name, tags: inProject.tags })) },
        { id: "dup", group: "Actions", label: "Duplicate project", keywords: "copy", icon: <CopyIcon />, run: go(() => void duplicateProject({ id: pid, name: inProject.name })) },
      )
    }
    out.push(
      { id: "settings", group: "Actions", label: "Settings", hint: modKey(","), keywords: "preferences", icon: <SettingsIcon />, run: go(() => runCommand("settings")) },
      { id: "about", group: "Actions", label: "About Crease", keywords: "version licence report problem data folder", icon: <InfoIcon />, run: go(() => runCommand("about")) },
      { id: "keys", group: "Actions", label: "Keyboard shortcuts", hint: "?", icon: <KeyboardIcon />, run: go(() => runCommand("shortcuts")) },
      { id: "go-lib", group: "Go to", label: "Library", hint: modKey("1"), keywords: "projects", icon: <FolderIcon />, run: go(() => runCommand("go-library")) },
      { id: "go-mach", group: "Go to", label: "Machines", hint: modKey("2"), keywords: "printers", icon: <PrinterIcon />, run: go(() => runCommand("go-machines")) },
      { id: "go-des", group: "Go to", label: "Designers", hint: modKey("3"), icon: <BotIcon />, run: go(() => runCommand("go-designers")) },
    )
    for (const p of projects ?? [])
      if (p.id !== inProject?.id)
        out.push({ id: `p:${p.id}`, group: "Projects", label: p.name, keywords: `open ${p.tags.join(" ")}`, icon: <BoxIcon />, run: go(() => useStudio.getState().navigate({ name: "project", id: p.id })) })
    for (const m of machines ?? []) {
      const st = machineState(m)
      const current = inProject ? m.id === target : m.isDefault
      out.push({
        id: `m:${m.id}`,
        group: "Printers",
        label: `${inProject ? "Print on" : "Default printer:"} ${m.name}`,
        keywords: "switch printer machine",
        hint: current ? "current" : st.label,
        icon: <PrinterIcon />,
        run: go(() => {
          if (current) return
          if (!m.enabled) return void toast.error(`${m.name} is turned off`, { description: "Turn it on in Machines first." })
          const p = inProject
            ? useStudio.getState().setProjectMachine(inProject.id, m.id).then(() => toast("Printer changed", { description: "Slice again for this printer." }))
            : api.setDefaultMachine(m.id).then(() => {
                void useStudio.getState().loadMachines()
                toast.success(`${m.name} is now the default`)
              })
          p.catch((e) => toast.error("Couldn't change the printer", { description: errMsg(e) }))
        }),
      })
    }
    for (const d of designers)
      out.push({
        id: `d:${d.id}`,
        group: "Designers",
        label: `Default designer: ${d.name}`,
        keywords: "switch designer agent model",
        hint: d.isDefault ? "current" : undefined,
        icon: <SparklesIcon />,
        run: go(() => {
          if (d.isDefault) return
          api
            .setDefaultAgentProfile(d.id)
            .then(() => toast.success(`New chats use ${d.name}`))
            .catch((e) => toast.error("Couldn't change the designer", { description: errMsg(e) }))
        }),
      })
    for (const t of ["dark", "light", "system"] as const)
      out.push({
        id: `t:${t}`,
        group: "Theme",
        label: `Theme: ${t === "system" ? "Match system" : t === "dark" ? "Dark" : "Light"}`,
        keywords: "appearance colour color mode",
        hint: theme === t ? "current" : undefined,
        icon: <span className={cn("size-3 border border-current", t === "dark" ? "bg-black" : t === "light" ? "bg-white" : "bg-gradient-to-r from-black to-white")} />,
        run: go(() => setTheme(t)),
      })
    return out
  }, [close, inProject, partId, canCompare, projects, machines, target, designers, theme, setTheme, printOff, sliceOff])

  const shown = useMemo(() => {
    if (!q.trim()) {
      // empty: actions and pages, then a few projects; printers, designers and themes appear when you type
      const projectsFirst = items.filter((i) => i.group === "Projects").slice(0, 6)
      return [...items.filter((i) => i.group === "Actions" || i.group === "Go to"), ...projectsFirst]
    }
    return items
      .map((i, n) => ({ i, n, s: fuzzyScore(`${i.label} ${i.keywords ?? ""}`, q) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => b.s! - a.s! || GROUP_ORDER.indexOf(a.i.group) - GROUP_ORDER.indexOf(b.i.group) || a.n - b.n)
      .map((x) => x.i)
      .slice(0, 50)
  }, [items, q])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, shown.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Home") {
      e.preventDefault()
      setActive(0)
    } else if (e.key === "End") {
      e.preventDefault()
      setActive(shown.length - 1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (!shown[active]?.off) shown[active]?.run()
    }
  }

  const empty = !q.trim()
  return (
    <>
      <DialogHeader className="sr-only">
        <DialogTitle>Command palette</DialogTitle>
        <DialogDescription>Type to find a project, page or action.</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2 border-b border-line-strong px-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="Find a project, page or action…"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `palette-${shown[active].id}` : undefined}
          aria-autocomplete="list"
          aria-label="Command"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        <kbd className="font-mono text-micro text-muted-foreground">esc</kbd>
      </div>
      <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-1">
        {shown.length === 0 && <div className="px-3 py-6 text-center text-muted-foreground">No matches</div>}
        {shown.map((it, n) => {
          const header = empty && (n === 0 || shown[n - 1].group !== it.group)
          return (
            <div key={it.id}>
              {header && (
                <div className="px-3 pt-2 pb-1 text-micro text-muted-foreground" aria-hidden>
                  {it.group === "Projects" ? "Recent projects" : it.group}
                </div>
              )}
              <div
                id={`palette-${it.id}`}
                data-index={n}
                role="option"
                aria-selected={n === active}
                aria-disabled={it.off ? true : undefined}
                title={it.off ?? undefined}
                onMouseMove={() => n !== active && setActive(n)}
                onClick={() => !it.off && it.run()}
                className={cn(
                  "mx-1 flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-xs [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                  n === active && "bg-primary/15 text-foreground [&_svg]:text-primary",
                  it.off && "cursor-default text-muted-foreground",
                )}
              >
                {it.icon}
                <span className={cn("min-w-0 truncate", !it.off && "flex-1")}>{it.label}</span>
                {it.off && <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">{it.off}</span>}
                {!empty && <span className="text-micro text-faint">{it.group === "Projects" ? "Project" : it.group}</span>}
                {it.hint && <span className="text-micro text-muted-foreground">{it.hint}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function ShortcutsSheet() {
  const open = useAppOverlays((s) => s.shortcuts)
  const set = useAppOverlays((s) => s.set)
  return (
    <Dialog open={open} onOpenChange={(o) => set({ shortcuts: o })}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">Shortcuts that work in Crease</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {shortcutList().map((g) => (
            <section key={g.group} aria-label={g.group}>
              <h3 className="mb-1 text-caption text-muted-foreground">{g.group}</h3>
              <dl className="flex flex-col divide-y divide-line border-y border-line">
                {g.items.map((it) => (
                  <div key={it.label} className="flex h-8 items-center justify-between">
                    <dt>{it.label}</dt>
                    <dd>
                      <kbd className="border border-line-strong bg-surface-2 px-1.5 py-0.5 font-mono text-micro">{it.keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
