// The honest compatibility matrix in the UI (data: shared/printer-support.ts; doc: docs/printer-support.md).
import { useState } from "react"
import { DownloadIcon, Loader2Icon } from "@/components/icons"
import { toast } from "sonner"
import type { SupportLevel } from "@shared/types"
import { CAPABILITIES, LEVEL_LABEL, LEVEL_MARK, canSend, supportHeadline, type PrinterSupport } from "@shared/printer-support"
import { DetailsToggle } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"

const LEVEL_TONE: Record<SupportLevel, string> = {
  verified: "text-ok border-ok/40",
  simulated: "text-primary border-primary/40",
  untested: "text-warn border-warn/40",
  unsupported: "text-muted-foreground border-border",
}
const HEAD_TONE = { ok: "text-ok", warn: "text-warn", muted: "text-muted-foreground" } as const

/** A short tag for the model list: how far this family is proven. */
export function supportTag(s: PrinterSupport): { text: string; level: SupportLevel } {
  if (!canSend(s)) return { text: "Slicing only", level: "unsupported" }
  if (s.caps.send.level === "verified") return { text: "Works", level: "verified" }
  return { text: "Untested", level: "untested" }
}

/**
 * MACH-02: one plain verdict for the Add printer form. "Works with Crease" only when everything it will use was
 * tested on a real printer (or it's the practice printer); "Untested" otherwise; "Slicing only" when it can't be sent to.
 */
export function supportVerdict(s: PrinterSupport, connection: "network" | "none" | "practice"): { text: string; tone: "ok" | "warn" | "muted" } {
  if (connection === "practice") return { text: "Works with Crease", tone: "ok" }
  if (connection !== "none" && !canSend(s)) return { text: "Slicing only · print it by hand", tone: "muted" }
  // Creality job tracking is optional (off unless you turn it on), so it doesn't decide the verdict
  const h = supportHeadline(s, connection)
  return h.chips.filter((c) => c.key !== "creality").every((c) => c.level === "verified") ? { text: "Works with Crease", tone: "ok" } : { text: "Untested", tone: "warn" }
}

/** One line for machine cards / lists, e.g. "Works: slicing ✓ · sending ✓ · colours ✓ · camera ✓ (verified on SPARKX i7)". */
export function SupportLine({ support, connection, className }: { support: PrinterSupport; connection: "network" | "none" | "practice"; className?: string }) {
  const h = supportHeadline(support, connection)
  return (
    <div
      className={cn("line-clamp-2 text-micro", HEAD_TONE[h.tone], className)}
      title={h.chips.map((c) => `${c.label}: ${LEVEL_LABEL[c.level]} — ${c.note}`).join("\n")}
    >
      {h.text}
    </div>
  )
}

/** Add-a-printer: one verdict line; the full matrix for this printer family behind Details. */
export function SupportPanel({ support, connection }: { support: PrinterSupport; connection: "network" | "none" | "practice" }) {
  const v = supportVerdict(support, connection)
  const [details, setDetails] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div aria-label="What works with this printer">
      <div className="flex items-center gap-2">
        <span className={cn("text-xs font-medium", HEAD_TONE[v.tone])}>{v.text}</span>
        <DetailsToggle open={details} onToggle={() => setDetails((d) => !d)} controls="support-details" />
      </div>
      {details && (
      <div id="support-details" className="mt-1.5 border border-line bg-surface-1/40 p-2.5">
      <span className="text-micro text-muted-foreground">{support.family}</span>
      <div className="mt-2 grid grid-cols-2 gap-1 sm:grid-cols-3" role="list">
        {CAPABILITIES.map((c) => {
          const cap = support.caps[c.key]
          return (
            <button
              key={c.key}
              role="listitem"
              type="button"
              onClick={() => setOpen(open === c.key ? null : c.key)}
              aria-expanded={open === c.key}
              className={cn("flex flex-col items-start gap-0.5 border px-2 py-1 text-left hover:bg-muted/40", LEVEL_TONE[cap.level], open === c.key && "bg-muted/40")}
            >
              <span className="text-caption text-foreground">{c.label}</span>
              <span className="font-mono text-micro">
                {LEVEL_MARK[cap.level]} {LEVEL_LABEL[cap.level]}
              </span>
            </button>
          )
        })}
      </div>
      {open && <p className="mt-2 text-caption text-muted-foreground">{support.caps[open as keyof typeof support.caps].note}</p>}
      <p className="mt-2 text-micro text-muted-foreground">
        ✓ tested · ~ practice only · ? untested
      </p>
      </div>
      )}
    </div>
  )
}

/** How to print a saved file by hand (export-only path). */
export function PrintByHandSteps({ printerName }: { printerName?: string }) {
  return (
    <ol className="list-decimal space-y-0.5 pl-4 text-caption text-muted-foreground">
      <li>Slice it, then press Save print file{printerName ? ` (made for ${printerName})` : ""}.</li>
      <li>Copy the file to the printer's USB stick or SD card.</li>
      <li>Pick the file on the printer's screen. Clear the bed first.</li>
      <li>Crease can't follow these prints.</li>
    </ol>
  )
}

/** "Save print file" for a slice (G-code), with the 3MF model as a second option for single parts. */
export function SavePrintFileButton({ projectId, gcodePath, allow3mf, size = "sm" }: { projectId: string; gcodePath: string; allow3mf?: boolean; size?: "sm" | "xs" }) {
  const [busy, setBusy] = useState<"gcode" | "3mf" | null>(null)
  const save = async (format: "gcode" | "3mf") => {
    setBusy(format)
    try {
      const name = await api.savePrintFile(projectId, gcodePath, format)
      toast.success(`Saved ${name}`, {
        description: format === "gcode" ? "Copy it to the printer's USB stick, then start it there." : "Open it in your printer maker's slicer.",
      })
    } catch (e) {
      toast.error("Couldn't save the print file", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button size={size} onClick={() => void save("gcode")} disabled={busy !== null}>
        {busy === "gcode" ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} Save print file
      </Button>
      {allow3mf && (
        <Button size={size} variant="outline" onClick={() => void save("3mf")} disabled={busy !== null} title="The model with its colours, for the printer maker's own slicer">
          {busy === "3mf" ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} 3MF model
        </Button>
      )}
    </div>
  )
}
