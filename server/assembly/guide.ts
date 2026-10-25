// Self-contained, print-friendly IKEA-style assembly guide (HTML). Images are embedded as data URIs.
import type { Assembly, AssemblyHardware, AssemblyMotion, AssemblyStep, MotionCheck, SourcingSettings } from "../../shared/types"
import { drawingSvg, hardwareDrawing, hardwareName, hardwareSpec, isMakeYourself, makeInstruction, toolIcon } from "./hardware"
import { stepQty } from "./schema"
import { motionCheckText, tightGap } from "../../shared/motion-text"
import { instanceSteps, letterRange, partLetters } from "../../shared/assembly-art"
import { buildShoppingList, type ShoppingList } from "./shopping"
import { DEFAULT_SOURCING, searchTerm, storeLinks } from "./stores"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"

// Geist and Geist Mono (the app's type) embedded so the guide stays one self-contained file; system fonts if missing.
function fontFaces(): string {
  const faces: [string, number, string][] = [
    ["Geist", 400, "@fontsource/geist/files/geist-latin-400-normal.woff2"],
    ["Geist", 600, "@fontsource/geist/files/geist-latin-600-normal.woff2"],
    ["Geist Mono", 400, "@fontsource/geist-mono/files/geist-mono-latin-400-normal.woff2"],
    ["Geist Mono", 500, "@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff2"],
  ]
  let req: NodeRequire
  try {
    req = createRequire(import.meta.url)
  } catch {
    return ""
  }
  return faces
    .map(([family, weight, mod]) => {
      try {
        const f = req.resolve(mod)
        if (!existsSync(f)) return ""
        return `@font-face { font-family: "${family}"; font-weight: ${weight}; font-style: normal; src: url(data:font/woff2;base64,${readFileSync(f).toString("base64")}) format("woff2"); }`
      } catch {
        return ""
      }
    })
    .join("\n")
}
let FONT_CSS: string | null = null

export interface GuideImages {
  complete: string // data URI of the finished assembly
  steps: Record<number, string>
  parts: Record<string, string>
  motions: Record<number, { label: string; src: string }[]> // step n -> "How it moves" frames
  /** R14: step n -> inline SVG (raster + vector arrows / callouts / glue / close-up), preferred over steps[n] */
  stepSvgs?: Record<number, string>
  /** R14: part id -> its instance letters ("A", "C", "D"…) as labelled in the step pictures and on the plates */
  letters?: Record<string, string[]>
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const titleCase = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())

const WARN_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2.5 L22.5 21 H1.5 Z" fill="#ffcc00" stroke="#1d1d1f" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 9 v6" stroke="#1d1d1f" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.3" fill="#1d1d1f"/></svg>`
const TIP_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#1d1d1f" stroke-width="1.6"/><path d="M12 10.5 v6.5" stroke="#1d1d1f" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7" r="1.3" fill="#1d1d1f"/></svg>`

function colorChip(c: string) {
  return `<span class="chip" style="background:${esc(c)}"></span>${esc(c)}`
}

function partsSection(a: Assembly, img: GuideImages) {
  const cards = a.parts
    .map(
      (p) => `<div class="part">
  <div class="qty">${p.qty}×</div>
  ${img.letters?.[p.id]?.length ? `<div class="letters">${esc(letterRange(img.letters[p.id]))}</div>` : ""}
  <img src="${img.parts[p.id] ?? ""}" alt="${esc(p.name ?? p.id)}">
  <div class="name">${esc(p.name ?? titleCase(p.id))}</div>
  <div class="meta">${colorChip(p.color)}</div>
  ${p.notes ? `<div class="note">${esc(p.notes)}</div>` : ""}
</div>`,
    )
    .join("")
  return `<section class="block"><h2>Printed parts</h2><div class="parts">${cards}</div></section>`
}

