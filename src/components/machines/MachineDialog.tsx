// Add / edit a printer ("machine"): model, name, how to reach it, loaded filaments, fit test, tags.
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { CheckCircle2Icon, Loader2Icon, SearchIcon, Trash2Icon, XCircleIcon } from "@/components/icons"
import type { FilamentSlot, Machine } from "@shared/types"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { api, errMsg, type MachineModel } from "@/lib/api"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"
import { FitTestPanel } from "@/components/machines/FitTestPanel"
import { FilamentSlotsEditor, normaliseSlots } from "./FilamentSlotsEditor"
import { MachineCalibration, MachineLessons } from "./MachineLearning"
import { PrintByHandSteps, SupportPanel, supportTag } from "./PrinterSupport"
import { supportFor } from "@shared/printer-support"
import type { CameraIce } from "@shared/types"
import { askUseForNewProjects, UseForNewProjectsDialog } from "./UseForNewProjects"

// Used when the server has no model catalogue yet.
const FALLBACK_MODELS: MachineModel[] = [
  { id: "sparkx-i7", model: "Creality SPARKX i7", buildVolumeMm: [260, 260, 255], nozzlesMm: [0.4], nozzleMm: 0.4, filamentSlots: 4, maxNozzleC: 300 },
]

type Conn = "network" | "none" | "practice"

export function MachineDialog() {
  const dialog = useStudio((s) => s.machineDialog)
  const setDialog = useStudio((s) => s.setMachineDialog)
  return (
    <>
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
          {dialog && <MachineForm key={dialog.id ?? "new"} id={dialog.id} onClose={() => setDialog(null)} />}
        </DialogContent>
      </Dialog>
      <UseForNewProjectsDialog />
    </>
  )
}

