import { useEffect, useState } from "react"
import type {
  Settings,
  SourcingSettings,
  SourcingStoreInfo,
  StoreId,
} from "@shared/types"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  Loader2Icon,
  XCircleIcon,
} from "@/components/icons"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { FinishSetupButton } from "@/components/onboarding/FinishSetupButton"
import { SetupFixButton } from "@/components/onboarding/SetupFixButton"
import { useSetup } from "@/components/onboarding/setup-state"
import { loadUnits } from "@/lib/units"
import { api, errMsg } from "@/lib/api"
import { chooseApp, desktop } from "@/lib/desktop"
import { defaultMachine, useStudio } from "@/stores/studio"
import { AboutSection } from "@/components/dialogs/AboutSection"
import { TOOLS, type ToolChecks } from "@/lib/diagnostics"
import { profileHealth } from "@/components/agents/parts"
import { useTheme } from "@/components/theme-provider"
import { Segmented } from "@/components/ui/segmented"
import { TelemetryChoice } from "@/components/telemetry"

type TestState = { busy: boolean; ok?: boolean; msg?: string }

/** Desktop app only: native picker for a .app (the server resolves the binary inside it). */
function ChooseAppButton({ title, onPick }: { title: string; onPick: (path: string) => void }) {
  if (!desktop()?.chooseApp) return null
  return (
    <Button
      variant="outline"
      onClick={async () => {
        const p = await chooseApp(title)
        if (p) onPick(p)
      }}
    >
      Choose…
    </Button>
  )
}

const EMPTY: Settings = {
  openscadPath: "",
  orcaSlicerPath: "",
  printer: { host: "", port: 7125 },
  model: null,
}

export function SettingsDialog() {
  const open = useStudio((s) => s.settingsOpen)
  const setOpen = useStudio((s) => s.setSettingsOpen)
  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogContent className="sm:max-w-lg">
        {open && <SettingsBody setOpen={setOpen} />}
      </DialogContent>
    </Dialog>
  )
}