/** Store search links, always labelled as searches (verified listings are shown separately, with their check date). */
function linkList(links: { label: string; url: string }[]) {
  return links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Search on ${esc(l.label)}</a>`).join(" · ")
}

function hardwareRow(h: AssemblyHardware, sourcing: SourcingSettings) {
  const dw = hardwareDrawing(h)
  const spec = hardwareSpec(h)
  return `<div class="hw">
  <div class="hw-draw">${drawingSvg(dw, "true")}</div>
  <div class="hw-qty">${h.qty}×</div>
  <div class="hw-text">
    <div class="name">${esc(hardwareName(h))}</div>
    ${spec.length ? `<div class="meta">${spec.map(esc).join(" · ")}</div>` : ""}
    ${h.notes ? `<div class="note">${esc(h.notes)}</div>` : ""}
  </div>
  ${
    isMakeYourself(h)
      ? `<div class="buy make"><b>Make it:</b> ${esc(makeInstruction(h))}</div>`
      : `<div class="buy">Search for <b>${esc(searchTerm(h))}</b><div class="links">${linkList(storeLinks(h, searchTerm(h), sourcing))}</div></div>`
  }
</div>`
}

function hardwareSection(a: Assembly, sourcing: SourcingSettings) {
  if (!a.hardware.length) return ""
  const anyTrue = a.hardware.some((h) => hardwareDrawing(h).trueScale)
  const scale = anyTrue
    ? `<div class="scale"><svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="4mm" viewBox="0 0 50 4"><rect x="0" y="1" width="50" height="2" fill="#1d1d1f"/><rect x="10" y="1" width="10" height="2" fill="#fff"/><rect x="30" y="1" width="10" height="2" fill="#fff"/><rect x="0" y="1" width="50" height="2" fill="none" stroke="#1d1d1f" stroke-width="0.2"/></svg>
<span>Drawn at actual size. Print at 100% and check this bar measures 50 mm, then lay your hardware on the page to match it.</span></div>`
    : ""
  const heading = a.hardware.every(isMakeYourself) ? "Cut from your filament" : "Hardware"
  return `<section class="block"><h2>${heading}</h2>${scale}<div class="hws">${a.hardware.map((h) => hardwareRow(h, sourcing)).join("")}</div></section>`
}

function toolsSection(a: Assembly) {
  if (!a.tools.length && !a.consumables.length) return ""
  const tools = a.tools
    .map((t) => `<div class="tool">${toolIcon(t)}<div><div class="name">${esc(t.name)}</div>${t.notes ? `<div class="note">${esc(t.notes)}</div>` : ""}</div></div>`)
    .join("")
  const cons = a.consumables
    .map(
      (c) => `<div class="tool">${drawingSvg(hardwareDrawing({ id: c.id, type: /glue|ca\b|epoxy/i.test(c.name) ? "glue" : /tape/i.test(c.name) ? "tape" : "other", qty: 1 }), { maxW: 40, maxH: 40 })}<div><div class="name">${esc(c.name)}${c.qty ? ` <span class="meta">(${esc(c.qty)})</span>` : ""}</div>${c.purchaseHint ? `<div class="buy">Search: <b>${esc(c.purchaseHint)}</b></div>` : ""}${c.notes ? `<div class="note">${esc(c.notes)}</div>` : ""}</div></div>`,
    )
    .join("")
  return `<section class="block"><h2>Tools${a.consumables.length ? " &amp; supplies" : ""}</h2><div class="tools">${tools}${cons}</div></section>`
}

function stepCallouts(a: Assembly, s: AssemblyStep, img: GuideImages) {
  const items = s.adds.map((x) => {
    const id = typeof x === "string" ? x : x.id
    const qty = stepQty(a, x)
    const part = a.parts.find((p) => p.id === id)
    const hw = a.hardware.find((h) => h.id === id)
    const con = a.consumables.find((c) => c.id === id)
    let pic = ""
    let label = ""
    if (part) {
      pic = `<img src="${img.parts[id] ?? ""}" alt="">`
      label = part.name ?? titleCase(part.id)
    } else if (hw) {
      pic = drawingSvg(hardwareDrawing(hw), { maxW: 92, maxH: 56 })
      label = hardwareName(hw)
    } else if (con) {
      pic = drawingSvg(hardwareDrawing({ id, type: /glue|ca\b|epoxy/i.test(con.name) ? "glue" : "other", qty: 1 }), { maxW: 40, maxH: 40 })
      label = con.name
    }
    const lt = part && img.letters ? letterRange([...partLetters(a)].filter(([k]) => k.startsWith(`${id}#`) && instanceSteps(a).get(k) === s.n).map(([, l]) => l)) : ""
    return `<div class="co">${lt ? `<div class="co-letters">${esc(lt)}</div>` : ""}<div class="co-pic">${pic}</div><div class="co-qty">${con ? "" : `${qty}×`}</div><div class="co-label">${esc(label)}</div></div>`
  })
  const tools = (s.tools ?? [])
    .map((tid) => a.tools.find((t) => t.id === tid))
    .filter((t) => t)
    .map((t) => `<div class="co tool-co">${toolIcon(t!)}<div class="co-label">${esc(t!.name)}</div></div>`)
  return `<div class="callouts">${items.join("")}${tools.join("")}</div>`
}

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#1f8a4c"/><path d="M6.5 12.5 l3.5 3.5 7.5 -8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
/** "Both magnets…" -> "both magnets…", "A click…" -> "a click…"; keeps acronyms and sizes ("M3", "PLA", "USB"). */
export const lowerFirst = (t: string) => (/^([A-Z][a-z]|A\s)/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t)

