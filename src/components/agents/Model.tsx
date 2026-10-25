// The model a designer uses: the runtime's list (probe), or for the API connection the endpoint's own list (free).
import { useEffect, useState } from "react"
import type { AgentModelList, AgentProfile, AgentProfileView, AgentRuntimeProbe } from "@shared/types"
import { api } from "@/lib/api"
import { OptionSelect } from "@/components/ui/select"
import { Hint, keyOptional } from "./parts"

/** The "use the recommended model" choice (no model set). */
const DEFAULT_MODEL = "__default__"

export function useModels(p: AgentProfileView, probe: AgentRuntimeProbe | undefined) {
  const isApi = p.runtime === "api"
  const [found, setFound] = useState<AgentModelList | null>(null)
  useEffect(() => {
    if (!isApi) return
    let alive = true
    api
      .agentProfileModels(p.id)
      .then((r) => alive && setFound(r))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [isApi, p.id, p.credential?.set, p.credential?.last4, p.endpointRef, p.apiProtocol])
  const models = isApi ? (found?.models.length ? found.models : p.apiProtocol === "openai-chat" ? [] : (probe?.models ?? [])) : (probe?.models ?? [])
  const defaultId = found?.defaultModel ?? probe?.defaultModel
  const recommended = models.find((m) => m.value === defaultId)?.label ?? models[0]?.label ?? null
  const error = isApi && found?.error && (p.credential?.set || keyOptional(p)) ? found.error : null
  return { models, recommended, error, setFound }
}

/** Label for the table: the chosen model, else the recommended one. */
export function modelLabel(p: AgentProfileView, probe: AgentRuntimeProbe | undefined) {
  if (p.model) return probe?.models.find((m) => m.value === p.model)?.label ?? p.model
  const def = probe?.models.find((m) => m.value === probe.defaultModel)?.label
  return def ? `${def} (auto)` : "Automatic"
}

export function ModelField({
  p,
  probe,
  busy,
  save,
}: {
  p: AgentProfileView
  probe: AgentRuntimeProbe | undefined
  busy?: boolean
  save: (patch: Partial<AgentProfile>, what?: string) => Promise<boolean>
}) {
  const { models, recommended, error } = useModels(p, probe)
  const pickFirst = p.runtime === "api" && p.apiProtocol === "openai-chat"
  const inList = !p.model || models.some((m) => m.value === p.model)
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-muted-foreground">Model</span>
        <OptionSelect
          aria-label="Model"
          className="flex-1"
          value={p.model ?? DEFAULT_MODEL}
          disabled={busy || !models.length}
          onChange={(v) => void save({ model: v === DEFAULT_MODEL ? null : v }, "change the model")}
          options={[
            { value: DEFAULT_MODEL, label: pickFirst ? "Pick a model" : `Recommended${recommended ? ` (${recommended})` : ""}` },
            ...models.map((m) => ({ value: m.value, label: m.label })),
            ...(!inList && p.model ? [{ value: p.model, label: p.model }] : []),
          ]}
        />
        {!models.length && <Hint>{error ? `Couldn't list models: ${error}` : "Sign in first to see the models."}</Hint>}
      </label>
    </div>
  )
}
