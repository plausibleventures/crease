// First-run setup, like setting up a phone: full screen, one step per screen, progress dots, one big button, Skip on
// every step, Back. Welcome -> Designer -> Printer -> Preferences -> Done. Each step uses the app's own flows (the
// Designers sign-in modals, Add printer) and commits when its big button is pressed. Done says what is set and what
// was skipped; skipped steps stay reachable from "Finish setup" (Library, Settings) and "Run setup again".
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import type { AgentProfileView, SetupCheck, Units } from "@shared/types"
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  GlyphSpool,
  Loader2Icon,
  MonitorIcon,
  MoonIcon,
  PrinterIcon,
  SlidersHorizontalIcon,
  SunIcon,
  TriangleAlertIcon,
  XIcon,
} from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { AddDesignerDialog } from "@/components/agents/AddDesigner"
import { DesignerDialog } from "@/components/agents/DesignerDialog"
import { StatusDot, type Health } from "@/components/agents/parts"
import { useDesigners } from "@/components/agents/useDesigners"
import { SetupFixButton } from "@/components/onboarding/SetupFixButton"
import { SETUP_SCREENS, screenOf, useSetup, type SetupStep } from "@/components/onboarding/setup-state"
import { useTheme, type Theme } from "@/components/theme-provider"
import { api, errMsg } from "@/lib/api"
import { saveUnits, useUnits } from "@/lib/units"
import { cn } from "@/lib/utils"
import { BrandMark } from "@/components/BrandMark"
import { defaultMachine, useStudio } from "@/stores/studio"
import { TelemetryChoice } from "@/components/telemetry"

const LABELS = ["Welcome", "Designer", "Printer", "Preferences", "Done"] as const
const LAST = SETUP_SCREENS.length - 1

async function markOnboarded() {
  try {
    await api.putSettings({ onboardedAt: new Date().toISOString() })
  } catch {
    /* not fatal: setup shows again next launch */
  }
}

