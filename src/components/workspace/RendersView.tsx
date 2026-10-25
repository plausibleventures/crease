import { useState } from "react"
import { ImagesIcon, Loader2Icon, XIcon } from "@/components/icons"
import { EmptyState, useEscape } from "@/components/panel"
import { partKey, useStudio } from "@/stores/studio"
import { StaleNote } from "./StaleNote"

export function RendersView({ projectId, partId }: { projectId: string; partId: string | null }) {
  const k = partId ? partKey(projectId, partId) : ""
  const result = useStudio((s) => s.renders[k])
  const rendering = useStudio((s) => !!s.rendering[k])
  const pv = useStudio((s) => (partId ? s.validity[projectId]?.parts[partId] : undefined))
  const render = useStudio((s) => s.render)
  // re-render with the Customizer values it renders with now (the render cache key includes them)
  const rerun = () => partId && void render(projectId, partId, pv?.overrides ?? undefined)
  const [zoom, setZoom] = useState<string | null>(null)
  useEscape(!!zoom, () => setZoom(null))

  if (!result?.images?.length)
    return (
      <EmptyState
        icon={rendering ? <Loader2Icon className="animate-spin" /> : <ImagesIcon />}
        title={rendering ? "Rendering previews…" : "No preview renders"}
        detail={result?.error ?? "Press Render to see the part."}
      />
    )

  const order = ["iso", "front", "back", "top", "right", "bed"]
  const imgs = [...result.images].sort((a, b) => order.indexOf(a.view) - order.indexOf(b.view))
  const zoomed = imgs.find((i) => i.url === zoom)

  return (
    <div className="absolute inset-0 flex flex-col">
      <StaleNote validity={pv?.render} onRerun={rerun} busy={rendering} label="Re-render" />
      <div className="relative min-h-0 flex-1">
      <div className="absolute inset-0 overflow-auto p-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {imgs.map((img) => (
          <button key={img.view} onClick={() => setZoom(img.url)} className="group flex flex-col overflow-hidden rounded-lg border bg-card text-left hover:border-primary/60">
            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-stage">
              <img src={img.url} alt={img.view} className="size-full object-contain" loading="lazy" />
            </div>
            <div className="flex h-6 items-center px-2 text-caption text-muted-foreground">{img.view}</div>
          </button>
        ))}
      </div>
      </div>
      {zoomed && (
        <div className="absolute inset-0 z-10 flex flex-col bg-background/95" onClick={() => setZoom(null)}>
          <div className="flex h-7 items-center justify-between border-b px-2 text-caption text-muted-foreground">
            {zoomed.view}
            <XIcon className="size-3.5" />
          </div>
          <img src={zoomed.url} alt={zoomed.view} className="min-h-0 flex-1 bg-stage object-contain p-2" />
        </div>
      )}
      {rendering && (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 border bg-surface-1/90 px-2 py-1 text-caption text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> Updating…
        </div>
      )}
      </div>
    </div>
  )
}
