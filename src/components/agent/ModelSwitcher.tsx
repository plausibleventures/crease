import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { AGENT_MODELS, type AgentProfilesResponse, type AgentRuntimeProbe, type ProjectAgentChoice } from "@shared/types"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"
import { switchDesigner } from "./HandoffDialog"

const MANAGE = "__manage__"
const FOLLOW = "__default__"
const enc = (profileId: string, model: string | null) => `${profileId}::${model ?? ""}`

let runtimesCache: { at: number; p: Promise<AgentRuntimeProbe[]> } | null = null
/** Runtime probes (models per runtime), shared by every switcher for a minute. */
function runtimeModels(): Promise<AgentRuntimeProbe[]> {
  if (!runtimesCache || Date.now() - runtimesCache.at > 60_000) runtimesCache = { at: Date.now(), p: api.agentRuntimes().catch(() => []) }
  return runtimesCache.p
}

/**
 * Designer + model for this project (R11b: a per-project override of the default agent profile). With one designer
 * it's the model picker it always was; with several, each designer's models are grouped. Applies from the next
 * message; "Follow the default" clears the project's own choice. The default itself changes only in Agents.
 */
export function ModelSwitcher({ projectId }: { projectId: string }) {
  const rev = useStudio((s) => s.agentProfilesRev)
  const navigate = useStudio((s) => s.navigate)
  const [choice, setChoice] = useState<ProjectAgentChoice | null>(null)
  const [profiles, setProfiles] = useState<AgentProfilesResponse | null>(null)
  const [probes, setProbes] = useState<AgentRuntimeProbe[]>([])

  useEffect(() => {
    let alive = true
    Promise.all([api.projectAgent(projectId).catch(() => null), api.agentProfiles().catch(() => null), runtimeModels()]).then(([c, p, r]) => {
      if (!alive) return
      setChoice(c)
      setProfiles(p)
      setProbes(r)
    })
    return () => {
      alive = false
    }
  }, [projectId, rev])

  const modelsOf = useMemo(
    () => (runtime: string, protocol?: string | null) =>
      (protocol === "openai-chat" ? [] : (probes.find((x) => x.runtime === runtime)?.models ?? (runtime === "claude" ? AGENT_MODELS.map((m) => ({ value: m.value, label: m.label })) : [])).map((m) => ({
        ...m,
        hint: AGENT_MODELS.find((a) => a.value === m.value)?.hint ?? "",
      }))),
    [probes],
  )

  if (!choice || !profiles) return null
  const eff = choice.effective
  const list = profiles.profiles
  const multi = list.length > 1
  const effModels = modelsOf(eff.runtime, eff.apiProtocol)
  const model = eff.model ?? effModels[0]?.value ?? null
  const value = enc(eff.profileId ?? "", model)
  const modelLabel = (runtime: string, m: string | null) => modelsOf(runtime, eff.apiProtocol).find((x) => x.value === m)?.label ?? m ?? "default"

  // Every option, so the trigger can show the current one (a custom model id still shows).
  const items = [
    ...list.flatMap((p) => {
      const ms = modelsOf(p.runtime, p.apiProtocol)
      const vals = ms.length ? ms : [{ value: p.model ?? "", label: p.model ?? "default", hint: "" }]
      return vals.map((m) => ({ value: enc(p.id, m.value || null), label: multi ? `${p.name} · ${m.label}` : m.label }))
    }),
    ...(effModels.some((m) => m.value === model) ? [] : [{ value, label: multi ? `${eff.name} · ${model ?? "default"}` : (model ?? "default") }]),
    { value: FOLLOW, label: "Follow the default" },
    { value: MANAGE, label: "Manage designers…" },
  ]

  async function change(next: string | null) {
    if (!next || next === value) return
    if (next === MANAGE) return navigate({ name: "agents" })
    try {
      let pid: string | null = null
      let m: string | null = null
      if (next !== FOLLOW) {
        const [profileId, mm] = next.split("::")
        // One designer: keep following the default profile, only the model is the project's own.
        pid = !multi && !choice?.profileId ? null : profileId
        m = mm || null
      }
      // R11g: another runtime with a conversation going: show what the new designer will be told first.
      await switchDesigner(projectId, pid, m, async () => setChoice(await api.setProjectAgent(projectId, pid, m)))
    } catch (e) {
      toast.error(`Couldn't switch: ${errMsg(e)}`)
    }
  }

  const title = `Designer: ${eff.name}, model ${modelLabel(eff.runtime, model)}${choice.profileId ? " (this project)" : " (default)"}`
  return (
    <Select items={items} value={value} onValueChange={(v) => void change(v as string | null)}>
      <SelectTrigger size="sm" className="h-6 max-w-40 min-w-0 shrink border-transparent px-1.5 text-caption *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:overflow-hidden" title={title} aria-label="Designer and model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="w-64">
        {list.map((p, i) => {
          const ms = modelsOf(p.runtime, p.apiProtocol)
          return (
            <SelectGroup key={p.id}>
              {i > 0 && <SelectSeparator />}
              {multi && (
                <SelectLabel>
                  {p.name}
                  {p.isDefault ? " (default)" : ""}
                </SelectLabel>
              )}
              {(ms.length ? ms : [{ value: p.model ?? "", label: p.model ?? "default", hint: "" }]).map((m) => (
                <SelectItem key={m.value} value={enc(p.id, m.value || null)}>
                  {m.label}
                  {m.hint && <span className="text-muted-foreground">{m.hint}</span>}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
        {!effModels.some((m) => m.value === model) && <SelectItem value={value}>{model ?? "default"}</SelectItem>}
        <SelectSeparator />
        {(choice.profileId || choice.model) && <SelectItem value={FOLLOW}>{multi ? "Follow the default designer" : "Use the default model"}</SelectItem>}
        <SelectItem value={MANAGE}>
          <span className="text-muted-foreground">Manage designers…</span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