export function OnboardingWizard() {
  const { open, step, only } = useStudio((s) => s.onboarding)
  const setOnboarding = useStudio((s) => s.setOnboarding)
  const go = (n: number) => setOnboarding({ open: true, step: Math.max(0, Math.min(LAST, n)) })
  const close = () => {
    setOnboarding({ open: false, step: 0 })
    // the usage report (if they said yes) goes first: it counts only while onboardedAt is unset
    void api
      .telemetryOnboarding(step < LAST)
      .catch(() => {})
      .then(markOnboarded)
      .then(() => useSetup.getState().refresh())
  }
  // "Finish setup": only the steps still left, then Done (R2-SET-01)
  const next = () => go(only ? (only.find((n) => n > step) ?? LAST) : step + 1)
  const back = () => go(only ? ([...only].reverse().find((n) => n < step) ?? step) : step - 1)
  const canBack = step > 0 && step < LAST && (!only || only.some((n) => n < step))

  return (
    // Escape and the × close it (what's left stays in "Finish setup"); outside clicks don't. The step modals sit on
    // top of it and take Escape first.
    <Dialog open={open} onOpenChange={(o, d) => !o && d.reason === "escape-key" && close()}>
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-svh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0 shadow-none sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
      >
        <DialogTitle className="sr-only">Set up Crease</DialogTitle>
        <DialogDescription className="sr-only">
          Step {step + 1} of {LABELS.length}: {LABELS[step]}
        </DialogDescription>
        <header className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4 sm:px-6">
          <div>
            {canBack && (
              <Button variant="ghost" size="sm" onClick={back}>
                <ArrowLeftIcon /> Back
              </Button>
            )}
          </div>
          <Dots at={step} />
          <div className="flex justify-end">
            {step < LAST && (
              <Button variant="ghost" size="icon-sm" onClick={close} title="Close setup (Esc)" aria-label="Close setup">
                <XIcon />
              </Button>
            )}
          </div>
        </header>
        {open && (
          <div key={step} className="flex min-h-0 flex-1 flex-col animate-ps-enter motion-reduce:animate-none">
            {step === 0 && <WelcomeStep onNext={next} onSkipAll={close} />}
            {step === 1 && <DesignerStep onNext={next} />}
            {step === 2 && <PrinterStep onNext={next} />}
            {step === 3 && <PreferencesStep onNext={next} />}
            {step === LAST && <DoneStep go={go} onClose={close} />}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Dots({ at }: { at: number }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Setup progress">
      {LABELS.map((label, i) => (
        <li
          key={label}
          aria-current={i === at ? "step" : undefined}
          className={cn("h-1.5 rounded-full transition-[width,background-color] duration-200", i === at ? "w-6 bg-primary" : i < at ? "w-1.5 bg-primary/60" : "w-1.5 bg-line-strong")}
        >
          <span className="sr-only">
            {label}
            {i < at ? " (done)" : i === at ? " (current)" : ""}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** One screen: a centred column (icon, title, one line) with the step's content, then the big button and Skip. */
function Screen({ icon, title, sub, children, actions }: { icon: ReactNode; title: string; sub?: string; children?: ReactNode; actions: ReactNode }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 pt-[8vh] pb-6 text-center">
          <div aria-hidden className="mb-5 flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary [&_svg]:size-7">{icon}</div>
          <h2 className="ps-title text-3xl leading-tight text-balance">{title}</h2>
          {sub && <p className="mt-2 text-sm text-muted-foreground text-balance">{sub}</p>}
          {children && <div className="mt-7 w-full text-left text-sm">{children}</div>}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-md shrink-0 flex-col items-stretch gap-1 px-4 pt-2 pb-8">{actions}</div>
    </>
  )
}

function Primary({ children, busy, ...props }: ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button size="lg" className="h-11 w-full text-sm" {...props} disabled={props.disabled || busy}>
      {busy && <Loader2Icon className="animate-spin" />}
      {children}
    </Button>
  )
}

function SkipButton({ onClick, children = "Skip for now" }: { onClick: () => void; children?: ReactNode }) {
  return (
    <Button variant="ghost" className="h-10 w-full text-sm text-muted-foreground hover:text-foreground" onClick={onClick}>
      {children}
    </Button>
  )
}

/** A big selectable row (radio). */
function Option({ on, onPick, title, sub, aside, disabled }: { on: boolean; onPick: () => void; title: string; sub: string; aside?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      disabled={disabled}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-3 border px-4 py-3 text-left transition-colors outline-none hover:border-line-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
        on ? "border-primary bg-primary/10" : "border-line bg-card",
      )}
    >
      <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-primary" : "border-muted-foreground")}>
        {on && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
      {aside}
    </button>
  )
}

function Note({ tone, children }: { tone: "ok" | "warn" | "err"; children: ReactNode }) {
  return (
    <div role={tone === "err" ? "alert" : "status"} className={cn("mt-3 flex items-start gap-2 text-xs", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-err")}>
      {tone === "ok" ? <CheckCircle2Icon aria-hidden className="mt-px size-4 shrink-0" /> : <TriangleAlertIcon aria-hidden className="mt-px size-4 shrink-0" />}
      <span>{children}</span>
    </div>
  )
}

/* ---------- 1 welcome ---------- */

function WelcomeStep({ onNext, onSkipAll }: { onNext: () => void; onSkipAll: () => void }) {
  return (
    <Screen icon={<BrandMark className="size-9" />} title="Welcome to Crease" sub="Say what you want. Crease designs it and prints it. Setup takes 2 minutes." actions={
      <>
        <Primary onClick={onNext} autoFocus>
          Get started
        </Primary>
        <SkipButton onClick={onSkipAll}>Skip setup</SkipButton>
      </>
    } />
  )
}

/* ---------- 2 designer ---------- */

const DESIGNER_SUB: Record<string, string> = {
  claude: "Your Claude plan or an Anthropic key.",
  codex: "Your ChatGPT plan or an OpenAI key.",
  grok: "Your Grok account or an xAI key.",
  api: "Any API key. For tinkerers.",
}

/** A missing key or sign-in already reads "Not set up" (profileHealth, glossary). */
const plain = (h: Health): Health => h

function DesignerStep({ onNext }: { onNext: () => void }) {
  const d = useDesigners()
  const kinds = d.runtimes.filter((r) => r.available)
  const def = d.profiles.find((p) => p.isDefault)
  const [kind, setKind] = useState<string | null>(null)
  const chosen = kind ?? def?.runtime ?? kinds[0]?.kind ?? null
  // the designer for a service: the default one if it's that service, else the first
  const profileFor = (k: string): AgentProfileView | undefined => (def?.runtime === k ? def : d.profiles.find((p) => p.runtime === k))
  const profile = chosen ? profileFor(chosen) : undefined
  const health = profile ? d.healthOf(profile) : null
  const ready = health?.ready === true
  const label = d.runtimes.find((r) => r.kind === chosen)?.label ?? "designer"
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const setUp = () => {
    if (!chosen) return
    setTried(true)
    if (profile) setEditing(profile.id)
    else setAdding(chosen)
  }
  const chooseDesigner = async () => {
    if (!profile) return
    setBusy(true)
    try {
      if (!profile.isDefault) await api.setDefaultAgentProfile(profile.id)
      onNext()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen
      icon={<BotIcon />}
      title="Pick a designer"
      sub="The designer turns what you say into a part you can print."
      actions={
        // ONB-01: while its setup panel is open, that panel has the only button
        editing || adding ? null : (
        <>
          {ready ? (
            <Primary onClick={() => void chooseDesigner()} busy={busy} autoFocus>
              Use {label}
            </Primary>
          ) : (
            <Primary onClick={setUp} disabled={!chosen || !d.data}>
              Set up {label}
            </Primary>
          )}
          <SkipButton onClick={onNext}>Skip · use templates for now</SkipButton>
        </>
        )
      }
    >
      {!d.data && !d.error ? (
        <div className="flex justify-center py-6 text-muted-foreground">
          <Loader2Icon className="size-5 animate-spin" />
        </div>
      ) : d.error && !d.data ? (
        <Note tone="err">Couldn't load designers: {d.error}</Note>
      ) : (
        <div className="flex flex-col gap-2" role="radiogroup" aria-label="Designer">
          {kinds.map((r) => {
            const p = profileFor(r.kind)
            const h = p ? d.healthOf(p) : null
            return (
              <Option
                key={r.kind}
                on={chosen === r.kind}
                onPick={() => (setKind(r.kind), setTried(false), setErr(null))}
                title={r.label}
                sub={DESIGNER_SUB[r.kind] ?? r.blurb}
                aside={h && h.tone !== "muted" ? <StatusDot h={plain(h)} /> : null}
              />
            )
          })}
        </div>
      )}
      {ready && <Note tone="ok">{label} is ready.</Note>}
      {!ready && tried && !editing && !adding && health && health.ready === false && <Note tone="warn">{label}: {plain(health).label.toLowerCase()}. Set it up, or skip for now.</Note>}
      {err && <Note tone="err">{err}</Note>}

      {/* the Designers screen's own modals */}
      <DesignerDialog
        p={d.profiles.find((p) => p.id === editing) ?? null}
        ctx={d.ctxOf(d.profiles.find((p) => p.id === editing)?.runtime ?? "")}
        failures={[]}
        onChanged={d.replace}
        onReload={d.reload}
        onClose={() => {
          setEditing(null)
          d.reload()
          d.probe()
        }}
      />
      <AddDesignerDialog
        open={!!adding}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(null)
            d.probe()
          }
        }}
        runtimes={d.runtimes}
        probes={d.probes}
        profiles={d.profiles}
        codex={d.codex}
        onCodex={d.onCodex}
        onProbe={d.probe}
        onCreated={d.reload}
        initialKind={adding ?? undefined}
        defaultOn
      />
    </Screen>
  )
}

/* ---------- 3 printer ---------- */

function PrinterStep({ onNext }: { onNext: () => void }) {
  const machines = useStudio((s) => s.machines)
  const dialogOpen = useStudio((s) => !!s.machineDialog)
  const [mode, setMode] = useState<"real" | "practice" | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const real = (machines ?? []).filter((m) => !m.isPractice)
  const practice = (machines ?? []).find((m) => m.isPractice)

  useEffect(() => {
    void useStudio.getState().loadMachines()
  }, [])

  // "Add my printer" opens the app's Add printer modal; a printer added there finishes this step
  const before = useRef<string[] | null>(null)
  useEffect(() => {
    if (dialogOpen || !before.current) return
    const had = before.current
    before.current = null
    void (async () => {
      await useStudio.getState().loadMachines()
      const now = useStudio.getState().machines ?? []
      if (now.some((m) => !m.isPractice && !had.includes(m.id))) onNext()
    })()
  }, [dialogOpen, onNext])
  const addReal = () => {
    before.current = (machines ?? []).map((m) => m.id)
    useStudio.getState().setMachineDialog({ id: null })
  }

  const addPractice = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.setupPrinter({ practice: true })
      await useStudio.getState().loadMachines()
      void useStudio.getState().refreshPrinter()
      if (r.ok) onNext()
      else setError(r.error ?? "The practice printer didn't start.")
    } catch (e) {
      setError(`The practice printer didn't start: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const have = [...real, ...(practice ? [practice] : [])]
  return (
    <Screen
      icon={<PrinterIcon />}
      title="Add your printer"
      sub="No printer? Use the practice printer. You can add one later."
      actions={
        <>
          {mode === "real" ? (
            <Primary onClick={addReal} autoFocus>
              Add my printer
            </Primary>
          ) : mode === "practice" ? (
            <Primary onClick={() => void addPractice()} busy={busy} autoFocus>
              {error ? "Try again" : "Use the practice printer"}
            </Primary>
          ) : have.length ? (
            <Primary onClick={onNext}>Next</Primary>
          ) : (
            <Primary disabled>Choose one</Primary>
          )}
          <SkipButton onClick={onNext} />
        </>
      }
    >
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Printer">
        <Option on={mode === "real"} onPick={() => (setMode("real"), setError(null))} title="My printer" sub="Switched on, on the same Wi-Fi as this computer." />
        <Option
          on={mode === "practice"}
          onPick={() => (setMode("practice"), setError(null))}
          title="Practice printer"
          sub="Try printing safely. Nothing moves."
          aside={practice ? <span className="text-xs text-ok">Added</span> : null}
        />
      </div>
      {have.length > 0 && !error && (
        <p className="mt-3 text-xs text-muted-foreground">
          Added: {have.map((m) => `${m.name}${m.isDefault ? " ★" : ""}`).join(", ")}
        </p>
      )}
      {error && <Note tone="err">{error}</Note>}
    </Screen>
  )
}

/* ---------- 4 preferences ---------- */

const THEMES: { value: Theme; label: string; icon: ReactNode }[] = [
  { value: "light", label: "Light", icon: <SunIcon /> },
  { value: "dark", label: "Dark", icon: <MoonIcon /> },
  { value: "system", label: "Match system", icon: <MonitorIcon /> },
]

/** The app's Segmented control (same as Settings' Theme), sized for a setup screen. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col">
      <legend className="mb-2 text-xs text-muted-foreground">{label}</legend>
      <Segmented
        label={label}
        value={value}
        onChange={onChange}
        className="h-11 w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:gap-2 [&>button]:text-sm [&>button]:whitespace-nowrap [&_svg]:size-4"
        options={options.map((o) => ({ value: o.value, label: <>{o.icon}{o.label}</> }))}
      />
    </fieldset>
  )
}

function PreferencesStep({ onNext }: { onNext: () => void }) {
  const saved = useUnits()
  const [units, setUnits] = useState<Units>(saved.chosen ? saved.units : "mm")
  const { theme, setTheme } = useTheme()
  // off until they tick it (Settings > Usage reports changes it later)
  const [share, setShare] = useState(false)
  useEffect(() => {
    api
      .getSettings()
      .then((s) => setShare(s.telemetry === true))
      .catch(() => {})
  }, [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await saveUnits(units)
      await api.putSettings({ telemetry: share })
      onNext()
    } catch (e) {
      setError(`Couldn't save: ${errMsg(e)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Screen
      icon={<SlidersHorizontalIcon />}
      title="Your preferences"
      sub="Change these any time in Settings."
      actions={
        <>
          <Primary onClick={() => void save()} busy={busy} autoFocus>
            Next
          </Primary>
          <SkipButton onClick={onNext} />
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Choice
          label="Sizes in"
          value={units}
          onChange={setUnits}
          options={[
            { value: "mm", label: "Millimetres" },
            { value: "in", label: "Inches" },
          ]}
        />
        <Choice label="Theme" value={theme} onChange={setTheme} options={THEMES} />
        <TelemetryChoice checked={share} onChange={setShare} />
      </div>
      {error && <Note tone="err">{error}</Note>}
    </Screen>
  )
}

/* ---------- 5 done ---------- */

type Row = { step: SetupStep | "tools"; label: string; ok: boolean; value: string; fix?: ReactNode }

function DoneStep({ go, onClose }: { go: (n: number) => void; onClose: () => void }) {
  const d = useDesigners()
  const machines = useStudio((s) => s.machines)
  const units = useUnits()
  const { theme } = useTheme()
  const navigate = useStudio((s) => s.navigate)
  const [tools, setTools] = useState<{ openscad: SetupCheck; orcaslicer: SetupCheck } | null>(null)
  useEffect(() => {
    void useStudio.getState().loadMachines()
    let alive = true
    api
      .setupChecks()
      .then((c) => alive && setTools({ openscad: c.openscad, orcaslicer: c.orcaslicer }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const def = d.profiles.find((p) => p.isDefault)
  const health = def ? d.healthOf(def) : null
  const checking = !d.data || !d.probes || machines === null
  const designerOk = health?.ready === true
  const printer = defaultMachine(machines ?? [])
  const rows: Row[] = [
    { step: "designer", label: "Designer", ok: designerOk, value: designerOk ? def!.name : health && health.tone !== "muted" ? plain(health).label : "Not set up" },
    { step: "printer", label: "Printer", ok: !!printer, value: printer ? printer.name : "Not added" },
    {
      step: "preferences",
      label: "Preferences",
      ok: units.chosen,
      value: units.chosen ? `${units.units === "in" ? "Inches" : "Millimetres"} · ${theme[0].toUpperCase()}${theme.slice(1)} theme` : "Skipped",
    },
  ]
  for (const [key, label] of [
    ["openscad", "3D builder"],
    ["orcaslicer", "Slicer"],
  ] as const) {
    const c = tools?.[key]
    if (c && c.ok === false) rows.push({ step: "tools", label, ok: false, value: "Missing", fix: c.fix ? <SetupFixButton fix={c.fix} variant="outline" /> : null })
  }
  const left = rows.filter((r) => !r.ok)
  const allSet = !checking && left.length === 0

  const finish = (then: "new" | "templates") => {
    onClose()
    navigate({ name: "library" })
    setTimeout(() => {
      if (then === "new") document.dispatchEvent(new CustomEvent("printstudio:new-project"))
      else {
        document.dispatchEvent(new CustomEvent("printstudio:show-starters"))
        setTimeout(() => document.getElementById("starter-gallery")?.scrollIntoView({ behavior: "smooth" }), 50)
      }
    }, 50)
  }
  const make = (
    <Primary key="make" onClick={() => finish("new")} autoFocus={designerOk} variant={designerOk ? "default" : "outline"} disabled={checking}>
      Make something
    </Primary>
  )
  const browse = (
    <Primary key="browse" onClick={() => finish("templates")} autoFocus={!designerOk} variant={designerOk ? "outline" : "default"} disabled={checking}>
      Browse templates
    </Primary>
  )

  return (
    <Screen
      icon={allSet ? <CheckCircle2Icon /> : <GlyphSpool />}
      title={checking ? "Checking…" : allSet ? "You're all set" : "Ready to start"}
      sub={checking ? undefined : allSet ? "Make something new, or start from a template." : `${left.length} left. Finish ${left.length === 1 ? "it" : "them"} any time from Settings.`}
      actions={<div className="flex flex-col gap-2">{designerOk ? [make, browse] : [browse, make]}</div>}
    >
      <ul className="divide-y divide-line border-y border-line" aria-label="Setup summary">
        {rows.map((r) => (
          <li key={r.label} className="flex min-h-12 items-center gap-3 py-2">
            {checking && r.step !== "tools" ? (
              <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : r.ok ? (
              <CheckCircle2Icon className="size-4 shrink-0 text-ok" aria-label="Done" />
            ) : (
              <CircleIcon className="size-4 shrink-0 text-warn" aria-label="Not done" />
            )}
            <span className="w-24 shrink-0 text-muted-foreground">{r.label}</span>
            <span className={cn("min-w-0 flex-1 truncate", r.ok ? "text-foreground" : "text-muted-foreground")}>{checking && r.step !== "tools" ? "" : r.value}</span>
            {!checking && !r.ok && (r.fix ?? (r.step !== "tools" && <Button size="sm" variant="outline" onClick={() => go(screenOf(r.step as SetupStep))}>Set up</Button>))}
          </li>
        ))}
      </ul>
    </Screen>
  )
}