function motionWords(m: AssemblyMotion): string {
  const u = m.type === "rotate" ? "°" : " mm"
  return `${m.type === "rotate" ? "turns" : "slides"} ${m.range[0]}–${m.range[1]}${u}${m.continuous ? ", all the way round" : ""}`
}

/** What the on-screen collision check covered for this motion, or "" when there is no current check to quote.
 *  Never says "moves freely": always the number of positions and the range, and what isn't checked. */
export function motionScopeLine(m: AssemblyMotion, chk: MotionCheck | null | undefined): string {
  if (!chk || chk.stale) return ""
  if (chk.status === "incomplete") return `Only partly checked on screen: ${chk.incomplete[0] ?? "some pieces couldn't be checked"}`
  const r = chk.motions.find((x) => x.id === m.id)
  if (!r) return ""
  if (!r.ok) return `Checked on screen: ${r.text}`
  const u = r.unit === "°" ? "°" : " mm"
  const rub = tightGap(m, chk)
  return `Checked on screen: no collisions found in ${r.coverage.positions} positions from ${r.coverage.from}${u} to ${r.coverage.to}${u}${rub !== null ? `, but the closest gap is only ${rub} mm, so it may rub once printed` : ""}. Strength and friction aren't checked.`
}

function motionStrip(a: Assembly, s: AssemblyStep, img: GuideImages, chk?: MotionCheck | null) {
  const frames = img.motions[s.n]
  const m = (a.motions ?? []).find((x) => x.id === s.showMotion)
  if (!frames || !m) return ""
  return `<div class="moves"><div class="moves-head">How it moves: <b>${esc(m.label)}</b>${m.check ? ` <span class="meta">· ${esc(motionCheckText(m, chk))}</span>` : ""}</div>
<div class="frames">${frames.map((f, i) => `${i ? '<span class="arrow">→</span>' : ""}<figure><img src="${f.src}" alt=""><figcaption>${esc(f.label)}</figcaption></figure>`).join("")}</div>${scopeHtml(m, chk)}</div>`
}

function scopeHtml(m: AssemblyMotion, chk?: MotionCheck | null) {
  const line = motionScopeLine(m, chk)
  return line ? `<div class="wm-scope">${esc(line)}</div>` : ""
}

function movesSection(a: Assembly, chk?: MotionCheck | null) {
  if (!a.motions?.length) return ""
  return `<div class="what-moves"><div class="wm-title">What moves</div>${a.motions
    .map((m) => `<div class="wm"><div class="name">${esc(m.label)}</div><div class="meta">${esc(motionWords(m))}</div>${m.check ? `<div class="wm-check">${CHECK_ICON}<span>${esc(motionCheckText(m, chk))}</span></div>` : ""}${scopeHtml(m, chk)}</div>`)
    .join("")}</div>`
}

