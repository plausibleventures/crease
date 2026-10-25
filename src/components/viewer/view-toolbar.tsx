import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { PointToolButton } from "./pins"
import type { Fit, View } from "./shared"

const VIEWS: View[] = ["iso", "front", "top", "right"]

/** One small glass capsule of related buttons over the 3D view (src/glass.css .ps-glass-ctl: pill buttons inside). */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="ps-glass-ctl flex gap-px rounded-md border bg-surface-1/90 p-px backdrop-blur">
      {children}
    </div>
  )
}

const btn = "h-6 rounded-sm px-1.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground"

/**
 * The 3D views' toolbar, in three groups so it reads as three choices: what to show (Part · Assembled · Plate),
 * where the camera looks (Iso · Front · Top · Right, then Fit · Bed), and the Point tool.
 */
export function ViewToolbar({
  show,
  view,
  fit,
  onView,
  onFit,
  fitTitles = { part: "Zoom to the part", plate: "Show the whole bed" },
}: {
  show: ReactNode
  view: View
  fit: Fit
  onView: (v: View) => void
  onFit: (f: Fit) => void
  fitTitles?: Record<Fit, string>
}) {
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <Group label="Show">{show}</Group>
      <Group label="Camera">
        {VIEWS.map((v) => (
          <button key={v} onClick={() => onView(v)} aria-pressed={view === v} className={cn(btn, "capitalize", view === v && "text-foreground")}>
            {v}
          </button>
        ))}
        <span aria-hidden className="my-1 w-px bg-border" />
        {(["part", "plate"] as Fit[]).map((f) => (
          <button key={f} onClick={() => onFit(f)} title={fitTitles[f]} aria-pressed={fit === f} className={cn(btn, fit === f && "bg-primary/15 text-foreground")}>
            {f === "part" ? "Fit" : "Bed"}
          </button>
        ))}
      </Group>
      <Group label="Tools">
        <PointToolButton />
      </Group>
    </div>
  )
}
