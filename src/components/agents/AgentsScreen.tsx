// Designers (R11c, simplified): one table row per designer profile (name · service · status · model · ★ default).
// A row's one button is what it needs next (Sign in, Add key, …); everything else is in "⋯" or the row's Edit modal.
// "Add designer" opens a stepper modal. Services without a profile only appear inside Add designer.
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import type { AgentFailure, AgentProfilesResponse, AgentProfileView, AgentRuntimeInfo, AgentRuntimeProbe, CodexRuntimeSettings } from "@shared/types"
import { AppNav } from "@/components/AppNav"
import { AlertTriangleIcon, BotIcon, Loader2Icon, MoreHorizontalIcon, PencilIcon, PlusIcon, RefreshCwIcon, StarIcon, Trash2Icon } from "@/components/icons"
import { EmptyState, PageHeader } from "@/components/panel"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"
import { AddDesignerDialog } from "./AddDesigner"
import { takeAddDesignerRequest, useAddDesignerRequest } from "@/lib/add-designer"
import { codexMode } from "./codex-access"
import { DesignerDialog, FailureTable, type DesignerContext } from "./DesignerDialog"
import { modelLabel } from "./Model"
import { Hint, profileHealth, StatusDot, type Health } from "./parts"
import { SignInDialog, type BrowserLoginKind } from "./SignIn"

export { profileHealth, type Health } from "./parts"