function stepPage(a: Assembly, s: AssemblyStep, img: GuideImages, total: number, title: string, chk?: MotionCheck | null) {
  const warnings = (s.warnings ?? []).map((w) => `<div class="warn">${WARN_ICON}<span>${esc(w)}</span></div>`).join("")
  const tips = (s.tips ?? []).map((w) => `<div class="tip">${TIP_ICON}<span>${esc(w)}</span></div>`).join("")
  return `<section class="page step">
  <header class="step-head"><div class="num">${s.n}</div><h2>${esc(s.title)}</h2></header>
  ${stepCallouts(a, s, img)}
  <p class="text">${esc(s.text)}</p>
  ${s.check ? `<div class="got-it">${CHECK_ICON}<div><b>You got it right when</b> ${esc(lowerFirst(s.check.replace(/^you got it right when\s*/i, "")))}</div></div>` : ""}
  ${warnings}${tips}
  <div class="shot${img.motions[s.n] ? " short" : ""}">${img.stepSvgs?.[s.n] ?? `<img src="${img.steps[s.n] ?? ""}" alt="Step ${s.n}">`}</div>
  ${motionStrip(a, s, img, chk)}
  <footer><span>${esc(title)}</span><span>Step ${s.n} of ${total}</span></footer>
</section>`
}

function shoppingPage(list: ShoppingList, title: string) {
  if (!list.items.length && !list.consumables.length && !list.make.length) return ""
  const head = (what: string) => `<thead><tr><th></th><th>Need</th><th></th><th>${what}</th><th>Suggested pack</th><th>Where to buy</th></tr></thead>`
  const rows = list.items
    .map(
      (it) => `<tr>
  <td class="check"><span></span></td>
  <td class="need">${it.need}×</td>
  <td class="pic">${drawingSvg(hardwareDrawing(it.sample), { maxW: 76, maxH: 40 })}</td>
  <td><div class="name">${esc(it.name)}</div>${it.spec.length ? `<div class="meta">${it.spec.map(esc).join(" · ")}</div>` : ""}${it.steps.length ? `<div class="meta">Step${it.steps.length > 1 ? "s" : ""} ${it.steps.join(", ")}</div>` : ""}${it.sample.fit ? `<div class="meta">${esc(it.sample.fit)}</div>` : ""}${(it.sample.substitutes ?? []).map((s) => `<div class="meta">Also works: <b>${esc(s.size)}</b>${s.note ? ` (${esc(s.note)})` : ""}</div>`).join("")}</td>
  <td><div>${esc(it.pack)}</div></td>
  <td><div class="buy">Search for <b>${esc(it.term)}</b></div><div class="links">${linkList(it.links)}</div>${it.listings
        .map(
          (l) =>
            `<div class="listing">Verified listing, checked ${esc(l.retrievedAt)}: <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.store)}: ${esc(l.title)}</a>${l.partNumber ? ` · ${esc(l.partNumber)}` : ""}${l.price ? ` · ${esc(l.price)}` : ""}</div>`,
        )
        .join("")}</td>
</tr>`,
    )
    .join("")
  const cons = list.consumables
    .map(
      (c) => `<tr><td class="check"><span></span></td><td class="need"></td><td class="pic"></td><td><div class="name">${esc(c.name)}</div>${c.qty ? `<div class="meta">${esc(c.qty)}</div>` : ""}</td><td>1</td><td><div class="buy">Search for <b>${esc(c.term)}</b></div><div class="links">${linkList(c.links)}</div></td></tr>`,
    )
    .join("")
  const make = list.make
    .map(
      (m) => `<tr><td class="check"><span></span></td><td class="need">${m.need}×</td><td class="pic">${drawingSvg(hardwareDrawing(m.sample), { maxW: 76, maxH: 40 })}</td><td><div class="name">${esc(m.name)}</div>${m.steps.length ? `<div class="meta">Step${m.steps.length > 1 ? "s" : ""} ${m.steps.join(", ")}</div>` : ""}</td><td colspan="2"><div class="buy make">${esc(m.instruction)}</div></td></tr>`,
    )
    .join("")
  const tools = list.tools.length ? `<p class="meta" style="margin-top:4mm">Tools (not listed above): ${list.tools.map((t) => esc(t.name)).join(", ")}.</p>` : ""
  const buying = rows || cons
  const intro = buying
    ? "Everything to buy for this build. Links open a store search for the exact spec; check size, standard and material on the listing before you buy."
    : "Nothing to buy for this build."
  return `<section class="page shopping">
  <header class="step-head"><h2 class="title">${buying ? "Shopping list" : "Before you start"}</h2></header>
  <p class="meta" style="margin:3mm 0 4mm">${intro}</p>
  ${rows ? `<table class="shop">${head("Hardware")}<tbody>${rows}</tbody></table>` : ""}
  ${cons ? `<table class="shop" style="margin-top:5mm">${head("Supplies")}<tbody>${cons}</tbody></table>` : ""}
  ${make ? `<h2 style="margin-top:6mm">Make it yourself</h2><table class="shop"><tbody>${make}</tbody></table>` : ""}
  ${tools}
  <footer><span>${esc(title)}</span><span>${buying ? "Shopping list" : "Before you start"}</span></footer>
</section>`
}

