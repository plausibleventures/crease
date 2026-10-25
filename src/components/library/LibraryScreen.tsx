import { useEffect, useState } from "react"
import type { CatalogProject, ProjectOverview } from "@shared/types"
import {
  ArrowRightIcon,
  BoxIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  Trash2Icon,
  FolderPlusIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerCrashIcon,
  TagIcon,
  UploadIcon,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import { StarterGrid, useStarters } from "@/components/onboarding/StarterGallery"
import { FinishSetupButton } from "@/components/onboarding/FinishSetupButton"
import { AppNav } from "@/components/AppNav"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState, PageHeader } from "@/components/panel"
import { api } from "@/lib/api"
import { fmtRelative } from "@/lib/format"
import { useStudio } from "@/stores/studio"
import { ExportPackDialog, useImportPack } from "@/components/pack/BuildPack"
import { askRename, askTags, askTrash, duplicateProject } from "./project-actions"
import { modKey, runCommand } from "@/lib/commands"

type SectionId = "projects" | "templates"
const OPEN_KEY = "printstudio.library.open"

/** Which Library sections are open, remembered per browser. null = never set: open the most useful one. */
function readOpen(): SectionId[] | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null")
    return Array.isArray(v) ? v.filter((x): x is SectionId => x === "projects" || x === "templates") : null
  } catch {
    return null
  }
}
function writeOpen(v: SectionId[]) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(v))
  } catch {
    // private window or blocked storage: the sections still work, they just aren't remembered
  }
}

