// Print intents ("what is this print for?") and the compact picker shown next to Slice.
import { useEffect, useRef, useState } from "react"
import type { PrintIntent, PrintIntentInfo } from "@shared/types"
import { CheckIcon, ChevronDownIcon as CaretDownIcon } from "@/components/icons"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"

// Used until the server lists them (GET /api/print-intents).
export const FALLBACK_INTENTS: PrintIntentInfo[] = [
  { id: "standard", label: "Standard", blurb: "Your printer's normal settings", overrides: {} },
  { id: "display", label: "Display piece", blurb: "Smooth top, crisp edges. Slower.", overrides: {} },
  { id: "strong", label: "Strong", blurb: "Thicker walls and fill for parts under load", overrides: {} },
  { id: "fast", label: "Fast", blurb: "Less inside, done sooner", overrides: {} },
  { id: "draft", label: "Draft", blurb: "Quickest test of size and fit", overrides: {} },
]

let cache: Promise<PrintIntentInfo[]> | null = null
export function usePrintIntents(): PrintIntentInfo[] {
  const [list, setList] = useState<PrintIntentInfo[]>(FALLBACK_INTENTS)
  useEffect(() => {
    let alive = true
    cache ??= api
      .printIntents()
      .then((l) => (Array.isArray(l) && l.length ? l : FALLBACK_INTENTS))
      .catch(() => {
        cache = null
        return FALLBACK_INTENTS
      })
    void cache.then((l) => alive && setList(l))
    return () => {
      alive = false
    }
  }, [])
  return list
}

export function intentLabel(list: PrintIntentInfo[], id: PrintIntent | undefined | null) {
  return list.find((i) => i.id === id)?.label ?? (id ? id[0].toUpperCase() + id.slice(1) : "Standard")
}

/** "Standard ▾" — picks the intent this project is sliced with (remembered per project). */
export function IntentPicker({ projectId }: { projectId: string }) {
  const intents = usePrintIntents()
  const current = useStudio((s) => s.intents[projectId] ?? s.intentFor(projectId))
  const setIntent = useStudio((s) => s.setIntent)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("mousedown", close)
    window.addEventListener("keydown", esc)
    return () => {
      window.removeEventListener("mousedown", close)
      window.removeEventListener("keydown", esc)
    }
  }, [open])
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="What is this print for? Changes the slicer settings."
        className="flex h-7 items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-2.5 text-caption text-foreground hover:border-primary/60"
      >
        {intentLabel(intents, current)}
        <CaretDownIcon className="size-3" />
      </button>
      {open && (
        <div role="listbox" aria-label="Print intent" className="ps-enter absolute top-8 right-0 z-50 w-72 rounded-lg border border-line-strong bg-popover p-1 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
          {intents.map((i) => (
            <button
              key={i.id}
              role="option"
              aria-selected={i.id === current}
              onClick={() => {
                setIntent(projectId, i.id)
                setOpen(false)
              }}
              className={cn("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-3", i.id === current && "bg-primary/10")}
            >
              <CheckIcon className={cn("mt-0.5 size-3.5 shrink-0 text-primary", i.id !== current && "invisible")} />
              <span>
                <span className="block text-xs font-medium text-foreground">{i.label}</span>
                <span className="block text-caption text-muted-foreground">{i.blurb}</span>
              </span>
            </button>
          ))}
          <div className="border-t border-line px-2 pt-1.5 pb-1 text-micro text-faint">Slice again after changing it.</div>
        </div>
      )}
    </div>
  )
}