/** Mounted only while the dialog is open, so every open starts from fresh server state. */
function SettingsBody({ setOpen }: { setOpen: (o: boolean) => void }) {
  const refreshPrinter = useStudio((s) => s.refreshPrinter)
  // fit tests belong to a real printer (its Fit test section)
  const fitMachine = useStudio((s) => defaultMachine((s.machines ?? []).filter((m) => !m.isPractice)))
  const [s, setS] = useState<Settings>(EMPTY)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [scadTest, setScadTest] = useState<TestState>({ busy: false })
  const [checks, setChecks] = useState<ToolChecks | null>(null)
  const found = { openscad: checks?.openscad.path, orcaslicer: checks?.orcaslicer.path, claude: checks?.claude.path, blender: checks?.blender?.path }
  // the app menu's "About Crease" opens Settings at About
  const section = useStudio((st) => st.settingsSection)
  // EXP-02: each closed section says what's in it
  const designer = useDesignerSummary()
  const setupLeft = useSetup((st) => st.left)
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    api
      .about()
      .then((a) => setVersion(a.version))
      .catch(() => {})
  }, [])
  const missing = checks ? TOOLS.filter((t) => !t.optional && !checks[t.key]?.path && !checks[t.key]?.version).map((t) => t.name) : null
  const toolsSummary = !checks ? "Checking…" : missing!.length ? `${missing!.join(", ")} not found` : "All found"
  const shoppingSummary = s.sourcing ? `${COUNTRY_NAMES[s.sourcing.country] ?? s.sourcing.country} · ${s.sourcing.stores.length} ${s.sourcing.stores.length === 1 ? "store" : "stores"}` : "Default stores"
  const setupSummary = setupLeft == null ? "" : setupLeft.length ? `${setupLeft.length} left` : "Done"

  useEffect(() => {
    api
      .setupChecks()
      .then(setChecks)
      .catch(() => {})
  }, [])

  useEffect(() => {
    api
      .getSettings()
      .then((r) =>
        setS({
          ...EMPTY,
          ...r,
          printer: { ...EMPTY.printer, ...(r?.printer ?? {}) },
        })
      )
      .catch((e) => setLoadErr(errMsg(e)))
      .finally(() => setLoading(false))
  }, [])

  const save = async (close = true) => {
    setSaving(true)
    try {
      const body: Partial<Settings> = { ...s }
      delete body.auth // read-only; the API key has its own routes
      const r = await api.putSettings(body)
      loadUnits(r.units)
      void useSetup.getState().refresh()
      setS({
        ...EMPTY,
        ...r,
        printer: { ...EMPTY.printer, ...(r?.printer ?? {}) },
      })
      void refreshPrinter()
      if (close) {
        toast.success("Settings saved")
        setOpen(false)
      }
      return true
    } catch (e) {
      toast.error("Couldn't save settings", { description: errMsg(e) })
      return false
    } finally {
      setSaving(false)
    }
  }

  const testScad = async () => {
    setScadTest({ busy: true })
    if (!(await save(false))) return setScadTest({ busy: false })
    try {
      const r = await api.testOpenscad()
      setScadTest({ busy: false, ok: r.ok, msg: r.ok ? r.version : r.error })
    } catch (e) {
      setScadTest({ busy: false, ok: false, msg: errMsg(e) })
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>Settings</DialogTitle>
        <DialogDescription className="sr-only">App settings</DialogDescription>
      </DialogHeader>
      {loadErr && (
        <div className="border border-err/40 bg-err/10 p-2 text-caption text-err">
          Couldn't load settings: {loadErr}
        </div>
      )}
      <fieldset
        disabled={loading}
        className="-mr-2 flex max-h-[65vh] flex-col gap-3 overflow-y-auto pr-2"
      >
        <Field label="Theme">
          <ThemeField />
        </Field>
        <Field label="Sizes in">
          <Segmented
            label="Sizes in"
            value={s.units ?? "mm"}
            onChange={(units) => setS({ ...s, units })}
            options={[
              { value: "mm", label: "Millimetres" },
              { value: "in", label: "Inches" },
            ]}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              useStudio.getState().navigate({ name: "machines" })
            }}
          >
            Printers <ArrowRightIcon />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false)
              useStudio.getState().navigate({ name: "agents" })
            }}
          >
            Designers <ArrowRightIcon />
          </Button>
          <span className="text-caption text-muted-foreground">Loaded filament and fit tests are set on each printer.</span>
        </div>
        <Accordion multiple className="border-y" defaultValue={section ? [section] : []}>
          <AccordionItem value="tools">
            <AccordionTrigger summary={toolsSummary}>Tools</AccordionTrigger>
            <AccordionContent className="flex flex-col gap-3">
              <span className="text-caption text-muted-foreground">Leave a path empty to find it automatically.</span>
              <Field label="OpenSCAD">
                <div className="flex gap-1.5">
                  <Input
                    value={s.openscadPath}
                    onChange={(e) => setS({ ...s, openscadPath: e.target.value })}
                    className="font-mono"
                    placeholder={found.openscad ? `Automatic: ${found.openscad}` : "Automatic (not found yet)"}
                  />
                  <ChooseAppButton title="Choose OpenSCAD" onPick={(p) => setS((cur) => ({ ...cur, openscadPath: p }))} />
                  <Button variant="outline" onClick={() => void testScad()} disabled={scadTest.busy}>
                    {scadTest.busy && <Loader2Icon className="animate-spin" />}Test
                  </Button>
                </div>
                <TestResult t={scadTest} />
              </Field>
              <Field label="OrcaSlicer">
                <div className="flex gap-1.5">
                  <Input
                    value={s.orcaSlicerPath}
                    onChange={(e) => setS({ ...s, orcaSlicerPath: e.target.value })}
                    className="font-mono"
                    placeholder={found.orcaslicer ? `Automatic: ${found.orcaslicer}` : "Automatic (not found yet)"}
                  />
                  <ChooseAppButton title="Choose OrcaSlicer" onPick={(p) => setS((cur) => ({ ...cur, orcaSlicerPath: p }))} />
                </div>
              </Field>
              <Field label="Blender (optional)">
                <div className="flex gap-1.5">
                  <Input
                    value={s.blenderPath ?? ""}
                    onChange={(e) => setS({ ...s, blenderPath: e.target.value })}
                    className="font-mono"
                    placeholder={found.blender ? `Automatic: ${found.blender}` : checks ? "Not found" : "Automatic"}
                  />
                  <ChooseAppButton title="Choose Blender" onPick={(p) => setS((cur) => ({ ...cur, blenderPath: p }))} />
                </div>
                {checks?.blender && !checks.blender.path && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-caption text-muted-foreground">For sculpted figures and flowing shapes. {checks.blender.hint}</span>
                    {checks.blender.fix && <SetupFixButton fix={checks.blender.fix} />}
                  </div>
                )}
              </Field>
              <Field label="Claude Code">
                <Input
                  value={s.claudePath ?? ""}
                  onChange={(e) => setS({ ...s, claudePath: e.target.value })}
                  className="font-mono"
                  placeholder={found.claude ? `Automatic: ${found.claude}` : "Automatic (not found yet)"}
                />
              </Field>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="designer">
            <AccordionTrigger summary={designer?.short ?? "…"}>Designer</AccordionTrigger>
            <AccordionContent>
              <span className="text-xs text-muted-foreground">{designer?.long ?? "Loading…"}</span>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="shopping">
            <AccordionTrigger summary={shoppingSummary}>Shopping</AccordionTrigger>
            <AccordionContent>
              <SourcingField value={s.sourcing} onChange={(sourcing) => setS({ ...s, sourcing })} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="setup">
            <AccordionTrigger summary={setupSummary}>Setup</AccordionTrigger>
            <AccordionContent className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setOpen(false)
                  useStudio.getState().setOnboarding({ open: true, step: 0 })
                }}
              >
                Run setup again
              </Button>
              {fitMachine && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOpen(false)
                    useStudio.getState().setMachineDialog({ id: fitMachine.id })
                  }}
                >
                  Fit test results
                </Button>
              )}
              <span onClickCapture={() => setOpen(false)}>
                <FinishSetupButton />
              </span>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="usage">
            <AccordionTrigger summary={s.telemetry ? "On" : "Off"}>Usage reports</AccordionTrigger>
            <AccordionContent>
              <TelemetryChoice checked={s.telemetry === true} onChange={(telemetry) => setS({ ...s, telemetry })} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="about">
            <AccordionTrigger summary={version ? `Crease ${version}` : ""}>About</AccordionTrigger>
            <AccordionContent>
              <AboutSection checks={checks} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </fieldset>
      <DialogFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving || loading}>
          {saving && <Loader2Icon className="animate-spin" />}Save
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * The default designer in a few words (it's set up on Designers; the link is at the top of Settings). A designer
 * without a working key or sign-in is "Not set up" (glossary), whatever it would be paid with (DES-01).
 */
function useDesignerSummary(): { short: string; long: string } | null {
  const [summary, setSummary] = useState<{ short: string; long: string } | null>(null)
  useEffect(() => {
    Promise.all([api.agentProfiles(), api.agentRuntimes().catch(() => [])])
      .then(([r, probes]) => {
        const p = r.profiles.find((x) => x.isDefault)
        if (!p) return setSummary({ short: "Not set up", long: "No designer yet. Add one on Designers." })
        const h = profileHealth(
          p,
          r.runtimes.find((x) => x.kind === p.runtime),
          probes.find((x) => x.runtime === p.runtime),
        )
        if (h.ready !== true) return setSummary({ short: `${p.name} · ${h.label}`, long: `${p.name}: ${h.label.toLowerCase()}. Set it up on Designers.` })
        const paid = p.auth.kind === "api-key" ? "your API key" : "your plan"
        setSummary({ short: p.name, long: `${p.name}, paid with ${paid}${p.budget.maxUsdPerRun ? ` · at most $${p.budget.maxUsdPerRun.toFixed(2)} a request` : ""}` })
      })
      .catch(() => setSummary(null))
  }, [])
  return summary
}

/** Light / Dark / Match system: the theme provider owns the value (also set from onboarding and the palette). */
function ThemeField() {
  const { theme, setTheme } = useTheme()
  return (
    <Segmented
      label="Theme"
      value={theme}
      onChange={setTheme}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "Match system" },
      ]}
    />
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-caption text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function TestResult({ t }: { t: TestState }) {
  if (t.busy || t.ok === undefined) return null
  return (
    <div
      className={`flex items-start gap-1 text-caption ${t.ok ? "text-ok" : "text-err"}`}
    >
      {t.ok ? (
        <CheckCircle2Icon className="mt-px size-3 shrink-0" />
      ) : (
        <XCircleIcon className="mt-px size-3 shrink-0" />
      )}
      <span className="font-mono break-all">
        {t.msg || (t.ok ? "OK" : "Failed")}
      </span>
    </div>
  )
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  DE: "Germany",
  AT: "Austria",
  IN: "India",
}