const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html { background: #e9e9ec; }
body { margin: 0; color: #111; font: 14px/1.45 "Geist", -apple-system, "Helvetica Neue", Arial, sans-serif; font-feature-settings: "tnum" 1; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; min-height: 297mm; margin: 24px auto; padding: 14mm 14mm 18mm; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.12); position: relative; display: flex; flex-direction: column; }
@media print { html { background: #fff; } .page { margin: 0; box-shadow: none; break-after: page; } .page:last-child { break-after: auto; } }
@media screen and (max-width: 820px) { .page { width: 100%; min-height: auto; margin: 0 0 12px; padding: 16px; } }
h1 { font-size: 27px; line-height: 1.15; margin: 0; letter-spacing: -0.015em; font-weight: 600; }
h2 { font: 500 12.5px/1.3 "Geist Mono", ui-monospace, monospace; margin: 0 0 3mm; color: #333; }
h2::before { content: "› "; color: #3d5ff0; font-weight: 600; }
h2.title { font: 600 20px/1.2 "Geist", sans-serif; color: #111; letter-spacing: -0.01em; }
h2.title::before { content: none; }
.sub { color: #6e6e73; font-size: 13px; margin-top: 1mm; }
.cover { display: grid; grid-template-columns: 1fr 62mm; gap: 6mm; align-items: center; border-bottom: 1.5px solid #111; padding-bottom: 4mm; margin-bottom: 5mm; }
.cover img { width: 100%; display: block; }
.summary { margin: 3mm 0 0; font-size: 14px; }
.facts { display: flex; gap: 2mm; margin-top: 3mm; flex-wrap: wrap; }
.fact { border: 1px solid #111; border-radius: 0; padding: 1mm 2.5mm; font: 500 11.5px "Geist Mono", ui-monospace, monospace; white-space: nowrap; }
.block { margin-bottom: 4mm; break-inside: avoid; }
.parts { display: grid; grid-template-columns: repeat(auto-fill, minmax(42mm, 1fr)); gap: 3mm; }
.part { border: 1px solid #111; border-radius: 0; padding: 2mm; position: relative; text-align: center; break-inside: avoid; }
.part img { width: 100%; height: 22mm; object-fit: contain; display: block; }
.qty, .hw-qty, .co-qty { font: 500 20px "Geist Mono", ui-monospace, monospace; letter-spacing: -0.02em; }
.part .qty { position: absolute; top: 1.5mm; left: 2.5mm; z-index: 1; }
.name { font-weight: 600; }
.meta { color: #55555a; font-size: 12px; }
.note { font-size: 12px; color: #55555a; margin-top: 1mm; }
.buy { font-size: 11.5px; color: #55555a; margin-top: .8mm; }
.buy b { color: #111; font-weight: 500; font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; }
.chip { display: inline-block; width: 3mm; height: 3mm; border-radius: 0; border: 1px solid #111; vertical-align: -0.4mm; margin-right: 1.2mm; }
.scale { display: flex; align-items: center; gap: 4mm; font-size: 11.5px; color: #55555a; margin-bottom: 3mm; }
.scale svg { flex: none; }
.hws { display: grid; gap: 0; }
.hw { display: grid; grid-template-columns: 50mm 14mm 1fr 52mm; align-items: center; gap: 3mm; border-top: 1px solid #d2d2d7; padding: 1.5mm 0; break-inside: avoid; }
.hw:last-child { border-bottom: 1px solid #d2d2d7; }
.hw-draw { display: flex; align-items: center; justify-content: flex-start; min-height: 10mm; }
.hw .buy { margin: 0; }
.links { margin-top: .6mm; font-size: 11.5px; }
.buy.make { color: #1d1d1f; font-size: 12px; }
.links a { color: #3d5ff0; text-decoration: none; font-weight: 600; }
.links a:hover { text-decoration: underline; }
.shop { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.shop th { text-align: left; font: 500 11px "Geist Mono", ui-monospace, monospace; color: #55555a; border-bottom: 1.5px solid #111; padding: 1.5mm 2mm 1.5mm 0; }
.shop td { border-bottom: 1px solid #d2d2d7; padding: 2mm 2mm 2mm 0; vertical-align: top; break-inside: avoid; }
.shop .check { width: 6mm; } .shop .check span { display: inline-block; width: 3.6mm; height: 3.6mm; border: 1.5px solid #111; border-radius: 0; }
.shop .need { font: 500 16px "Geist Mono", ui-monospace, monospace; white-space: nowrap; width: 12mm; }
.shop .pic { width: 22mm; }
.listing { font-size: 11px; color: #55555a; margin-top: .6mm; }
.listing a { color: #3d5ff0; }
.tools { display: grid; grid-template-columns: repeat(auto-fill, minmax(56mm, 1fr)); gap: 3mm 6mm; }
.tool { display: flex; align-items: center; gap: 3mm; }
.tool svg { flex: none; }
.step-head { display: flex; align-items: baseline; gap: 5mm; border-bottom: 1.5px solid #111; padding-bottom: 2mm; }
.num { font: 500 60px/.9 "Geist Mono", ui-monospace, monospace; letter-spacing: -0.04em; }
.step-head h2 { font: 600 20px/1.2 "Geist", sans-serif; color: #111; letter-spacing: -0.01em; margin: 0; }
.step-head h2::before { content: none; }
.callouts { display: flex; flex-wrap: wrap; gap: 3mm; margin: 4mm 0 0; }
.co { border: 1px solid #111; border-radius: 0; padding: 2mm 3mm; display: grid; grid-template-columns: auto auto; grid-template-rows: 1fr auto; column-gap: 2.5mm; align-items: center; min-height: 22mm; }
.co { position: relative; }
.co-letters { position: absolute; top: -1px; right: -1px; background: #16171a; color: #fff; font: 600 11.5px "Geist Mono", ui-monospace, monospace; padding: .2mm 1.2mm; }
.co-pic { grid-row: 1; display: flex; align-items: center; justify-content: center; min-width: 14mm; }
.co-pic img { height: 18mm; width: 24mm; object-fit: contain; }
.co-qty { grid-row: 1; }
.co-label { grid-column: 1 / -1; font-size: 11px; color: #55555a; text-align: center; max-width: 46mm; }
.tool-co { grid-template-columns: auto; border-style: dashed; }
.shot { flex: 1; display: flex; align-items: center; justify-content: center; margin: 2mm 0 6mm; }
.shot img, .shot svg { width: 100%; max-height: 175mm; object-fit: contain; height: auto; display: block; }
.shot.short svg { max-height: 120mm; }
.part .letters { position: absolute; top: 1.5mm; right: 2.5mm; z-index: 1; background: #16171a; color: #fff; font: 600 12px "Geist Mono", ui-monospace, monospace; padding: .3mm 1.4mm; }
.text { font-size: 17px; line-height: 1.45; margin: 4mm 0 0; max-width: 170mm; }
.warn, .tip { display: flex; gap: 3mm; align-items: center; border: 1.5px solid #111; border-radius: 0; padding: 2mm 3mm; margin-top: 3mm; font-weight: 600; break-inside: avoid; }
.warn { background: #fff6cc; border-left: 4mm solid #e0b400; }
.warn svg, .tip svg { flex: none; }
.tip { font-weight: 500; border-width: 1.5px; }
.got-it { display: flex; gap: 3mm; align-items: center; background: #e8f8f2; border: 1.5px solid #0f9b74; border-left-width: 4mm; border-radius: 0; padding: 2.5mm 3mm; margin-top: 3mm; font-size: 15px; break-inside: avoid; }
.got-it svg, .wm-check svg { flex: none; }
.got-it b { color: #0b7457; }
.shot.short img { max-height: 120mm; }
.moves { border-top: 1px solid #d2d2d7; padding-top: 2.5mm; margin-bottom: 6mm; break-inside: avoid; }
.moves-head { font-size: 13px; margin-bottom: 1.5mm; }
.frames { display: flex; align-items: center; gap: 2mm; }
.frames figure { margin: 0; flex: 1; text-align: center; }
.frames img { width: 100%; max-height: 40mm; object-fit: contain; }
.frames figcaption { font: 500 11.5px "Geist Mono", ui-monospace, monospace; }
.frames .arrow { font-size: 20px; color: #86868b; }
.what-moves { margin-top: 3mm; display: grid; gap: 1.5mm; }
.wm-title { font: 500 11.5px "Geist Mono", ui-monospace, monospace; }
.wm-title::before { content: "› "; color: #5d8a00; font-weight: 600; }
.wm { border-left: 3px solid #5d8a00; padding: 0.5mm 0 0.5mm 3mm; }
.wm .name { display: inline; } .wm .meta { display: inline; margin-left: 1.5mm; }
.wm-check { display: flex; gap: 2mm; align-items: center; margin-top: 1.5mm; font-size: 12.5px; }
.wm-check svg { width: 18px; height: 18px; }
.wm-scope { margin-top: 1mm; font-size: 11px; color: #55555a; }
footer { position: absolute; left: 14mm; right: 14mm; bottom: 8mm; display: flex; justify-content: space-between; font: 400 10.5px "Geist Mono", ui-monospace, monospace; color: #77776f; border-top: 1px solid #c8c8c4; padding-top: 2mm; }
@media screen and (max-width: 820px) { footer { position: static; margin-top: 4mm; } .cover { grid-template-columns: 1fr; } .hw { grid-template-columns: auto 14mm 1fr; } .hw .buy { grid-column: 3; } }
`

export function buildGuideHtml(
  a: Assembly,
  img: GuideImages,
  opts: { projectName: string; sourcing?: SourcingSettings; motionCheck?: MotionCheck | null },
): string {
  const title = a.title ?? opts.projectName
  const sourcing = opts.sourcing ?? DEFAULT_SOURCING
  const totalParts = a.parts.reduce((n, p) => n + p.qty, 0)
  // Say what is actually there: "3 printed parts · 4 screws… · glue · 4 steps"; never "0 hardware".
  const bought = a.hardware.filter((h) => !isMakeYourself(h)).reduce((n, h) => n + h.qty, 0)
  const made = a.hardware.filter(isMakeYourself)
  const supplies = a.consumables.map((c) => c.name.replace(/\s*\(.*?\)\s*/g, " ").trim().toLowerCase())
  const facts = [
    `${totalParts} printed part${totalParts === 1 ? "" : "s"}`,
    bought ? `${bought} hardware item${bought === 1 ? "" : "s"}` : "",
    ...made.map((h) => `${h.qty > 1 ? `${h.qty}× ` : ""}${hardwareName(h)}`),
    ...supplies,
    `${a.steps.length} step${a.steps.length === 1 ? "" : "s"}`,
    a.timeMinutes ? `about ${a.timeMinutes} min` : "",
  ].filter(Boolean)
  const first = `<section class="page first">
  <div class="cover">
    <div>
      <div class="sub">Assembly guide</div>
      <h1>${esc(title)}</h1>
      ${a.summary ? `<p class="summary">${esc(a.summary)}</p>` : ""}
      <div class="facts">${facts.map((f) => `<span class="fact">${esc(f)}</span>`).join("")}</div>
      ${movesSection(a, opts.motionCheck)}
    </div>
    <img src="${img.complete}" alt="Finished assembly">
  </div>
  <h2 class="title">Everything you need</h2>
  ${partsSection(a, img)}
  ${hardwareSection(a, sourcing)}
  ${toolsSection(a)}
  <footer><span>${esc(title)}</span><span>Parts list</span></footer>
</section>`
  const steps = a.steps.map((s) => stepPage(a, s, img, a.steps.length, title, opts.motionCheck)).join("\n")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Assembly guide</title>
<style>${(FONT_CSS ??= fontFaces())}
${CSS}</style></head>
<body>
${first}
${steps}
${shoppingPage(buildShoppingList(a, sourcing), title)}
</body></html>
`
}
