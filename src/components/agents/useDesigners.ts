// The designers, their services and whether each is signed in, for screens outside Designers (first-run setup).
// Probing is local and free (no model call): it asks each installed program whether it is signed in.
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import type { AgentProfilesResponse, AgentProfileView, AgentRuntimeProbe, CodexRuntimeSettings } from "@shared/types"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"
import type { DesignerContext } from "./DesignerDialog"
import { profileHealth, type Health } from "./parts"

export function useDesigners() {
  const rev = useStudio((s) => s.agentProfilesRev)
  const [data, setData] = useState<AgentProfilesResponse | null>(null)
  const [probes, setProbes] = useState<AgentRuntimeProbe[] | null>(null)
  const [codex, setCodex] = useState<CodexRuntimeSettings | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loadN, setLoadN] = useState(0)
  const [probeN, setProbeN] = useState(0)
  const reload = useCallback(() => setLoadN((n) => n + 1), [])
  const probe = useCallback(() => setProbeN((n) => n + 1), [])

  useEffect(() => {
    let alive = true
    api.agentProfiles().then(
      (d) => alive && (setData(d), setError(null)),
      (e) => alive && setError(errMsg(e)),
    )
    api
      .getSettings()
      .then((s) => alive && setCodex(s?.codex ?? {}))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [loadN, rev])
  useEffect(() => {
    let alive = true
    api
      .agentRuntimes()
      .catch(() => [] as AgentRuntimeProbe[])
      .then((p) => alive && setProbes(p))
    return () => {
      alive = false
    }
  }, [probeN])
  useEffect(() => {
    // back from signing in in another window: check again
    window.addEventListener("focus", probe)
    return () => window.removeEventListener("focus", probe)
  }, [probe])

  const onCodex = useCallback(
    async (patch: CodexRuntimeSettings) => {
      try {
        const s = await api.putSettings({ codex: patch })
        setCodex(s.codex ?? {})
        probe()
        return true
      } catch (e) {
        toast.error("Couldn't change the Codex sign-in", { description: errMsg(e) })
        return false
      }
    },
    [probe],
  )

  const runtimes = data?.runtimes ?? []
  const profiles = data?.profiles ?? []
  const ctxOf = (kind: string): DesignerContext => ({
    info: runtimes.find((r) => r.kind === kind),
    probe: probes?.find((x) => x.runtime === kind),
    codex,
    onCodex,
    onProbe: probe,
  })
  const healthOf = (p: AgentProfileView): Health => profileHealth(p, runtimes.find((r) => r.kind === p.runtime), probes?.find((x) => x.runtime === p.runtime))
  const replace = (v: AgentProfileView) => setData((d) => (d ? { ...d, profiles: d.profiles.map((x) => (x.id === v.id ? v : x)) } : d))

  return { data, runtimes, profiles, probes, codex, onCodex, error, reload, probe, ctxOf, healthOf, replace }
}
