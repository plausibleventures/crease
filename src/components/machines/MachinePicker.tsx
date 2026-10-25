import { toast } from "sonner"
import type { MachineWithStatus } from "@shared/types"
import { errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"
import { isUnreachable, machineState } from "./MachinesScreen"
import { CheckIcon, ChevronDownIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * Compact printer chooser. `reason(m)` returns why a machine can't be chosen (shown, disabled), or null.
 */
export function MachinePicker({
  value,
  onChange,
  reason,
  className,
  label = "Printer",
}: {
  value: string | null
  onChange: (id: string) => void
  reason?: (m: MachineWithStatus) => string | null
  className?: string
  label?: string
}) {
  const machines = useStudio((s) => s.machines)
  if (!machines?.length) return null
  const rows = machines.map((m) => ({ m, st: machineState(m), why: (!m.enabled && "turned off") || reason?.(m) || null }))
  // trigger text: "Name · state" (the default printer is marked on the Machines page, not here)
  const items = Object.fromEntries(rows.map(({ m, st, why }) => [m.id, `${m.name} · ${why ? cap(why) : st.label}`]))
  return (
    <Select items={items} value={value ?? ""} onValueChange={(v) => v && onChange(v as string)}>
      <SelectTrigger size="sm" aria-label={label} className={cn("max-w-full", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-56">
        {rows.map(({ m, st, why }) => (
          <SelectItem key={m.id} value={m.id} disabled={!!why && m.id !== value}>
            <span className={cn("size-2 shrink-0 self-center rounded-full", DOT[st.tone] ?? "bg-faint")} aria-hidden />
            <span className="min-w-0 truncate">{m.name}</span>
            <span className={cn("ml-auto pl-3 text-caption", why ? "text-muted-foreground" : st.tone)}>{why ? cap(why) : st.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * STATE-05: the project's printer is a real network printer that didn't answer (never the practice printer or a
 * print-by-hand one). Slicing still works; the place that offers Print says so in one line.
 */
export function useTargetOffline(projectId: string): MachineWithStatus | null {
  return useStudio((s) => {
    const m = s.machines?.find((x) => x.id === s.targetMachineId(projectId))
    return m && !m.isPractice && m.status && isUnreachable(m) ? m : null
  })
}

/** The sentence for an unreachable printer (glossary: status word "Offline", sentence "No answer from <name>"). */
export const offlineNote = (name: string) => `No answer from ${name} · slice now, print later`

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Status dot colour for a machine state tone (MachinesScreen machineState). */
export const DOT: Record<string, string> = {
  "text-primary": "bg-primary",
  "text-ok": "bg-ok",
  "text-warn": "bg-warn",
  "text-err": "bg-err",
  "text-muted-foreground": "bg-faint",
}

/**
 * "● SPARKX i7 · Offline ▾": the project's target printer (project.json `printer`). The dot and the state word are
 * always visible (NAV-04); the name truncates first. The menu lists every printer with its state.
 */
export function TargetMachineChip({ projectId }: { projectId: string }) {
  const machines = useStudio((s) => s.machines)
  const target = useStudio((s) => s.targetMachineId(projectId))
  const setProjectMachine = useStudio((s) => s.setProjectMachine)
  if (!machines?.length) return null
  const cur = machines.find((m) => m.id === target) ?? null
  const st = cur ? machineState(cur) : null
  const pick = (id: string) => {
    if (id === target) return
    void setProjectMachine(projectId, id)
      .then(() => toast("Printer changed", { description: "Slice again for this printer." }))
      .catch((e) => toast.error("Couldn't change the printer", { description: errMsg(e) }))
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 gap-1.5 font-normal"
            title="Which printer this project is sliced and sent to"
          />
        }
      >
        <span className={cn("size-2 shrink-0 rounded-full", st ? DOT[st.tone] : "bg-faint")} aria-hidden />
        <span className="max-w-28 min-w-0 truncate text-foreground xl:max-w-40">{cur?.name ?? "No printer"}</span>
        {st && <span className={cn("shrink-0 whitespace-nowrap", st.tone)}>{st.label}</span>}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {machines.map((m) => {
          const ms = machineState(m)
          return (
            <DropdownMenuItem key={m.id} disabled={!m.enabled && m.id !== target} onClick={() => pick(m.id)}>
              {m.id === target ? <CheckIcon /> : <span className="size-3.5" />}
              <span className={cn("size-2 shrink-0 rounded-full", DOT[ms.tone])} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className={cn("pl-3 text-caption", ms.tone)}>{ms.label}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
