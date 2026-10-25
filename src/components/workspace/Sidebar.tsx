import { useState } from "react"
import {
  CuboidIcon,
  EyeIcon,
  EyeOffIcon,
  FileCode2Icon,
  LightbulbIcon,
  ListOrderedIcon,
  Loader2Icon,
  MessageSquareIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  UploadIcon,
  UserIcon,
  CompareIcon,
  PencilIcon,
} from "@/components/icons"
import { api } from "@/lib/api"
import { askRestore, askTryIdea } from "@/components/versions"
import { requestImport } from "./ImportFile"
import { useFileBrowser } from "./FileBrowser"
import { toast } from "sonner"
import { errMsg } from "@/lib/api"
import { fmtCost, fmtRelative } from "@/lib/format"
import { Cost } from "@/components/agent/Cost"
import { partKey, useStudio } from "@/stores/studio"
import { useHidden, usePlates } from "@/stores/plates"
import { cn } from "@/lib/utils"
import { toneOf } from "@shared/filament-tones"
import { useRemembered } from "@/lib/use-remembered"
import { DetailsToggle } from "@/components/panel"


function Section({
  title,
  count,
  action,
  children,
  defaultOpen = true,
  forceOpen = false,
  ...rest
}: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; /** shown open while true (e.g. a name being typed) */ forceOpen?: boolean } & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  // U2: each section remembers whether it is open (no modes: Files simply starts closed)
  const [open, setOpen] = useRemembered(`sidebar-${title.toLowerCase()}`, defaultOpen)
  // forceOpen turning on opens the section (and it stays open)
  const [wasForced, setWasForced] = useState(forceOpen)
  if (forceOpen !== wasForced) {
    setWasForced(forceOpen)
    if (forceOpen && !open) setOpen(true)
  }
  return (
    <div className="flex flex-col" {...rest}>
      <div className="flex h-6 items-center pr-1">
        <DetailsToggle open={open} onToggle={() => setOpen((o) => !o)} label={title} summary={count} className="h-full min-w-0 flex-1 justify-start overflow-hidden px-2 [&>svg]:ml-auto" />
        {action}
      </div>
      {open && <div className="flex flex-col px-1 pb-2">{children}</div>}
    </div>
  )
}

