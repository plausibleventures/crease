import { useEffect, useRef, type ReactNode, type SVGProps } from "react"
import { ChatNozzle, LittlePrinter, NozzleDrawing, PartsExploded, Spool } from "@/design/illustrations"
import { ChevronDownIcon } from "@/components/icons"
import { cn } from "@/lib/utils"

export function PanelHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-8 shrink-0 items-center gap-1 border-b px-2", className)}>
      <div className="ps-label min-w-0 flex-1 truncate">{title}</div>
      {children}
    </div>
  )
}

/**
 * NAV-03: the one page header for Library, Machines and Designers: the title on the left; filters and search, then
 * the page's one primary action, on the right. It sits at the top of the page body, under the app's nav bar.
 */
export function PageHeader({ title, children, primary }: { title: ReactNode; children?: ReactNode; primary?: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2">
      <h1 className="ps-title mr-auto text-xl">{title}</h1>
      {children}
      {primary}
    </div>
  )
}

export type EmptyArt = "projects" | "render" | "machines" | "assembly" | "agent"
const ART: Record<EmptyArt, (p: SVGProps<SVGSVGElement>) => ReactNode> = {
  projects: Spool,
  render: NozzleDrawing,
  machines: LittlePrinter,
  assembly: PartsExploded,
  agent: ChatNozzle,
}

export function EmptyState({
  icon,
  art,
  title,
  detail,
  action,
  className,
}: {
  icon?: ReactNode
  /** line-art illustration for the key empty states (replaces the icon) */
  art?: EmptyArt
  title: ReactNode
  detail?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const Art = art ? ART[art] : null
  return (
    <div className={cn("ps-enter flex h-full min-h-24 flex-col items-center justify-center gap-1.5 p-4 text-center", className)}>
      {Art ? (
        <div className="mb-1 text-muted-foreground [--sb-accent:var(--primary)] [--sb-art-stroke:1.5]">
          <Art width={150} height={105} />
        </div>
      ) : (
        icon && <div className="text-faint [&_svg]:size-6">{icon}</div>
      )}
      <div className={cn("font-medium", Art ? "text-sm text-foreground" : "text-xs text-muted-foreground")}>{title}</div>
      {detail && <div className="max-w-xs text-xs break-words text-muted-foreground">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export interface TabDef<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  badge?: ReactNode
}

/**
 * Compact IDE-style tab strip. `secondary` tabs (inspection views an expert reaches for, not a newcomer's first stop)
 * sit at the far end in a quieter style: still one click away.
 */
export function TabStrip<T extends string>({
  tabs,
  secondary,
  value,
  onChange,
  right,
  className,
}: {
  tabs: TabDef<T>[]
  secondary?: TabDef<T>[]
  value: T
  onChange: (v: T) => void
  right?: ReactNode
  className?: string
}) {
  const tab = (t: TabDef<T>, quiet?: boolean) => (
    <button
      key={t.id}
      role="tab"
      aria-selected={value === t.id}
      onClick={() => onChange(t.id)}
      className={cn(
        "relative flex items-center gap-1.5 text-muted-foreground transition-colors duration-[120ms] hover:text-foreground",
        quiet ? "px-2 text-caption [&_svg]:size-3" : "px-3 text-xs [&_svg]:size-3.5",
        "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:origin-center after:scale-x-0 after:bg-primary after:transition-transform after:duration-200",
        value === t.id && "text-foreground after:scale-x-100",
      )}
    >
      {t.icon}
      {t.label}
      {t.badge}
    </button>
  )
  return (
    <div className={cn("flex h-8 shrink-0 items-stretch border-b bg-sidebar", className)} role="tablist">
      {tabs.map((t) => tab(t))}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1 px-1.5">{right}</div>
      {secondary?.map((t) => tab(t, true))}
    </div>
  )
}

/** Call `onEscape` when Escape is pressed while `active` (for lightweight overlays/lightboxes). */
export function useEscape(active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape)
  useEffect(() => {
    cb.current = onEscape
  })
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      cb.current()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [active])
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-sm border bg-muted px-1 font-mono text-micro text-muted-foreground">{children}</kbd>
}

/**
 * R2-DISC-01: the one "show more" control. A label and a chevron, plus an optional one-line summary of what's inside
 * ("All settings · 8", "Prints · 3"). It opens detail in place (pair it with useRemembered where a panel should
 * remember). Long pages use the Accordion, whose trigger has the same label · summary · chevron shape.
 */
export function DetailsToggle({
  open,
  onToggle,
  label = "Details",
  summary,
  controls,
  title,
  className,
}: {
  open: boolean
  onToggle: () => void
  label?: ReactNode
  /** one line about what's inside, shown after the label (a count, the current value) */
  summary?: ReactNode
  /** id of the region it shows/hides */
  controls?: string
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      title={title}
      className={cn(
        "inline-flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 text-caption text-muted-foreground transition-colors duration-[120ms] hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary [&_svg]:size-3",
        open && "text-foreground",
        className,
      )}
    >
      <span className="font-medium">{label}</span>
      {summary != null && summary !== "" && <span className="min-w-0 truncate font-normal text-muted-foreground">· {summary}</span>}
      <ChevronDownIcon className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
    </button>
  )
}
