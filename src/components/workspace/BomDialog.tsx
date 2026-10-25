// Practical BOM (R17): what to print, buy, make and have on hand, with "I already have this", the global parts bin,
// pack size vs need, substitutions from the design, and the estimated cost of what's still to buy.
import { useCallback, useEffect, useState } from "react"
import type { BomCategory, BomItem, ProjectBom } from "@shared/types"
import { CheckIcon, DownloadIcon, ExternalLinkIcon, Loader2Icon, PackageIcon, RulerIcon, ShieldCheckIcon } from "@/components/icons"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { buttonVariants } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { api, errMsg } from "@/lib/api"
import { cn } from "@/lib/utils"

const SECTIONS: { id: BomCategory; title: string; blurb: string }[] = [
  { id: "purchased", title: "Buy", blurb: "Hardware to get. Tick what you already have." },
  { id: "consumable", title: "Supplies", blurb: "Glue, tape and the like." },
  { id: "make", title: "Make it yourself", blurb: "Nothing to buy: made from your own filament." },
  { id: "printed", title: "Print", blurb: "Parts you print." },
  { id: "tool", title: "Tools", blurb: "Have these on hand (not counted in the cost)." },
]

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(n % 1 ? 2 : 0)}`)

export function BomDialog({
  projectId,
  open,
  onOpenChange,
  shoppingListUrl,
}: {
  projectId: string
  open: boolean
  onOpenChange: (o: boolean) => void
  shoppingListUrl: string | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-4xl">{open && <Body projectId={projectId} shoppingListUrl={shoppingListUrl} />}</DialogContent>
    </Dialog>
  )
}

function Body({ projectId, shoppingListUrl }: { projectId: string; shoppingListUrl: string | null }) {
  const [bom, setBom] = useState<ProjectBom | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .bom(projectId)
      .then(setBom)
      .catch((e) => setError(errMsg(e)))
  }, [projectId])
  useEffect(load, [load])

  const toggleHave = async (it: BomItem, have: boolean) => {
    setPending(it.key)
    try {
      setBom(await api.setHave(projectId, it.key, have))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setPending(null)
    }
  }
  const toggleBin = async (it: BomItem) => {
    setPending(it.key)
    try {
      await api.setInBin(it.key, it.name, !it.inBin)
      // follow the bin from now on in this project too
      setBom(await api.setHave(projectId, it.key, null))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setPending(null)
    }
  }

  const t = bom?.totals
  return (
    <>
      <DialogHeader>
        <DialogTitle className="pr-8">What you need</DialogTitle>
        {t && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span>
              <b className="text-sm">{t.toBuy}</b> item{t.toBuy === 1 ? "" : "s"} still to buy
            </span>
            {t.estUsd != null && (
              <span>
                est. <b className="text-sm">≈ {usd(t.estUsd)}</b>
                {t.unpriced > 0 && <span className="text-muted-foreground"> + {t.unpriced} without a price</span>}
              </span>
            )}
            {t.have > 0 && <span className="text-ok">{t.have} already on hand</span>}
          </div>
        )}
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-auto pr-1">
        {error && <div className="mb-2 text-xs text-err">{error}</div>}
        {!bom ? (
          !error && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <div className="flex flex-col gap-5">
            {SECTIONS.map((s) => {
              const items = bom.items.filter((i) => i.category === s.id)
              if (!items.length) return null
              return (
                <section key={s.id}>
                  <div className="mb-1 flex items-baseline gap-2 border-b pb-1">
                    <h3 className="text-sm font-semibold">{s.title}</h3>
                    <span className="text-caption text-muted-foreground">{s.blurb}</span>
                  </div>
                  <div className="flex flex-col">
                    {items.map((it) => (
                      <Row key={it.key} it={it} busy={pending === it.key} onHave={(v) => void toggleHave(it, v)} onBin={() => void toggleBin(it)} />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-caption text-muted-foreground">
        <span className="flex-1">
          {bom?.priceNote ?? "No price estimates for your region; search links use your stores from Settings."} “Search on …” opens a store search, not a
          specific product.
        </span>
        {shoppingListUrl && (
          <>
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href={shoppingListUrl.replace(/shopping-list\.md/, "shopping-list.csv")} download="shopping-list.csv">
              <DownloadIcon /> CSV
            </a>
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href={shoppingListUrl} target="_blank" rel="noreferrer">
              <ExternalLinkIcon /> Markdown
            </a>
          </>
        )}
      </div>
    </>
  )
}

function Row({ it, busy, onHave, onBin }: { it: BomItem; busy: boolean; onHave: (v: boolean) => void; onBin: () => void }) {
  const buyable = it.category === "purchased" || it.category === "consumable" || it.category === "tool"
  const listings = it.links.filter((l) => l.kind === "listing")
  const searches = it.links.filter((l) => l.kind === "search")
  return (
    <div className={cn("grid grid-cols-[auto_3rem_1fr_auto] items-start gap-x-3 gap-y-1 border-b border-border/50 py-2 text-xs", it.have && "opacity-60")}>
      <label className="flex h-5 items-center" title="I already have this">
        <Checkbox checked={it.have} disabled={busy} onCheckedChange={(v) => onHave(!!v)} aria-label={`I already have ${it.name}`} />
      </label>
      <div className="text-sm">{it.need != null ? `${it.need}×` : ""}</div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className={cn("font-medium", it.have && "line-through decoration-muted-foreground")}>
          {it.color && <span className="mr-1.5 inline-block size-2.5 rounded-full border align-middle" style={{ background: it.color }} />}
          {it.name}
          {it.needText && <span className="ml-1.5 font-normal text-muted-foreground">({it.needText})</span>}
        </div>
        {it.spec.length > 0 && <div className="text-muted-foreground">{it.spec.join(" · ")}</div>}
        {it.pack && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <PackageIcon className="size-3" /> {it.pack.text}
          </div>
        )}
        {it.fit?.map((f) => (
          <div key={f} className="flex items-start gap-1 text-muted-foreground">
            <RulerIcon className="mt-0.5 size-3 shrink-0" /> {f}
          </div>
        ))}
        {it.substitutes?.map((s) => (
          <div key={s.size}>
            <span className="text-muted-foreground">Also works: </span>
            <b>{s.size}</b>
            {s.note && <span className="text-muted-foreground"> ({s.note})</span>}
          </div>
        ))}
        {it.note && <div className="text-muted-foreground">{it.note}</div>}
        {it.steps.length > 0 && <div className="text-caption text-muted-foreground">Step{it.steps.length > 1 ? "s" : ""} {it.steps.join(", ")}</div>}
        {listings.map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
            <ShieldCheckIcon className="size-3 shrink-0" />
            <span>
              Verified listing: {l.label}
              <span className="text-muted-foreground">
                {" "}
                · checked {l.checkedAt}
                {l.price ? ` · ${l.price}` : ""}
              </span>
            </span>
          </a>
        ))}
        {searches.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {searches.map((l) => (
              <a
                key={l.url}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                title={`${l.note ? l.note + ". " : ""}Opens a store search for “${it.searchTerm ?? it.name}”, not a specific product.`}
                className="border px-1.5 py-0.5 text-caption text-muted-foreground hover:border-primary/60 hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col items-end gap-1 text-right">
        {it.estCost && !it.have && (
          <span title={it.estCost.basis === "listing" ? "Price on the verified listing" : "Typical US price for a common pack"}>
            {it.estCost.basis === "typical" ? "≈ " : ""}
            {usd(it.estCost.usd)}
          </span>
        )}
        {buyable && (
          <button
            onClick={onBin}
            disabled={busy}
            className={cn("flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground", it.inBin && "text-ok")}
            title={it.inBin ? "In your parts bin: ticked in every project. Click to remove." : "You keep these around: tick it in every project"}
          >
            {it.inBin ? (
              <>
                <CheckIcon className="size-3" /> In my parts bin
              </>
            ) : (
              "Add to my parts bin"
            )}
          </button>
        )}
      </div>
    </div>
  )
}