export function Sidebar() {
  const project = useStudio((s) => s.project)
  const selected = useStudio((s) => s.selectedPartId)
  const selectPart = useStudio((s) => s.selectPart)
  const rendering = useStudio((s) => s.rendering)
  const renders = useStudio((s) => s.renders)
  const checks = useStudio((s) => s.checks)
  const agentStatus = useStudio((s) => (s.project ? s.agent[s.project.id] : undefined))
  const catalogSessions = useStudio((s) => (s.project ? s.sessions[s.project.id] : undefined))
  const switchSession = useStudio((s) => s.switchSession)
  const assembly = useStudio((s) => (s.project ? s.assembly[s.project.id] : undefined))
  const centerTab = useStudio((s) => s.centerTab)
  const setCenterTab = useStudio((s) => s.setCenterTab)
  const [switching, setSwitching] = useState<string | null>(null)
  const versions = useStudio((s) => (s.project ? s.checkpoints[s.project.id] : undefined))
  const [showAll, setShowAll] = useState(false)
  const hiddenParts = useHidden(project?.id ?? "").parts
  const ideas = useStudio((s) => (s.project ? s.ideas[s.project.id] : undefined))
  const switchIdea = useStudio((s) => s.switchIdea)
  const openCompare = useStudio((s) => s.openCompare)
  const [renaming, setRenaming] = useState<{ branch: string; name: string } | null>(null)
  const togglePart = usePlates((s) => s.togglePart)
  const setPartsHidden = usePlates((s) => s.setPartsHidden)
  const fileBrowser = useFileBrowser(project?.id ?? "")
  if (!project) return null
  const branchOf = new Map(project.sessions.map((x) => [x.id, x.branch]))
  const forkCost = new Map(project.sessions.map((x) => [x.id, x.forkCostUsd ?? 0]))
  const activeSession = agentStatus ? agentStatus.sessionId : project.activeSessionId

  // Prefer catalog rows (cost, first prompt, activity); fall back to project.json.
  type Row = { id: string; title: string; forkedFrom: string | null; costUsd?: number; lastMessageAt?: string | null; firstPrompt?: string | null }
  const rows: Row[] = catalogSessions?.length
    ? catalogSessions
    : [...project.sessions].reverse()
  const roots = rows.filter((s) => !s.forkedFrom || !rows.some((p) => p.id === s.forkedFrom))
  const children = (id: string) => rows.filter((s) => s.forkedFrom === id)

  const choose = async (id: string | null) => {
    if (id === activeSession) return
    if (agentStatus?.running && !window.confirm("The designer is working. Stop it and switch?")) return
    setSwitching(id ?? "new")
    try {
      await switchSession(project.id, id)
    } catch (e) {
      toast.error("Couldn't switch session", { description: errMsg(e) })
    } finally {
      setSwitching(null)
    }
  }

  const openIdea = async (branch: string, name: string) => {
    if (agentStatus?.running && !window.confirm("The designer is working. Stop it and open another idea?")) return
    setSwitching(`idea:${branch}`)
    try {
      await switchIdea(project.id, branch)
      toast.success(`Now on: ${name}`, { description: "Its files and its own chat are back." })
    } catch (e) {
      toast.error("Couldn't open that idea", { description: errMsg(e) })
    } finally {
      setSwitching(null)
    }
  }
  const saveName = async () => {
    if (!renaming) return
    const r = renaming
    setRenaming(null)
    try {
      const list = await api.renameIdea(project.id, r.branch, r.name)
      useStudio.setState((s) => ({ ideas: { ...s.ideas, [project.id]: list } }))
    } catch (e) {
      toast.error("Couldn't rename it", { description: errMsg(e) })
    }
  }
  const openIdeaBranch = ideas?.ideas.find((i) => i.current)?.branch

  const renderSession = (s: Row, depth: number): React.ReactNode => {
    // the active session shows the live figure (same as header + status bar); others the catalog's cumulative cost
    const total = s.id === activeSession && agentStatus ? Math.max(agentStatus.costUsd, s.costUsd ?? 0) : s.costUsd
    // A tried idea's chat starts as a copy of the one it came from: show only what it cost on top (E2E #2 P3)
    const inherited = forkCost.get(s.id) ?? 0
    const cost = total != null && inherited > 0 ? Math.max(0, total - inherited) : total
    const costTitle = inherited > 0 && total != null ? `This idea's chat cost ${fmtCost(cost ?? 0)} so far (${fmtCost(total)} including the chat it started from)` : undefined
    return (
      <div key={s.id}>
        <button
          onClick={() => void choose(s.id)}
          className={cn(
            "flex h-6 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            s.id === activeSession && "bg-primary/15 text-foreground hover:bg-primary/20",
          )}
          style={{ paddingLeft: 12 + depth * 12 }}
          title={[s.title, s.firstPrompt, branchOf.get(s.id) ? `files: ${branchOf.get(s.id)}` : null].filter(Boolean).join("\n")}
        >
          {switching === s.id ? (
            <Loader2Icon className="size-3 shrink-0 animate-spin" />
          ) : depth ? (
            <LightbulbIcon className="size-3 shrink-0 text-warn/80" />
          ) : (
            <MessageSquareIcon className="size-3 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {s.firstPrompt && (!s.title || s.title === "Design session") ? s.firstPrompt : s.title || "Untitled session"}
          </span>
          {s.lastMessageAt && <span className="shrink-0 text-micro opacity-70">{fmtRelative(s.lastMessageAt)}</span>}
          {cost ? <Cost usd={cost} note={costTitle} className="shrink-0 text-micro opacity-70" /> : null}
        </button>
        {children(s.id).map((c) => renderSession(c, depth + 1))}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-auto py-1">
      <Section
        title="Parts"
        count={project.parts.length}
        action={
          <>
            {project.parts.length > 1 && (
              <button
                className="flex h-5 shrink-0 items-center rounded-sm px-1 text-micro whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
                title={hiddenParts.length ? "Show every part in the Assembled and Plate views" : "Hide every part (then pick the ones to show)"}
                onClick={() => setPartsHidden(project.id, hiddenParts.length ? [] : project.parts.map((p) => p.id))}
              >
                {hiddenParts.length ? "Show all" : "Hide all"}
              </button>
            )}
            <button
              className="flex h-5 shrink-0 items-center gap-0.5 rounded-sm px-1 text-micro whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Import an STL, 3MF or OpenSCAD file into this project (or drop it anywhere here)"
              onClick={requestImport}
            >
              <UploadIcon className="size-3" /> Import
            </button>
          </>
        }
      >
        {project.parts.length === 0 && <div className="px-3 py-1 text-caption text-muted-foreground">No parts yet — ask the agent.</div>}
        {project.parts.map((p) => {
          const k = partKey(project.id, p.id)
          const busy = rendering[k]
          const err = renders[k]?.error
          const sev = checks[k]?.summary
          const off = hiddenParts.includes(p.id)
          return (
            <div
              key={p.id}
              className={cn(
                "group flex h-6 items-center rounded-md hover:bg-muted/60",
                selected === p.id && "bg-primary/15 text-foreground hover:bg-primary/20",
              )}
            >
            <button
              onClick={() => togglePart(project.id, p.id)}
              className={cn(
                "flex h-full w-6 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground",
                !off && "opacity-40 group-hover:opacity-100",
              )}
              aria-pressed={!off}
              aria-label={`${off ? "Show" : "Hide"} ${p.id} in the Assembled and Plate views`}
              title={off ? "Hidden in the Assembled and Plate views — click to show" : "Shown in the Assembled and Plate views — click to hide"}
            >
              {off ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </button>
            <button
              onClick={() => selectPart(p.id)}
              className={cn("flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left text-xs", off && "text-muted-foreground")}
              title={
                p.imported?.kind === "mesh"
                  ? `${p.file}\nImported mesh (${p.imported.originalName}): can be scaled, rotated and placed, but not reshaped by parameters. Licence: ${p.imported.licence}`
                  : p.imported
                    ? `${p.file}\nImported OpenSCAD file (${p.imported.originalName}). Licence: ${p.imported.licence}`
                    : p.file
              }
            >
              {p.imported?.kind === "mesh" ? <CuboidIcon className="size-3.5 shrink-0 text-warn/80" /> : <FileCode2Icon className="size-3.5 shrink-0 text-warn/80" />}
              <span className="min-w-0 flex-1 truncate">{p.id}</span>
              {p.imported && (
                <span className="shrink-0 rounded-sm border border-line px-1 text-micro text-muted-foreground">{p.imported.kind === "mesh" ? "mesh" : "imported"}</span>
              )}
              {busy && <Loader2Icon className="size-3 animate-spin text-muted-foreground" />}
              {!busy && err && <TriangleAlertIcon className="size-3 text-err" />}
              {!busy && !err && sev && (
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    sev === "fail" ? "bg-err" : sev === "warn" ? "bg-warn" : "bg-ok",
                  )}
                  title={`checks: ${sev}`}
                />
              )}
              <span className="flex gap-0.5">
                {p.colors?.slice(0, 4).map((c, i) => (
                  <span key={i} className="size-2 rounded-full border border-foreground/20" style={{ background: toneOf(c) ?? c }} title={c} />
                ))}
              </span>
              {p.qty > 1 && <span className="text-micro text-muted-foreground tabular-nums">×{p.qty}</span>}
            </button>
            </div>
          )
        })}
      </Section>
      <Section title="Files" key={`files:${project.id}`} defaultOpen={false} forceOpen={fileBrowser.forceOpen} action={fileBrowser.action} {...fileBrowser.dropProps}>
        {fileBrowser.body}
      </Section>
      {assembly?.assembly && (
        <Section title="Assembly">
          <button
            onClick={() => setCenterTab("assembly")}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-md pr-2 pl-3 text-left text-xs hover:bg-muted/60",
              centerTab === "assembly" && "bg-primary/15 text-foreground hover:bg-primary/20",
            )}
            title="Open the assembly guide"
          >
            <ListOrderedIcon className="size-3.5 shrink-0 text-primary/80" />
            <span className="min-w-0 flex-1 truncate">{assembly.assembly.title ?? "Assembly guide"}</span>
            <span className="text-micro text-muted-foreground tabular-nums">{assembly.assembly.steps.length === 1 ? "1 step" : `${assembly.assembly.steps.length} steps`}</span>
            {!assembly.guideUrl && <span className="size-1.5 bg-warn rounded-full" title="Guide not built yet" />}
          </button>
        </Section>
      )}
      {assembly?.error && (
        <div className="flex items-center gap-1.5 px-3 py-1 text-caption text-err" title={assembly.error}>
          <TriangleAlertIcon className="size-3" /> assembly.json invalid
        </div>
      )}
      {(ideas?.ideas.length ?? 0) > 1 && (
        <Section
          title="Ideas"
          count={ideas!.ideas.length}
          action={
            <button
              className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Compare ideas side by side"
              aria-label="Compare ideas"
              onClick={() => {
                const other = ideas!.ideas.filter((i) => !i.current).sort((x, y) => y.tip.date.localeCompare(x.tip.date))[0]
                openCompare(project.id, other?.branch ?? "current", openIdeaBranch ?? "current")
              }}
            >
              <CompareIcon className="size-3.5" />
            </button>
          }
        >
          {ideas!.ideas.map((i) =>
            renaming?.branch === i.branch ? (
              <input
                key={i.branch}
                autoFocus
                className="mx-2 h-6 border bg-background px-1.5 text-xs outline-none focus:border-primary"
                value={renaming.name}
                maxLength={60}
                aria-label="Idea name"
                onChange={(e) => setRenaming({ branch: i.branch, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName()
                  if (e.key === "Escape") setRenaming(null)
                }}
                onBlur={() => void saveName()}
              />
            ) : (
              <div
                key={i.branch}
                className={cn(
                  "group flex h-6 items-center gap-1.5 rounded-md pr-1 pl-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  i.current && "bg-primary/15 text-foreground hover:bg-primary/20",
                )}
                title={`${i.name}\nnewest: “${i.tip.message}” · ${new Date(i.tip.date).toLocaleString()}${i.startedFrom ? `\nstarted from ${i.startedFrom.idea ?? "another idea"}` : ""}\n${i.sessionCount} chat${i.sessionCount === 1 ? "" : "s"}`}
              >
                <button className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => !i.current && void openIdea(i.branch, i.name)} disabled={i.current}>
                  {switching === `idea:${i.branch}` ? (
                    <Loader2Icon className="size-3 shrink-0 animate-spin" />
                  ) : (
                    <LightbulbIcon className={cn("size-3 shrink-0", i.current ? "text-warn" : "text-warn/60")} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                </button>
                {i.current ? (
                  <span className="shrink-0 rounded-sm border border-primary/40 px-1 text-micro text-primary group-hover:hidden">open</span>
                ) : (
                  <span className="shrink-0 text-micro opacity-70 group-hover:hidden">{fmtRelative(i.tip.date)}</span>
                )}
                <span className="hidden shrink-0 items-center group-hover:flex">
                  {!i.current && (
                    <button
                      className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                      title="Compare with the open idea"
                      aria-label={`Compare ${i.name} with the open idea`}
                      onClick={() => openCompare(project.id, i.branch, openIdeaBranch ?? "current")}
                    >
                      <CompareIcon className="size-3" />
                    </button>
                  )}
                  <button
                    className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                    title="Rename this idea"
                    aria-label={`Rename ${i.name}`}
                    onClick={() => setRenaming({ branch: i.branch, name: i.name })}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                </span>
              </div>
            ),
          )}
        </Section>
      )}
      <Section
        title="Sessions"
        count={rows.length}
        defaultOpen={false}
        action={
          <button
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            title="New session"
            onClick={() => void choose(null)}
          >
            {switching === "new" ? <Loader2Icon className="size-3 animate-spin" /> : <PlusIcon className="size-3.5" />}
          </button>
        }
      >
        {activeSession === null && (
          <div className="flex h-6 items-center gap-1.5 rounded-md bg-primary/15 pr-2 pl-3 text-xs text-foreground">
            <MessageSquareIcon className="size-3 shrink-0" />
            <span className="truncate italic">New session · send a message</span>
          </div>
        )}
        {rows.length === 0 && activeSession !== null && <div className="px-3 py-1 text-caption text-muted-foreground">No sessions yet.</div>}
        {roots.map((s) => renderSession(s, 0))}
      </Section>
      <Section title="Versions" count={versions?.list.length} defaultOpen={false}>
        {!versions?.list.length && <div className="px-3 py-1 text-caption text-muted-foreground">No saved versions yet.</div>}
        {(showAll ? versions?.list : versions?.list.slice(0, 12))?.map((v, i) => (
          <div
            key={v.commit}
            className="group flex h-6 items-center gap-1.5 rounded-md pr-1 pl-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            title={`${v.message}\n${new Date(v.date).toLocaleString()} · ${v.author === "agent" ? "by the designer" : "by you"}\n${v.short}${versions?.branch ? ` on ${versions.branch}` : ""}`}
          >
            {v.author === "agent" ? (
              <SparklesIcon className="size-3 shrink-0 text-primary/80" />
            ) : (
              <UserIcon className="size-3 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {/^restore /.test(v.message) ? `Back to “${v.message.slice(8)}”` : v.message || "Saved version"}
            </span>
            {i === 0 ? (
              <span className="shrink-0 rounded-sm border border-primary/40 px-1 text-micro text-primary group-hover:hidden">now</span>
            ) : (
              <span className="shrink-0 text-micro text-faint group-hover:hidden">{fmtRelative(v.date)}</span>
            )}
            <span className="hidden shrink-0 items-center group-hover:flex">
              {i > 0 && (
                <button
                  className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  title="Go back to this version"
                  aria-label={`Go back to version: ${v.message}`}
                  onClick={() => askRestore(project.id, v.commit, v.message)}
                >
                  <RotateCcwIcon className="size-3" />
                </button>
              )}
              {i > 0 && (
                <button
                  className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                  title="Compare this version with now"
                  aria-label={`Compare version ${v.message} with now`}
                  onClick={() => openCompare(project.id, v.commit, "current")}
                >
                  <CompareIcon className="size-3" />
                </button>
              )}
              <button
                className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                title="Try another idea from this version"
                aria-label={`Try another idea from version: ${v.message}`}
                onClick={() => askTryIdea(project.id, i === 0 ? undefined : v.commit, v.message)}
              >
                <LightbulbIcon className="size-3" />
              </button>
            </span>
          </div>
        ))}
        {!showAll && (versions?.list.length ?? 0) > 12 && (
          <button className="px-3 py-0.5 text-left text-caption text-muted-foreground hover:text-foreground" onClick={() => setShowAll(true)}>
            Show all {versions!.list.length}
          </button>
        )}
      </Section>
      {project.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1 px-3">
            {project.tags.map((t) => (
              <span key={t} className="rounded-sm bg-muted px-1 text-micro text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}