function MachineForm({ id, onClose }: { id: string | null; onClose: () => void }) {
  const existing = useStudio((s) => (id ? s.machines?.find((m) => m.id === id) : undefined))
  const load = useStudio((s) => s.loadMachines)
  const [tolRev, setTolRev] = useState(0)

  const [name, setName] = useState(existing?.name ?? "")
  const [model, setModel] = useState<MachineModel | null>(
    existing
      ? {
          id: existing.slicerProfile,
          model: existing.model,
          buildVolumeMm: existing.buildVolumeMm,
          nozzlesMm: [existing.nozzleMm],
          nozzleMm: existing.nozzleMm,
          filamentSlots: existing.filamentSlots,
          maxNozzleC: existing.maxNozzleC,
        }
      : null,
  )
  const initialConn: Conn = !existing
    ? "network"
    : existing.connection.type === "none"
      ? "none"
      : existing.isPractice
        ? "practice"
        : "network"
  const [conn, setConn] = useState<Conn>(initialConn)
  const [host, setHost] = useState(existing?.connection.type === "moonraker" && !existing.isPractice ? existing.connection.host : "")
  const [port, setPort] = useState(existing?.connection.type === "moonraker" ? existing.connection.port : 7125)
  const [sequentialOk, setSequentialOk] = useState(!!existing?.sequentialPrintOk)
  const [crealityStart, setCrealityStart] = useState(existing?.connection.type === "moonraker" ? !!existing.connection.crealityStart : false)
  const [cameraIce, setCameraIce] = useState<CameraIce["mode"]>(existing?.connection.type === "moonraker" ? (existing.connection.cameraIce?.mode ?? "auto") : "auto")
  const keepConn = existing?.connection.type === "moonraker" ? existing.connection : null
  const [slots, setSlots] = useState<FilamentSlot[]>(() => {
    if (existing) return normaliseSlots(existing.filaments, existing.filamentSlots)
    const s = normaliseSlots(undefined, FALLBACK_MODELS[0].filamentSlots)
    s[0] = { ...s[0], loaded: true, colorName: "White", colorHex: "#f5f5f5" }
    return s
  })
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "))
  const [notes, setNotes] = useState(existing?.notes ?? "")
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  // a new printer never becomes the default here: once the form closes we ask (UseForNewProjects)
  const [makeDefault, setMakeDefault] = useState(existing?.isDefault ?? false)
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // a printer added in this form: asked about as the default once the form closes
  const added = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (added.current) void askUseForNewProjects(added.current)
    },
    [],
  )

  // model search
  const [q, setQ] = useState("")
  const [models, setModels] = useState<MachineModel[]>(FALLBACK_MODELS)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      api
        .machineModels(q.trim())
        .then((m) => alive && Array.isArray(m) && m.length && setModels(m))
        .catch(() => alive && setModels(FALLBACK_MODELS.filter((m) => m.model.toLowerCase().includes(q.trim().toLowerCase()))))
    }, 200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])
  const pickModel = (m: MachineModel) => {
    setModel(m)
    setSlotsFor(m.filamentSlots)
    if (!name.trim()) setName(m.model)
  }
  // MACH-02: nothing is preselected; you pick your printer's model
  const chosen = model
  const support = supportFor({
    model: chosen?.model ?? existing?.model ?? "",
    vendor: chosen?.vendor,
    // a saved machine on the network talks Moonraker (Klipper) even when the catalogue entry isn't loaded
    klipper: chosen?.klipper ?? (conn !== "none" ? true : undefined),
    isPractice: conn === "practice",
    slicerProfile: chosen?.id,
  })
  const crealityOptions = conn === "network" && support.caps.creality.level !== "unsupported"
  const slotCount = slots.length
  /** Resize the slot list (model picked, or user changed it); a fresh list starts with slot 1 loaded. */
  function setSlotsFor(count: number) {
    setSlots((cur) => {
      const next = normaliseSlots(cur, count)
      if (!next.some((s) => s.loaded)) next[0] = { ...next[0], loaded: true, colorName: next[0].colorName || "White", colorHex: next[0].colorName ? next[0].colorHex : "#f5f5f5" }
      return next
    })
  }

  const payload = useMemo((): Partial<Machine> => {
    const m = chosen ?? FALLBACK_MODELS[0]
    return {
      name: name.trim() || m.model,
      model: m.model,
      slicerProfile: m.id,
      ...(m.buildVolumeMm ? { buildVolumeMm: m.buildVolumeMm } : {}),
      nozzleMm: m.nozzleMm,
      ...(m.maxNozzleC ? { maxNozzleC: m.maxNozzleC } : {}),
      filamentSlots: slotCount,
      filaments: slots,
      filamentsConfirmed: true,
      sequentialPrintOk: sequentialOk && slotCount > 1,
      connection:
        conn === "none"
          ? { type: "none" }
          : conn === "practice"
            ? // the built-in practice printer: served inside Crease (packaged builds too), no address
              { type: "moonraker", host: "practice", port: 0 }
            : {
                type: "moonraker",
                host: host.trim(),
                port: Number(port) || 7125,
                ...(keepConn?.crealityWsPort != null ? { crealityWsPort: keepConn.crealityWsPort } : {}),
                ...(crealityStart && crealityOptions ? { crealityStart: true } : {}),
                ...(cameraIce !== "auto" || keepConn?.cameraIce?.stunServers?.length
                  ? { cameraIce: { mode: cameraIce, ...(keepConn?.cameraIce?.stunServers?.length ? { stunServers: keepConn.cameraIce.stunServers } : {}) } }
                  : {}),
              },
      enabled,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      notes: notes.trim() || undefined,
    }
  }, [chosen, name, slots, slotCount, conn, host, port, enabled, tags, notes, crealityStart, crealityOptions, cameraIce, keepConn, sequentialOk])

  const save = async (): Promise<void> => {
    if (!chosen && !existing && conn !== "practice") {
      toast.error("Pick your printer's model")
      return
    }
    if (conn === "network" && !host.trim()) {
      toast.error("Type the printer's address")
      return
    }
    setBusy("save")
    try {
      const m = existing
        ? await api.updateMachine(existing.id, payload)
        : conn === "practice"
          ? await api.createMachine({ ...payload, isPractice: true, isDefault: makeDefault }) // the one built-in practice printer
          : await api.createMachine(payload)
      if (!existing) added.current = m.id
      if (makeDefault && !existing?.isDefault) await api.setDefaultMachine(m.id).catch(() => {})
      await load()
      toast.success(existing ? "Saved" : `Added ${m.name}`)
      onClose()
    } catch (e) {
      toast.error("Couldn't save the printer", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  /** Test the address in the form without saving anything (a saved printer at the same address uses its own key). */
  const runTest = async () => {
    if (!host.trim()) {
      toast.error("Type the printer's address")
      return
    }
    setTest(null)
    setBusy("test")
    try {
      const same = keepConn && !existing?.isPractice && keepConn.host === host.trim() && keepConn.port === (Number(port) || 7125)
      const r = same && existing ? await api.testMachine(existing.id) : await api.testAddress(host.trim(), Number(port) || 7125)
      setTest(
        r.ok
          ? { ok: true, text: `Connected${r.info?.hostname ? ` to ${r.info.hostname}` : ""}.` }
          : { ok: false, text: `No answer from ${host.trim()}:${port}. Is it on, on the same Wi-Fi? (${r.error ?? ""})` },
      )
    } catch (e) {
      setTest({ ok: false, text: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!existing) return
    setBusy("delete")
    try {
      await api.deleteMachine(existing.id)
      await load()
      toast.success(`Removed ${existing.name}`)
      onClose()
    } catch (e) {
      toast.error("Couldn't remove it", { description: errMsg(e) })
    } finally {
      setBusy(null)
    }
  }

  const printing = existing?.status?.state === "printing" || existing?.status?.state === "paused"

  return (
    <>
      <DialogHeader className="border-b px-5 py-3">
        <DialogTitle>{existing ? `Edit ${existing.name}` : "Add printer"}</DialogTitle>
        <DialogDescription className="sr-only">Printer settings</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2 text-sm">
        <label className="flex flex-col gap-1 py-2">
          <span className="text-xs text-muted-foreground">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.model ?? "Garage printer"} className="h-8 text-sm" />
        </label>
        <Accordion multiple defaultValue={existing ? ["connection"] : ["model", "connection"]}>
          <Section value="model" title="Model" summary={chosen?.model ?? existing?.model ?? "Pick one"}>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search models" className="h-8 pl-7 text-sm" aria-label="Search printer models" />
            </div>
            <div className="mt-1.5 flex max-h-40 flex-col overflow-y-auto border" role="listbox" aria-label="Printer models">
              {models.map((m) => {
                const sel = chosen?.model === m.model
                return (
                  <button
                    key={m.id + m.model}
                    role="option"
                    aria-selected={sel}
                    onClick={() => pickModel(m)}
                    title={`${m.buildVolumeMm ? `${m.buildVolumeMm.join("×")} mm` : "Bed size unknown"} · ${m.nozzlesMm.join(" / ")} mm nozzle${m.filamentSlots > 1 ? ` · ${m.filamentSlots} colours` : ""}`}
                    className={cn("flex items-center gap-2 rounded-none px-2 py-1.5 text-left text-xs hover:bg-muted/60", sel && "bg-primary/15")}
                  >
                    <span className="flex-1 font-medium">{m.model}</span>
                    <ModelTag m={m} />
                  </button>
                )
              })}
            </div>
            {(chosen || existing) && (
              <div className="mt-2">
                <SupportPanel support={support} connection={conn} />
              </div>
            )}
          </Section>

          <Section value="connection" title="Connection" summary={CONN_LABEL[conn]}>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Connection">
              {(
                [
                  ["network", "Network", "Same Wi-Fi. Prints start from here."],
                  ["none", "By hand", "You copy files to a USB stick."],
                  ["practice", "Practice", "Pretend printer. Nothing moves."],
                ] as const
              ).map(([c, title, sub]) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={conn === c}
                  onClick={() => {
                    setConn(c)
                    setTest(null)
                  }}
                  // a real printer can't become the practice one (that's a separate, built-in machine: add it instead)
                  disabled={c === "practice" && !!existing && !existing.isPractice}
                  title={c === "practice" && !!existing && !existing.isPractice ? "Add the practice printer as its own printer" : undefined}
                  className={cn("flex flex-col items-start gap-0.5 border p-2.5 text-left hover:border-primary/60 disabled:opacity-50", conn === c && "border-primary bg-primary/10")}
                >
                  <span className="flex items-center gap-2 text-xs font-medium">
                    <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-full border", conn === c ? "border-primary" : "border-muted-foreground")}>
                      {conn === c && <span className="size-1.5 rounded-full bg-primary" />}
                    </span>
                    {title}
                  </span>
                  <span className="text-caption text-muted-foreground">{sub}</span>
                </button>
              ))}
            </div>
            {conn === "network" && (
              <div className="mt-2 flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Address</span>
                <div className="flex gap-2">
                  <Input
                    value={host}
                    onChange={(e) => {
                      setHost(e.target.value)
                      setTest(null)
                    }}
                    placeholder="192.168.1.50"
                    aria-label="Address"
                    className="h-8 flex-1 font-mono text-sm"
                  />
                  <Button variant="outline" size="sm" className="h-8" onClick={() => void runTest()} disabled={busy !== null || !host.trim()}>
                    {busy === "test" && <Loader2Icon className="animate-spin" />}
                    Test connection
                  </Button>
                </div>
                <p className="text-caption text-muted-foreground">Find the address on the printer's screen, under Wi-Fi.</p>
              </div>
            )}
            {conn === "none" && (
              <div className="mt-2">
                <PrintByHandSteps printerName={name.trim() || chosen?.model} />
              </div>
            )}
            {test && conn === "network" && (
              <div role="status" className={cn("mt-2 flex items-start gap-2 border p-2 text-xs", test.ok ? "border-ok/40 bg-ok/10" : "border-err/40 bg-err/10")}>
                {test.ok ? <CheckCircle2Icon className="size-4 shrink-0 text-ok" /> : <XCircleIcon className="size-4 shrink-0 text-err" />}
                {test.text}
              </div>
            )}
          </Section>

          <Section value="loaded" title="Loaded filament" summary={`${slots.filter((s) => s.loaded).length} of ${slotCount}`}>
            <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              Colour slots
              <OptionSelect
                value={String(slotCount)}
                onChange={(v) => setSlotsFor(Number(v))}
                className="w-16"
                aria-label="Number of colour slots"
                options={[1, 2, 3, 4, 8, 16].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </label>
            <FilamentSlotsEditor slots={slots} onChange={setSlots} />
          </Section>

          {existing && (
            <Section value="learned" title="Learned from prints">
              <MachineCalibration machineId={existing.id} onApplied={() => setTolRev((n) => n + 1)} />
              <div className="mt-3">
                <MachineLessons machineId={existing.id} />
              </div>
            </Section>
          )}

          {existing && (
            <Section value="fit" title="Fit test">
              <FitTestPanel key={tolRev} machineId={existing.id} />
            </Section>
          )}

          <Section value="more" title="More">
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={enabled} onCheckedChange={(c) => setEnabled(!!c)} /> Available for prints
                </label>
                {existing && (
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox checked={makeDefault} onCheckedChange={(c) => setMakeDefault(!!c)} disabled={existing.isDefault} /> Use for new projects
                  </label>
                )}
              </div>
              {conn === "network" && (
                <label className="flex w-28 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Port</span>
                  <Input type="number" value={String(port)} onChange={(e) => setPort(Number(e.target.value) || 7125)} className="h-8 font-mono text-sm" />
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Tags</span>
                <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="garage, PETG" className="h-8 text-sm" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Notes</span>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} className="h-8 text-sm" />
              </label>
              {conn === "network" && slotCount > 1 && (
                <label
                  className="flex items-center gap-2 text-xs"
                  title="Prints two-colour plates part by part. The head moves over finished parts, so tick this only after one such print finished cleanly."
                >
                  <Checkbox checked={sequentialOk} onCheckedChange={(c) => setSequentialOk(!!c)} /> Safe to print parts one at a time
                </label>
              )}
              {conn === "network" && crealityOptions && (
                <label className="flex items-center gap-2 text-xs" title="The printer's touchscreen tracks the print. Not tried on a real printer yet.">
                  <Checkbox checked={crealityStart} onCheckedChange={(c) => setCrealityStart(!!c)} /> Start prints through Creality's service{" "}
                  <span className="text-warn">(experimental)</span>
                </label>
              )}
              {conn === "network" && (
                <label className="flex flex-wrap items-center gap-2 text-xs">
                  Camera connection
                  <OptionSelect<CameraIce["mode"]>
                    value={cameraIce}
                    onChange={setCameraIce}
                    aria-label="Camera connection"
                    options={[
                      { value: "auto", label: "Local first (recommended)" },
                      { value: "local", label: "Local only" },
                      { value: "custom", label: "Always through a STUN server" },
                    ]}
                  />
                </label>
              )}
            </div>
          </Section>
        </Accordion>
      </div>
      <DialogFooter className="border-t px-5 py-3 sm:justify-between">
        {existing ? (
          confirmDelete ? (
            <div className="flex items-center gap-2 text-xs">
              <span>Remove {existing.name}? Your designs stay.</span>
              <Button size="sm" variant="destructive" onClick={() => void remove()} disabled={busy !== null}>
                {busy === "delete" && <Loader2Icon className="animate-spin" />}
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="text-err"
              onClick={() => setConfirmDelete(true)}
              disabled={printing}
              title={printing ? "It's printing: stop the print first" : undefined}
            >
              <Trash2Icon /> Remove printer
            </Button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" && <Loader2Icon className="animate-spin" />}
            Save printer
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

const CONN_LABEL: Record<Conn, string> = { network: "Network", none: "By hand", practice: "Practice" }

/** One collapsible part of the form; the summary shows what's chosen while it's closed. */
function Section({ value, title, summary, children }: { value: string; title: string; summary?: string; children: React.ReactNode }) {
  return (
    <AccordionItem value={value}>
      <AccordionTrigger summary={summary}>{title}</AccordionTrigger>
      <AccordionContent className="pb-4">{children}</AccordionContent>
    </AccordionItem>
  )
}

function ModelTag({ m }: { m: MachineModel }) {
  const t = supportTag(supportFor({ model: m.model, vendor: m.vendor, klipper: m.klipper, slicerProfile: m.id }))
  const tone = { verified: "text-ok", simulated: "text-primary", untested: "text-warn", unsupported: "text-muted-foreground" }[t.level]
  return <span className={cn("shrink-0 text-caption", tone)}>{t.text}</span>
}
