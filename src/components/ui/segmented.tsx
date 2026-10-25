import { useRef } from "react"
import { cn } from "@/lib/utils"

/**
 * Segmented control (a small radio group): the selected segment is a raised stone pill: it reads at a
 * glance without competing with the screen's one solid primary action. Arrow keys move the choice (roving tabindex), like native radios.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: React.ReactNode; title?: string }[]
  label: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const move = (d: number) => {
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + d + options.length) % options.length]
    onChange(next.value)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus())
  }
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex h-7 w-fit items-stretch gap-0.5 rounded-full border border-line bg-surface-2 p-0.5", className)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault()
          move(1)
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault()
          move(-1)
        }
      }}
    >
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1 rounded-full px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              on ? "bg-surface-3 font-medium text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)]" : "text-muted-foreground hover:bg-surface-3 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
