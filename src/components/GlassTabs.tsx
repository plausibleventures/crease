import { useLayoutEffect, useRef, useState } from "react"
import type { TabDef } from "@/components/panel"
import { cn } from "@/lib/utils"

/**
 * The workspace's view switcher as one floating glass capsule (Liquid Glass's grouped controls: one
 * shared container, never a glass pill per button). The selection is a single pill that slides and stretches to the
 * picked tab (the "morph"), on the glass spring (--glass-spring; none under Reduce Motion). Secondary tabs sit after
 * a gap in the same capsule, quieter.
 */
export function GlassTabs<T extends string>({
  tabs,
  secondary = [],
  value,
  onChange,
  label,
  compact = false,
}: {
  tabs: TabDef<T>[]
  secondary?: TabDef<T>[]
  value: T
  onChange: (v: T) => void
  label: string
  compact?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const place = () => {
      const el = root.querySelector<HTMLElement>(`[data-tab="${CSS.escape(value)}"]`)
      setPill(el ? { x: el.offsetLeft, w: el.offsetWidth } : null)
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(root)
    return () => ro.disconnect()
  }, [value, tabs.length, secondary.length, compact])

  const tab = (t: TabDef<T>, quiet?: boolean) => {
    // compact (a narrow gap): only the picked tab keeps its label; the rest are icons with the label as a tooltip
    const iconOnly = compact && value !== t.id && !!t.icon
    const name = typeof t.label === "string" ? t.label : undefined
    return (
      <button
        key={t.id}
        data-tab={t.id}
        role="tab"
        aria-selected={value === t.id}
        aria-label={iconOnly ? name : undefined}
        title={iconOnly ? name : undefined}
        onClick={() => onChange(t.id)}
        className={cn(
          "relative z-10 flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground [&_svg]:size-3.5",
          quiet && "px-2.5 text-caption [&_svg]:size-3",
          iconOnly && "px-2.5",
          value === t.id && "text-foreground",
        )}
      >
        {t.icon}
        {!iconOnly && t.label}
        {t.badge}
      </button>
    )
  }

  return (
    <div ref={ref} role="tablist" aria-label={label} className="ps-glass ps-glass-pill relative flex h-10 items-center p-1">
      {pill && <span aria-hidden className="ps-glass-thumb absolute top-1 bottom-1 left-0" style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} />}
      {tabs.map((t) => tab(t))}
      {secondary.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />}
      {secondary.map((t) => tab(t, true))}
    </div>
  )
}
