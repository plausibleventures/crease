// Templates: bundled starter projects. Clicking one copies it into a new project.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { BoxIcon, Loader2Icon } from "@/components/icons"
import type { Starter } from "@shared/types"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"

/** The bundled templates; null while loading. */
export function useStarters(): Starter[] | null {
  const [starters, setStarters] = useState<Starter[] | null>(null)
  useEffect(() => {
    api
      .starters()
      .then((s) => setStarters(Array.isArray(s) ? s : []))
      .catch(() => setStarters([]))
  }, [])
  return starters
}

/** A compact grid of templates: picture and name. The blurb is the hover text. */
export function StarterGrid({ starters, onStarted }: { starters: Starter[]; onStarted?: () => void }) {
  const navigate = useStudio((s) => s.navigate)
  const [busy, setBusy] = useState<string | null>(null)

  const use = async (st: Starter) => {
    setBusy(st.id)
    try {
      const p = await api.useStarter(st.id)
      const hint = st.firstMessage ?? "Make it yours: tell me what to change."
      useStudio.setState((s) => ({ starterHint: { ...s.starterHint, [p.id]: hint } }))
      onStarted?.()
      void useStudio.getState().loadProjects()
      navigate({ name: "project", id: p.id })
      toast(`Started from “${st.title}”`, { description: hint, duration: 10000 })
    } catch (e) {
      toast.error("Couldn't start from that template", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div id="starter-gallery" className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
      {starters.map((st) => (
        <button
          key={st.id}
          onClick={() => void use(st)}
          disabled={busy !== null}
          title={st.blurb}
          aria-label={`Use the ${st.title} template`}
          className="group flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:border-primary/60 focus-visible:border-primary/60 disabled:opacity-60"
        >
          <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-stage">
            {st.thumbnailUrl ? (
              <img src={st.thumbnailUrl} alt="" className="size-full object-contain transition-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100" />
            ) : (
              <BoxIcon className="size-8 text-faint" />
            )}
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs">
            {busy === st.id && <Loader2Icon className="size-3 animate-spin" />}
            <span className="truncate">{st.title}</span>
          </div>
        </button>
      ))}
    </div>
  )
}