export function LibraryScreen() {
  const projects = useStudio((s) => s.projects)
  const error = useStudio((s) => s.projectsError)
  const loading = useStudio((s) => s.projectsLoading)
  const loadProjects = useStudio((s) => s.loadProjects)
  const query = useStudio((s) => s.libraryQuery)
  const setQuery = useStudio((s) => s.setLibraryQuery)
  const navigate = useStudio((s) => s.navigate)
  const starters = useStarters()
  const imp = useImportPack()
  const [q, setQ] = useState(query.q)
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [exportId, setExportId] = useState<string | null>(null)
  const [open, setOpenState] = useState<SectionId[] | null>(readOpen)
  const setOpen = (v: SectionId[]) => {
    setOpenState(v)
    writeOpen(v)
  }

  useEffect(() => {
    // onboarding's "Use a template": open that section ("printstudio:new-project" is app-wide: src/lib/commands.ts)
    const onStarters = () => setOpenState((o) => [...new Set<SectionId>([...(o ?? []), "templates"])])
    document.addEventListener("printstudio:show-starters", onStarters)
    return () => document.removeEventListener("printstudio:show-starters", onStarters)
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])
  // the tag filter's list follows the projects (tags edited, projects trashed)
  useEffect(() => {
    api
      .catalogTags()
      .then((t) => Array.isArray(t) && setTags(t))
      .catch(() => {})
  }, [projects])

  // debounce server-side search
  useEffect(() => {
    if (q === useStudio.getState().libraryQuery.q) return
    const t = setTimeout(() => setQuery({ q }), 200)
    return () => clearTimeout(t)
  }, [q, setQuery])

  const filtering = !!(query.q || query.tag)
  const hasProjects = !!projects?.length
  // first visit: only the most useful section starts open; with a few projects, the templates show too
  const fewProjects = (projects?.length ?? 0) < 4
  const openNow: SectionId[] = filtering
    ? ["projects"]
    : (open ?? (projects === null ? [] : !hasProjects ? ["templates"] : fewProjects ? ["projects", "templates"] : ["projects"]))

  return (
    <div className="relative flex h-full flex-col">
      <header data-glass-chrome="top" className="flex h-10 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <AppNav />
        <div className="flex-1" />
        <FinishSetupButton />
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
          <PageHeader
            title="Library"
            primary={
              <Button size="sm" onClick={() => runCommand("new-project")} title={`New project (${modKey("N")})`}>
                <PlusIcon /> New project
              </Button>
            }
          >
        <div className="relative w-56">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input id="library-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="h-7 pl-7" />
        </div>
        {tags.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" title="Filter by tag" />}>
              <TagIcon /> {query.tag ?? "All"}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setQuery({ tag: null })}>
                {!query.tag ? <CheckIcon /> : <span className="size-3.5" />} All
              </DropdownMenuItem>
              {tags.map((t) => (
                <DropdownMenuItem key={t.tag} onClick={() => setQuery({ tag: t.tag })}>
                  {query.tag === t.tag ? <CheckIcon /> : <span className="size-3.5" />} {t.tag}
                  <span className="ml-auto pl-3 text-micro text-muted-foreground">{t.count}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" title="More" aria-label="More" />}>
            {loading || imp.busy ? <Loader2Icon className="animate-spin" /> : <MoreHorizontalIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={imp.pick} disabled={imp.busy}>
              <UploadIcon /> Import build pack…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void loadProjects()}>
              <RefreshCwIcon /> Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
          </PageHeader>
          {!filtering && projects && hasProjects && <ContinueProject projects={projects} />}
          <Accordion multiple value={openNow} onValueChange={(v) => setOpen(v as SectionId[])} className="border-y">
            <AccordionItem value="projects">
              <AccordionTrigger summary={projects ? plural(projects.length, "project") : ""}>{filtering ? "Matching projects" : "Your projects"}</AccordionTrigger>
              <AccordionContent>
                {projects === null && error ? (
                  <EmptyState
                    icon={<ServerCrashIcon />}
                    title="Couldn't load projects"
                    detail={error}
                    action={
                      <Button variant="outline" size="sm" onClick={() => void loadProjects()}>
                        Retry
                      </Button>
                    }
                  />
                ) : projects === null ? (
                  <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading…" />
                ) : projects.length === 0 ? (
                  <EmptyState
                    icon={<FolderPlusIcon />}
                    title={filtering ? "No matches" : "No projects yet"}
                    action={
                      filtering ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setQ("")
                            setQuery({ q: "", tag: null })
                          }}
                        >
                          Clear search
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => runCommand("new-project")}>
                          Make something
                        </Button>
                      )
                    }
                  />
                ) : (
                  <ProjectTable projects={projects} onOpen={(id) => navigate({ name: "project", id })} onExport={setExportId} />
                )}
                {projects !== null && error && <div className="mt-2 text-caption text-err">Refresh failed: {error}</div>}
              </AccordionContent>
            </AccordionItem>
            {!filtering && starters && starters.length > 0 && (
              <AccordionItem value="templates">
                <AccordionTrigger summary={plural(starters.length, "template")}>Templates</AccordionTrigger>
                <AccordionContent>
                  <StarterGrid starters={starters} />
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>
        </div>
      </div>

      {imp.element}
      {exportId && <ExportPackDialog projectId={exportId} open onOpenChange={(o) => !o && setExportId(null)} />}
    </div>
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

function ProjectTable({ projects, onOpen, onExport }: { projects: CatalogProject[]; onOpen: (id: string) => void; onExport: (id: string) => void }) {
  // a column of dashes says nothing: "Last print" shows once something has been printed
  const anyPrinted = projects.some((p) => p.lastPrint)
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-12" />
          <TableHead>Name</TableHead>
          <TableHead className="w-16">Parts</TableHead>
          <TableHead className="w-28">Changed</TableHead>
          {anyPrinted && <TableHead className="w-28">Last print</TableHead>}
          <TableHead className="w-10" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {projects.map((p) => (
          <TableRow key={p.id} className="cursor-pointer focus-within:bg-muted/40" onClick={() => onOpen(p.id)}>
            <TableCell className="py-1">
              <div className="flex size-9 items-center justify-center overflow-hidden rounded-md bg-stage-thumb">
                {p.thumbnailUrl ? <img src={p.thumbnailUrl} alt="" className="size-full object-contain" /> : <BoxIcon className="size-4 text-faint/50" />}
              </div>
            </TableCell>
            <TableCell className="max-w-0 truncate font-medium text-foreground">
              {/* the row's keyboard target: Tab reaches it, Enter opens (the whole row still takes clicks) */}
              <button
                type="button"
                className="max-w-full truncate text-left outline-offset-2 hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(p.id)
                }}
              >
                {p.name}
              </button>
              {p.tags.length > 0 && <span className="ml-2 text-caption font-normal text-muted-foreground">{p.tags.join(" · ")}</span>}
            </TableCell>
            <TableCell className="text-caption text-muted-foreground">{p.partCount ?? 0}</TableCell>
            <TableCell className="text-caption text-muted-foreground">{fmtRelative(p.updatedAt)}</TableCell>
            {anyPrinted && <TableCell>{p.lastPrint ? <PrintStatus print={p.lastPrint} /> : <span className="text-faint">–</span>}</TableCell>}
            <TableCell className="py-1" onClick={(e) => e.stopPropagation()}>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" title="More" aria-label={`More for ${p.name}`} />}>
                  <MoreHorizontalIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onOpen(p.id)}>
                    <ArrowRightIcon /> Open
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => askRename(p)}>
                    <PencilIcon /> Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => askTags(p)}>
                    <TagIcon /> Tags…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void duplicateProject(p)}>
                    <CopyIcon /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onExport(p.id)}>
                    <PackageIcon /> Export build pack…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => askTrash(p)} className="text-err">
                    <Trash2Icon /> Move to Trash…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** R12 follow-up: pick up where you left off: the most recently changed project and its ONE next step. */
