import type { FilamentSlot } from "@shared/types"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"

export const MATERIALS = ["PLA", "PETG", "TPU", "ABS", "ASA", "PLA-CF"]

/** Pad/trim to `count` slots so the editor always shows every slot the printer has. */
export function normaliseSlots(slots: FilamentSlot[] | undefined, count: number): FilamentSlot[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const n = i + 1
    return slots?.find((x) => x.slot === n) ?? { slot: n, colorName: "", colorHex: "#cccccc", material: "PLA", loaded: false }
  })
}

/** Loaded filaments, one row per slot: colour swatch + name, material, loaded. */
export function FilamentSlotsEditor({ slots, onChange }: { slots: FilamentSlot[]; onChange: (s: FilamentSlot[]) => void }) {
  const upd = (i: number, patch: Partial<FilamentSlot>) => onChange(slots.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  return (
    <div className="flex flex-col gap-2">
      {slots.map((s, i) => (
        <div key={s.slot} className={cn("flex items-center gap-2 border p-2", !s.loaded && "opacity-60")}>
          <span className="w-12 shrink-0 text-xs text-muted-foreground">{slots.length > 1 ? `Slot ${s.slot}` : "Spool"}</span>
          <input
            type="color"
            aria-label={`Slot ${s.slot} colour`}
            value={/^#[0-9a-f]{6}$/i.test(s.colorHex) ? s.colorHex : "#cccccc"}
            onChange={(e) => upd(i, { colorHex: e.target.value })}
            className="size-8 shrink-0 cursor-pointer border bg-transparent p-0.5"
          />
          <Input
            aria-label={`Slot ${s.slot} colour name`}
            value={s.colorName}
            onChange={(e) => upd(i, { colorName: e.target.value })}
            placeholder="Colour name, e.g. White"
            className="h-8 min-w-0 flex-1 text-sm"
          />
          <OptionSelect
            aria-label={`Slot ${s.slot} material`}
            value={s.material}
            onChange={(v) => upd(i, { material: v })}
            size="default"
            className="w-24"
            options={[...MATERIALS, ...(MATERIALS.includes(s.material) ? [] : [s.material])].map((m) => ({ value: m, label: m }))}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <Checkbox checked={s.loaded} onCheckedChange={(c) => upd(i, { loaded: !!c })} /> Loaded
          </label>
        </div>
      ))}
    </div>
  )
}

/** Small row of loaded-colour swatches. */
export function FilamentSwatches({ slots, className }: { slots: FilamentSlot[]; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {slots.map((f) => (
        <span
          key={f.slot}
          title={`${slots.length > 1 ? `Slot ${f.slot}: ` : ""}${f.loaded ? `${f.colorName || "unnamed"} ${f.material}` : "empty"}`}
          className={cn("size-2.5 border border-foreground/25", !f.loaded && "opacity-25")}
          style={{ background: f.loaded ? f.colorHex : "transparent" }}
        />
      ))}
    </span>
  )
}