export function AgentsScreen() {
  const rev = useStudio((s) => s.agentProfilesRev)
  const failRev = useStudio((s) => s.agentFailuresRev)
  const [data, setData] = useState<AgentProfilesResponse | null>(null)
  const [probes, setProbes] = useState<AgentRuntimeProbe[] | null>(null)
  const [failures, setFailures] = useState<AgentFailure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loadN, setLoadN] = useState(0)
  const [probeN, setProbeN] = useState(0)
  const [probedN, setProbedN] = useState(-1)
  const probing = probedN !== probeN
  const load = useCallback(() => setLoadN((n) => n + 1), [])
  const probe = useCallback(() => setProbeN((n) => n + 1), [])
  const [editId, setEditId] = useState<string | null>(null)
  // "Set up a designer" elsewhere (Make something, the chat) lands here with Add designer open
  const [adding, setAdding] = useState(() => useAddDesignerRequest.getState().pending)
  useEffect(() => {
    takeAddDesignerRequest() // consumed by the initial state above
    return useAddDesignerRequest.subscribe((s) => s.pending && takeAddDesignerRequest() && setAdding(true))
  }, [])
  const [signIn, setSignIn] = useState<BrowserLoginKind | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [problemsOpen, setProblemsOpen] = useState(false)

  useEffect(() => {
    let alive = true
    api.agentProfiles().then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(errMsg(e)),
    )
    return () => {
      alive = false
    }
  }, [loadN, rev])
  useEffect(() => {
    let alive = true
    api
      .agentRuntimes()
      .catch(() => [] as AgentRuntimeProbe[])
      .then((p) => {
        if (!alive) return
        setProbes(p)
        setProbedN(probeN)
      })
    return () => {
      alive = false
    }
  }, [probeN])
  useEffect(() => {
    // back from signing in (another window): check again
    window.addEventListener("focus", probe)
    return () => window.removeEventListener("focus", probe)
  }, [probe])
  // R11d: Codex sign-in settings (Settings.codex)
  const [codex, setCodex] = useState<CodexRuntimeSettings | undefined>(undefined)
  useEffect(() => {
    let alive = true
    api
      .getSettings()
      .then((s) => alive && setCodex(s?.codex ?? {}))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [rev, loadN])
  const onCodex = async (patch: CodexRuntimeSettings) => {
    try {
      const s = await api.putSettings({ codex: patch })
      setCodex(s.codex ?? {})
      probe()
      return true
    } catch (e) {
      toast.error("Couldn't change the Codex sign-in", { description: errMsg(e) })
      return false
    }
  }
  useEffect(() => {
    api
      .agentFailures(undefined, 20)
      .then(setFailures)
      .catch(() => {})
  }, [failRev])

  const runtimes = data?.runtimes ?? []
  const profiles = data?.profiles ?? []
  const infoOf = (kind: string) => runtimes.find((r) => r.kind === kind)
  const probeOf = (kind: string) => probes?.find((x) => x.runtime === kind)
  const ctxOf = (kind: string): DesignerContext => ({ info: infoOf(kind), probe: probeOf(kind), codex, onCodex, onProbe: probe })
  const replace = (v: AgentProfileView) => setData((d) => (d ? { ...d, profiles: d.profiles.map((x) => (x.id === v.id ? v : x)) } : d))
  const editing = profiles.find((p) => p.id === editId) ?? null
  const removing = profiles.find((p) => p.id === removeId) ?? null

  const setDefault = async (id: string) => {
    try {
      setData(await api.setDefaultAgentProfile(id))
    } catch (e) {
      toast.error("Couldn't change the default", { description: errMsg(e) })
    }
  }
  const test = async (p: AgentProfileView) => {
    const t = toast.loading(`Testing ${p.name}…`)
    try {
      const r = await api.testAgentProfile(p.id)
      probe()
      if (r.ok) toast.success(`${p.name} is ready`, { id: t })
      else toast.error(r.summary, { id: t, action: { label: "Fix", onClick: () => setEditId(p.id) } })
    } catch (e) {
      toast.error("Couldn't test it", { id: t, description: errMsg(e) })
    }
  }
  const remove = async (p: AgentProfileView) => {
    try {
      await api.deleteAgentProfile(p.id)
      load()
    } catch (e) {
      toast.error("Couldn't remove it", { description: errMsg(e) })
    } finally {
      setRemoveId(null)
    }
  }
  /** The row's one button: what this designer needs next. */
  const nextAction = (p: AgentProfileView, h: Health, info: AgentRuntimeInfo | undefined) => {
    switch (h.next) {
      case "sign-in": {
        const browser = p.runtime === "grok" || (p.runtime === "codex" && codexMode(p.auth, codex) === "app")
        return { label: "Set up", run: () => (browser ? setSignIn(p.runtime as BrowserLoginKind) : setEditId(p.id)) }
      }
      case "add-key":
        return { label: "Set up", run: () => setEditId(p.id) }
      case "allow":
        return { label: "Allow", run: () => setEditId(p.id) }
      case "install":
        return info?.homepage ? { label: "Install", run: () => window.open(info.homepage, "_blank", "noopener") } : null
      case "check":
        return { label: "Check again", run: probe }
      default:
        return null
    }
  }
  // One solid action per screen: while a designer waits for its key or sign-in, its row's "Set up" is the main
  // action and Add designer steps back to outline.
  const setupWaiting = profiles.some((p) => {
    const next = profileHealth(p, infoOf(p.runtime), probeOf(p.runtime)).next
    return next === "sign-in" || next === "add-key"
  })

  return (
    <div className="relative flex h-full flex-col">
      <header data-glass-chrome="top" className="flex h-10 shrink-0 items-center gap-2 border-b bg-sidebar px-3">
        <AppNav />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {!data && error ? (
          <EmptyState icon={<BotIcon />} title="Couldn't load designers" detail={error} action={<Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>} />
        ) : !data ? (
          <EmptyState icon={<Loader2Icon className="animate-spin" />} title="Loading…" />
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4 p-5">
            <PageHeader
              title="Designers"
              primary={
                <Button size="sm" variant={setupWaiting ? "outline" : "default"} onClick={() => setAdding(true)}>
                  <PlusIcon /> Add designer
                </Button>
              }
            >
              <Button variant="ghost" size="sm" onClick={() => void probe()} title="Check every designer again" disabled={probing}>
                <RefreshCwIcon className={cn(probing && "animate-spin")} /> Check again
              </Button>
            </PageHeader>

            {profiles.length === 0 ? (
              <EmptyState icon={<BotIcon />} title="No designers yet." action={<Button size="sm" onClick={() => setAdding(true)}>Add designer</Button>} />
            ) : (
              <Table aria-label="Designers">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden sm:table-cell">Service</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Model</TableHead>
                    <TableHead>
                      <span className="flex items-center gap-1">
                        Default <Hint>New chats use the ★ designer. A project can pick its own.</Hint>
                      </span>
                    </TableHead>
                    <TableHead className="w-10" aria-label="Actions" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profiles.map((p) => {
                    const info = infoOf(p.runtime)
                    const pr = probeOf(p.runtime)
                    const h = profileHealth(p, info, pr)
                    const next = nextAction(p, h, info)
                    return (
                      <TableRow key={p.id} className="cursor-pointer focus-within:bg-muted/40" onClick={() => setEditId(p.id)}>
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <BotIcon className="size-4 shrink-0 text-primary" aria-hidden />
                            {/* the row's keyboard target (Tab, Enter): opens Edit like a row click */}
                            <button
                              type="button"
                              className="truncate font-medium outline-offset-2 hover:underline"
                              aria-label={`Edit ${p.name}`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditId(p.id)
                              }}
                            >
                              {p.name}
                            </button>
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground sm:table-cell">{info?.label ?? p.runtime}</TableCell>
                        <TableCell>
                          <StatusDot h={h} />
                        </TableCell>
                        <TableCell className="hidden max-w-48 truncate text-muted-foreground md:table-cell">{modelLabel(p, pr)}</TableCell>
                        <TableCell>
                          <button
                            className={cn("p-0.5", p.isDefault ? "text-primary" : "text-muted-foreground opacity-30 hover:opacity-100")}
                            aria-label={p.isDefault ? `${p.name} is the default` : `Make ${p.name} the default`}
                            aria-pressed={p.isDefault}
                            title={p.isDefault ? "Default" : "Make default"}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (!p.isDefault) void setDefault(p.id)
                            }}
                          >
                            <StarIcon className="size-4" />
                          </button>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <span className="flex items-center justify-end gap-1">
                            {next && (
                              <Button size="xs" variant={h.next === "sign-in" || h.next === "add-key" ? "default" : "outline"} onClick={next.run}>
                                {next.label}
                              </Button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${p.name} menu`} title="More" />}>
                                <MoreHorizontalIcon />
                              </DropdownMenuTrigger>
                              <DropdownMenuContent>
                                <DropdownMenuItem onClick={() => setEditId(p.id)}>
                                  <PencilIcon /> Edit
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => void test(p)}>
                                  <RefreshCwIcon /> Test connection
                                </DropdownMenuItem>
                                {!p.isDefault && (
                                  <DropdownMenuItem onClick={() => void setDefault(p.id)}>
                                    <StarIcon /> Make default
                                  </DropdownMenuItem>
                                )}
                                {!p.isDefault && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => setRemoveId(p.id)}>
                                      <Trash2Icon /> Remove
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}

            {failures.length > 0 && (
              <button className="flex items-center gap-1.5 self-start text-caption text-muted-foreground hover:text-foreground" onClick={() => setProblemsOpen(true)}>
                <AlertTriangleIcon className="size-3 text-warn" /> {failures.length} recent {failures.length === 1 ? "problem" : "problems"}
              </button>
            )}
          </div>
        )}
      </div>

      <DesignerDialog
        p={editing}
        ctx={ctxOf(editing?.runtime ?? "")}
        failures={failures.filter((f) => f.profileId === editing?.id)}
        onChanged={replace}
        onReload={load}
        onClose={() => setEditId(null)}
      />
      <AddDesignerDialog
        open={adding}
        onOpenChange={setAdding}
        runtimes={runtimes}
        probes={probes}
        profiles={profiles}
        codex={codex}
        onCodex={onCodex}
        onProbe={probe}
        onCreated={load}
      />
      {signIn && <SignInDialog kind={signIn} open onOpenChange={(o) => !o && setSignIn(null)} onDone={probe} />}
      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoveId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove “{removing?.name}”?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setRemoveId(null)}>
              Keep
            </Button>
            <Button size="sm" variant="destructive" onClick={() => removing && void remove(removing)}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={problemsOpen} onOpenChange={setProblemsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Recent problems</DialogTitle>
          </DialogHeader>
          <FailureTable failures={failures.slice(0, 10)} showProfile onOpen={() => setProblemsOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