function mostRecentProject(projects: CatalogProject[]): CatalogProject | null {
  let best: CatalogProject | null = null
  for (const p of projects) if (!best || Date.parse(p.updatedAt) > Date.parse(best.updatedAt)) best = p
  return best
}

/** One slim row: picture · name · next step · arrow. */
function ContinueProject({ projects }: { projects: CatalogProject[] }) {
  const navigate = useStudio((s) => s.navigate)
  const recent = mostRecentProject(projects)
  const [ov, setOv] = useState<{ id: string; ov: ProjectOverview } | null>(null)
  const id = recent?.id ?? null
  const updatedAt = recent?.updatedAt
  useEffect(() => {
    if (!id) return
    let alive = true
    api
      .overview(id)
      .then((o) => alive && o && setOv({ id, ov: o }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [id, updatedAt])
  if (!recent) return null
  const o = ov?.id === recent.id ? ov.ov : null
  const picture = o?.hero?.url ?? recent.thumbnailUrl
  return (
    <button
      onClick={() => navigate({ name: "project", id: recent.id })}
      aria-label={`Continue ${recent.name}`}
      className="group flex h-14 w-full items-center gap-3 overflow-hidden rounded-lg border border-primary/30 bg-primary/[0.06] pr-3 text-left transition-colors hover:border-primary/70"
    >
      <div className="flex h-full w-16 shrink-0 items-center justify-center overflow-hidden bg-stage-thumb">
        {picture ? <img src={picture} alt="" className="size-full object-contain" /> : <BoxIcon className="size-5 text-faint/50" />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-caption text-muted-foreground">Continue</span>
        <span className="truncate text-sm font-medium">{recent.name}</span>
      </div>
      {o && <span className="hidden truncate text-xs text-muted-foreground sm:inline">Next: {o.next.label}</span>}
      <ArrowRightIcon className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
    </button>
  )
}

function PrintStatus({ print }: { print: NonNullable<CatalogProject["lastPrint"]> }) {
  const label = print.state === "printing" ? "Printing" : print.practice ? "Practice" : print.result === "success" ? "Printed" : print.result === "failed" || print.state === "error" ? "Failed" : print.state === "complete" ? "Printed" : "Stopped"
  const cls =
    print.state === "printing"
      ? "text-primary"
      : print.practice
        ? "text-muted-foreground"
        : print.result === "success" || (print.result === null && print.state === "complete")
        ? "text-ok"
        : print.result === "failed" || print.state === "error"
          ? "text-err"
          : "text-muted-foreground"
  return (
    <span className={cn("text-caption", cls)} title={`Last print ${fmtRelative(print.finishedAt ?? print.startedAt)}`}>
      {label}
    </span>
  )
}
