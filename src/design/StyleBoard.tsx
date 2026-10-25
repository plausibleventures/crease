// The living style board (/#/style): the "Workshop" system as the app really renders it. Everything here reads the
// tokens in src/index.css (glass: src/glass.css) and uses the real primitives, so the board can't drift from the app.
// Contrast numbers are computed live from the current theme's tokens (WCAG 2 relative luminance).
import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { CheckIcon, CuboidIcon, ImagesIcon, LayoutGridIcon, ListOrderedIcon, PrinterIcon, ScissorsIcon, TriangleAlertIcon } from "@/components/icons"
import { useResolvedTheme, useTheme } from "@/components/theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Segmented } from "@/components/ui/segmented"
import { Slider } from "@/components/ui/slider"
import { GlassTabs } from "@/components/GlassTabs"
import { BrandMark } from "@/components/BrandMark"
import { PLA_PALETTE } from "@shared/filament-tones"
import { cn } from "@/lib/utils"

const SURFACES = [
  { v: "--background", name: "Background", role: "app floor, page content" },
  { v: "--surface-1", name: "Surface 1", role: "side strips, status bar" },
  { v: "--surface-2", name: "Surface 2", role: "cards, inputs, table bodies" },
  { v: "--surface-3", name: "Surface 3", role: "hover, chips" },
  { v: "--stage", name: "Stage", role: "3D views and part pictures" },
]
const TEXTS = [
  { v: "--foreground", name: "Text" },
  { v: "--muted-foreground", name: "Secondary" },
  { v: "--faint", name: "Faint" },
  { v: "--ok", name: "Ok" },
  { v: "--warn", name: "Warn" },
  { v: "--err", name: "Error" },
  { v: "--pin", name: "Pin" },
  { v: "--move", name: "Move" },
]
const MEANING: [string, string, string][] = [
  ["--ok", "Ok", "pass, printed, ready"],
  ["--warn", "Warn", "warning, heating"],
  ["--err", "Error", "fail, stop"],
  ["--pin", "Pin", "your pins and notes"],
  ["--move", "Move", "moving parts"],
]
const TONE_NAMES = ["Blue", "Orange", "Teal", "Red", "Yellow", "Green"]