/** "Buying hardware": country + ordered, checkable store list (first checked = primary). */
function SourcingField({
  value,
  onChange,
}: {
  value: SourcingSettings | undefined
  onChange: (v: SourcingSettings) => void
}) {
  const [reg, setReg] = useState<{
    stores: SourcingStoreInfo[]
    countries: string[]
    defaults: SourcingSettings
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api
      .sourcingStores()
      .then(setReg)
      .catch((e) => setErr(errMsg(e)))
  }, [])

  if (err)
    return (
      <Field label="Buying hardware">
        <div className="text-caption text-err">
          Couldn't load stores: {err}
        </div>
      </Field>
    )
  if (!reg) return null

  const cur: SourcingSettings = value ?? reg.defaults
  const available = (country: string) =>
    reg.stores.filter(
      (st) => st.countries.includes("*") || st.countries.includes(country)
    )
  const avail = available(cur.country)
  const enabled = cur.stores.filter((id) => avail.some((st) => st.id === id))
  const rows = [
    ...enabled.map((id) => avail.find((st) => st.id === id)!),
    ...avail.filter((st) => !enabled.includes(st.id)),
  ]
  const countries = [...new Set([...reg.countries, cur.country])]

  const setCountry = (country: string) => {
    const av = available(country)
    let stores = cur.stores.filter((id) => av.some((st) => st.id === id))
    // keep local stores first when switching country (e.g. the country's Amazon)
    const local = av
      .filter((st) => !st.countries.includes("*"))
      .map((st) => st.id)
    stores = [...local.filter((id) => !stores.includes(id)), ...stores]
    if (!stores.length) stores = av.map((st) => st.id)
    onChange({ country, stores })
  }
  const toggle = (id: StoreId, on: boolean) =>
    onChange({
      ...cur,
      stores: on ? [...enabled, id] : enabled.filter((x) => x !== id),
    })
  const move = (id: StoreId, d: -1 | 1) => {
    const i = enabled.indexOf(id)
    const j = i + d
    if (i < 0 || j < 0 || j >= enabled.length) return
    const next = [...enabled]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange({ ...cur, stores: next })
  }

  return (
    <Field label="Stores for shopping list links. The first is the main one.">

      <OptionSelect
        aria-label="Country"
        size="default"
        className="w-full"
        value={cur.country}
        onChange={setCountry}
        options={countries.map((c) => ({ value: c, label: COUNTRY_NAMES[c] ? `${COUNTRY_NAMES[c]} (${c})` : c }))}
      />
      <div className="flex flex-col divide-y border">
        {rows.map((st) => {
          const on = enabled.includes(st.id)
          const i = enabled.indexOf(st.id)
          return (
            <div
              key={st.id}
              className={cn(
                "flex h-8 items-center gap-2 px-2",
                !on && "text-muted-foreground"
              )}
            >
              <Checkbox
                checked={on}
                onCheckedChange={(c) => toggle(st.id, !!c)}
              />
              <span className="font-medium">{st.label}</span>
              {on && i === 0 && (
                <span className="border border-primary/40 px-1 text-micro text-primary">
                  primary
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                {[
                  st.note,
                  st.countries.includes("*") ? "worldwide" : null,
                  st.suits === "all" ? null : "fasteners",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={!on || i === 0}
                onClick={() => move(st.id, -1)}
                title="Move up"
              >
                <ArrowUpIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={!on || i === enabled.length - 1}
                onClick={() => move(st.id, 1)}
                title="Move down"
              >
                <ArrowDownIcon />
              </Button>
            </div>
          )
        })}
      </div>
    </Field>
  )
}