function hex(v: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function lum([r, g, b]: [number, number, number]) {
  const c = [r, g, b].map((x) => {
    const s = x / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function ratio(a: string, b: string): number | null {
  const x = hex(a)
  const y = hex(b)
  if (!x || !y) return null
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p)
  return (hi + 0.05) / (lo + 0.05)
}

/** The current theme's token values (re-read when the theme class on <html> changes). */
function useTokens(): Record<string, string> {
  const theme = useResolvedTheme()
  return useMemo(() => {
    void theme
    const cs = getComputedStyle(document.documentElement)
    const out: Record<string, string> = {}
    for (const s of [...SURFACES, ...TEXTS, { v: "--primary" }, { v: "--primary-foreground" }]) out[s.v] = cs.getPropertyValue(s.v).trim()
    return out
  }, [theme])
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function Ratio({ r, large }: { r: number | null; large?: boolean }) {
  if (r == null) return <span className="text-faint">–</span>
  const pass = r >= (large ? 3 : 4.5)
  return <span className={cn("tabular-nums", pass ? "text-foreground" : "text-err")}>{r.toFixed(1)}</span>
}

type View = "overview" | "model" | "assembly" | "renders"

export default function StyleBoard() {
  const { theme, setTheme } = useTheme()
  const tok = useTokens()
  const [seg, setSeg] = useState<"part" | "assembled" | "plate">("assembled")
  const [sel, setSel] = useState(1)
  const [slide, setSlide] = useState(40)
  const [view, setView] = useState<View>("model")
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-10 p-6">
        <header className="flex flex-wrap items-end gap-4">
          <div className="mr-auto">
            <p className="flex items-center gap-2 text-caption text-muted-foreground">
              <BrandMark className="size-4" /> Crease style board
            </p>
            <h1 className="ps-title mt-1 text-3xl leading-tight">
              Workshop
              <br />
              <span className="ps-aside">your work is the colour.</span>
            </h1>
            <p className="mt-2 max-w-xl text-xs text-muted-foreground">
              Warm stone, Geist, one solid pill for the main action (white on dark, black on light) and glass only on what floats over the stage. Tokens
              live in src/index.css, glass in src/glass.css.
            </p>
          </div>
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "Match system" },
            ]}
          />
        </header>

        <Section title="Surfaces" note="Warm stone, each tier one step lighter (dark) so panels, cards and controls read apart.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {SURFACES.map((s) => (
              <div key={s.v} className="flex flex-col overflow-hidden rounded-lg border">
                <div className={cn("h-16", s.v === "--stage" && "ps-stage")} style={s.v === "--stage" ? undefined : { background: `var(${s.v})` }} />
                <div className="flex-1 bg-card px-2.5 py-2">
                  <div className="text-xs font-medium">{s.name}</div>
                  <div className="font-mono text-micro text-muted-foreground">{tok[s.v]}</div>
                  <div className="mt-0.5 text-micro text-muted-foreground">{s.role}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Text contrast" note="WCAG ratio of each text colour on each surface. Body text needs 4.5, large text and UI 3.">
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full text-xs">
              <thead className="bg-sidebar text-left text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 font-medium">Text</th>
                  {SURFACES.map((s) => (
                    <th key={s.v} className="px-3 py-2 text-right font-medium">
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TEXTS.map((t) => (
                  <tr key={t.v} className="border-b last:border-0">
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        <i className="size-2.5 rounded-full" style={{ background: `var(${t.v})` }} />
                        {t.name}
                        <span className="font-mono text-micro text-faint">{tok[t.v]}</span>
                      </span>
                    </td>
                    {SURFACES.map((s) => (
                      <td key={s.v} className="px-3 py-1.5 text-right font-mono">
                        <Ratio r={ratio(tok[t.v] ?? "", tok[s.v] ?? "")} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr>
                  <td className="px-3 py-1.5">Text on the main-action pill</td>
                  <td className="px-3 py-1.5 text-right font-mono" colSpan={SURFACES.length}>
                    <Ratio r={ratio(tok["--primary-foreground"] ?? "", tok["--primary"] ?? "")} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Colour" note="No brand colour. Status colours mean one thing each; parts draw in filament tones.">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {MEANING.map(([v, name, role]) => (
              <div key={v} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                <i className="size-6 shrink-0 rounded-full" style={{ background: `var(${v})` }} />
                <div className="min-w-0">
                  <div className="text-xs font-medium">{name}</div>
                  <div className="text-micro text-muted-foreground">{role}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2">
            <span className="text-caption text-muted-foreground">Filament tones (parts without a colour)</span>
            {PLA_PALETTE.map((c, i) => (
              <span key={c} className="flex items-center gap-1.5 text-caption">
                <i className="size-4 rounded-full" style={{ background: c }} />
                {TONE_NAMES[i]}
              </span>
            ))}
          </div>
        </Section>

        <Section title="Type" note="Geist everywhere; Geist Mono only for code, G-code, file paths and aligned numbers.">
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            <div className="ps-title text-3xl leading-tight">
              Display title
              <br />
              <span className="ps-aside">an italic second line, sparingly.</span>
            </div>
            <div className="ps-title text-xl">Page title · Box with a hinged lid</div>
            <div className="text-sm font-semibold">Section heading · Parts · 2</div>
            <div className="text-xs">Body · If it looks right, approve it.</div>
            <div className="text-caption text-muted-foreground">Secondary · Lay the parts out on plates.</div>
            <div className="ps-label">Small label · Moves</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t pt-3 font-mono text-caption">
              <span>80 × 72.5 × 47</span>
              <span>parts/lid.scad</span>
              <span>G1 X120.4 Y88.2 E0.42</span>
            </div>
          </div>
        </Section>

        <Section title="Shape" note="Buttons are pills · chips 6 · inputs and small boxes 10 · cards 12 · panels and dialogs 24.">
          <div className="flex flex-wrap items-end gap-4">
            {[
              ["rounded-full", "pill · button", "h-8 w-24"],
              ["rounded-sm", "6 · chip", "h-6 w-16"],
              ["rounded-md", "10 · input", "h-8 w-24"],
              ["rounded-lg", "12 · card", "h-16 w-32"],
              ["rounded-3xl", "24 · panel, dialog", "h-20 w-40"],
            ].map(([r, label, size]) => (
              <div key={r} className="flex flex-col items-start gap-1.5">
                <div className={cn("border border-line-strong bg-surface-2", r, size)} />
                <span className="text-micro text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Action and selection" note="One solid pill per screen: the main action. Selected things get a tint, not a fill.">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button>
                  <PrinterIcon /> Print
                </Button>
                <Button variant="tint">
                  <PrinterIcon /> Print
                </Button>
                <Button variant="outline">
                  <ScissorsIcon /> Slice
                </Button>
                <Button variant="ghost">Details</Button>
                <Button variant="destructive">Stop</Button>
                <Button disabled>Print</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label="Show"
                  value={seg}
                  onChange={setSeg}
                  options={[
                    { value: "part", label: "Part" },
                    { value: "assembled", label: "Assembled" },
                    { value: "plate", label: "Plate" },
                  ]}
                />
                <Badge>Next</Badge>
                <Badge variant="outline">Practice</Badge>
                <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-ok/15 px-1.5 text-caption text-ok">
                  <CheckIcon className="size-3" /> Checks passed
                </span>
                <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-warn/15 px-1.5 text-caption text-warn">
                  <TriangleAlertIcon className="size-3" /> 2 to check
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Input placeholder="Describe a change or ask a question" className="max-w-xs" />
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox defaultChecked /> The bed is clear
                </label>
              </div>
              <Slider value={[slide]} min={0} max={100} onValueChange={(v) => setSlide(Array.isArray(v) ? v[0] : v)} className="max-w-xs" />
            </div>
            <div className="overflow-hidden rounded-lg border bg-sidebar p-1">
              {["base", "lid", "hinge pin"].map((p, i) => (
                <button
                  key={p}
                  onClick={() => setSel(i)}
                  className={cn("flex h-7 w-full items-center gap-2 px-3 text-left text-xs hover:bg-muted/60", sel === i ? "bg-primary/10 text-foreground hover:bg-primary/15" : "text-muted-foreground")}
                >
                  <i className="size-2 rounded-full" style={{ background: PLA_PALETTE[i] }} />
                  {p}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section title="Glass" note="Only for controls that float over the stage. Panels people read in stay solid.">
          <div
            className="ps-bleed relative flex aspect-[16/7] flex-col items-center justify-between overflow-hidden rounded-3xl border p-3"
            style={{ "--filament": PLA_PALETTE[1] } as CSSProperties}
          >
            <div className="ps-glass relative flex h-11 items-center gap-2 rounded-full! px-3 text-xs">
              <BrandMark />
              <span className="text-faint">/</span>
              <span className="font-semibold">Box with a hinged lid</span>
              <span className="mx-2 text-muted-foreground">Standard</span>
              <Button size="sm">
                <PrinterIcon /> Print
              </Button>
            </div>
            <img src="/api/starters/box-with-lid/thumbnail.png" alt="" className="max-h-[50%] object-contain" />
            <GlassTabs<View>
              label="View"
              value={view}
              onChange={setView}
              tabs={[
                { id: "overview", label: "Overview", icon: <LayoutGridIcon /> },
                { id: "model", label: "Model", icon: <CuboidIcon /> },
                { id: "assembly", label: "Assembly", icon: <ListOrderedIcon /> },
              ]}
              secondary={[{ id: "renders", label: "Renders", icon: <ImagesIcon /> }]}
            />
          </div>
        </Section>

        <Section title="Stage" note="The 3D views and every part picture sit on the same tone.">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-lg border ps-stage">
              <img src="/api/starters/box-with-lid/thumbnail.png" alt="" className="max-h-[80%] object-contain" />
            </div>
            <div className="flex flex-col gap-3">
              {["phone-stand", "plant-pot"].map((s) => (
                <div key={s} className="flex flex-1 items-center justify-center overflow-hidden rounded-lg border bg-stage">
                  <img src={`/api/starters/${s}/thumbnail.png`} alt="" className="max-h-24 object-contain" />
                </div>
              ))}
            </div>
          </div>
        </Section>
      </div>
    </div>
  )
}
