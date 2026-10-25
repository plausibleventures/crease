// Print-quality checks on sliced G-code (see GcodeQualityIssue). Heuristics, tuned on a real SPARKX i7 print
// (apple logo: ragged top edge from gap infill + no ironing + 200 mm/s walls; a 2 mm stick printed in mid-air).
import type { GcodeQualityIssue, PrintIntent, SlicePreviewSummary } from "../../shared/types"
import type { ParsedGcode, ParsedLayer } from "./parse"

const CELL = 0.5 // mm, occupancy grid for support checks (1 cell = allowed overhang per layer)
const NOT_PART = new Set(["Skirt", "Brim", "Prime tower", "Custom", "Support", "Support interface", "Wipe tower"])
// Bridges span gaps on purpose; overhang walls do NOT count (a wall with no wall under it is in mid-air).
const BRIDGES = new Set(["Bridge", "Internal Bridge"])

type Grid = Set<number>
const key = (cx: number, cy: number) => cx * 100003 + cy

/** Cells (CELL mm) a layer's part extrusions cover; `only` limits to some features. */
function occupancy(layer: ParsedLayer, only?: (feature: string) => boolean): Grid {
  const g: Grid = new Set()
  for (const s of layer.segments) {
    if (NOT_PART.has(s.feature) || (only && !only(s.feature))) continue
    const c = s.coords
    for (let i = 0; i < c.length; i += 4) {
      const len = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])
      const steps = Math.max(1, Math.ceil(len / (CELL / 2)))
      for (let k = 0; k <= steps; k++) {
        const x = c[i] + ((c[i + 2] - c[i]) * k) / steps
        const y = c[i + 1] + ((c[i + 3] - c[i + 1]) * k) / steps
        g.add(key(Math.floor(x / CELL), Math.floor(y / CELL)))
      }
    }
  }
  return g
}

/** Isolated ends of top-surface lines (a point used by only one top segment). */
function topLineEnds(layer: ParsedLayer, feature = "Top surface"): [number, number][] {
  const count = new Map<string, { n: number; x: number; y: number }>()
  for (const s of layer.segments) {
    if (s.feature !== feature) continue
    const c = s.coords
    for (let i = 0; i < c.length; i += 2) {
      const k = `${c[i].toFixed(1)},${c[i + 1].toFixed(1)}`
      const e = count.get(k)
      if (e) e.n++
      else count.set(k, { n: 1, x: c[i], y: c[i + 1] })
    }
  }
  return [...count.values()].filter((e) => e.n === 1).map((e) => [e.x, e.y])
}

/**
 * Where a feature's straight lines turn back (> 60° between consecutive segments). OrcaSlicer joins first-layer
 * bottom lines into one zigzag, so their ends are turns, not loose ends.
 */
function lineTurns(layer: ParsedLayer, feature: string): [number, number][] {
  const out: [number, number][] = []
  for (const s of layer.segments) {
    if (s.feature !== feature) continue
    const c = s.coords
    for (let i = 4; i < c.length; i += 4) {
      if (c[i] !== c[i - 2] || c[i + 1] !== c[i - 1]) continue
      const h1 = Math.atan2(c[i - 1] - c[i - 3], c[i - 2] - c[i - 4])
      const h2 = Math.atan2(c[i + 3] - c[i + 1], c[i + 2] - c[i])
      let d = Math.abs(h2 - h1) * (180 / Math.PI)
      if (d > 180) d = 360 - d
      if (d > 60) out.push([c[i], c[i + 1]])
    }
  }
  return out
}

/** Cells within ~1 mm of the walls' gently curving stretches (turning 1–30° per segment), and their length. */
function curvedWallZone(layer: ParsedLayer, grid: LayerGrid): { cells: Uint8Array; lengthMm: number } {
  const cells = new Uint8Array(grid.w * grid.h)
  let lengthMm = 0
  for (const s of layer.segments) {
    if (s.feature !== "Outer wall" && s.feature !== "Inner wall") continue
    const c = s.coords
    for (let i = 4; i < c.length; i += 4) {
      // consecutive segments of a wall path share a point
      if (c[i] !== c[i - 2] || c[i + 1] !== c[i - 1]) continue
      const h1 = Math.atan2(c[i - 1] - c[i - 3], c[i - 2] - c[i - 4])
      const h2 = Math.atan2(c[i + 3] - c[i + 1], c[i + 2] - c[i])
      let d = Math.abs(h2 - h1) * (180 / Math.PI)
      if (d > 180) d = 360 - d
      if (d < 1 || d > 30) continue
      const len = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])
      lengthMm += len
      const steps = Math.max(1, Math.ceil(len / (CELL / 2)))
      for (let k = 0; k <= steps; k++) {
        const x = c[i] + ((c[i + 2] - c[i]) * k) / steps
        const y = c[i + 1] + ((c[i + 3] - c[i + 1]) * k) / steps
        const cx = Math.floor((x - grid.x0) / CELL)
        const cy = Math.floor((y - grid.y0) / CELL)
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx >= 0 && ny >= 0 && nx < grid.w && ny < grid.h) cells[ny * grid.w + nx] = 1
          }
      }
    }
  }
  return { cells, lengthMm }
}

/** Occupancy grids over the print's bounding box (Uint8Array per layer). */
class LayerGrid {
  readonly x0: number
  readonly y0: number
  readonly w: number
  readonly h: number
  constructor(bbox: [number, number, number, number]) {
    this.x0 = bbox[0] - 2 * CELL
    this.y0 = bbox[1] - 2 * CELL
    this.w = Math.max(1, Math.ceil((bbox[2] - bbox[0]) / CELL) + 5)
    this.h = Math.max(1, Math.ceil((bbox[3] - bbox[1]) / CELL) + 5)
  }
  cellOf(x: number, y: number): number {
    const cx = Math.floor((x - this.x0) / CELL)
    const cy = Math.floor((y - this.y0) / CELL)
    return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h ? cy * this.w + cx : -1
  }
  raster(layer: ParsedLayer, only?: (feature: string) => boolean): Uint8Array {
    const g = new Uint8Array(this.w * this.h)
    for (const s of layer.segments) {
      if (NOT_PART.has(s.feature) || (only && !only(s.feature))) continue
      const c = s.coords
      for (let i = 0; i < c.length; i += 4) {
        const len = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])
        const steps = Math.max(1, Math.ceil(len / (CELL / 2)))
        for (let k = 0; k <= steps; k++) {
          const cx = Math.floor((c[i] + ((c[i + 2] - c[i]) * k) / steps - this.x0) / CELL)
          const cy = Math.floor((c[i + 1] + ((c[i + 3] - c[i + 1]) * k) / steps - this.y0) / CELL)
          if (cx >= 0 && cy >= 0 && cx < this.w && cy < this.h) g[cy * this.w + cx] = 1
        }
      }
    }
    return g
  }
  /** Occupied cells plus everything they enclose (flood-fill the outside from the border). */
  withInterior(g: Uint8Array): Uint8Array {
    const { w, h } = this
    const outside = new Uint8Array(w * h)
    const stack: number[] = []
    const push = (k: number) => {
      if (!outside[k] && !g[k]) {
        outside[k] = 1
        stack.push(k)
      }
    }
    for (let x = 0; x < w; x++) {
      push(x)
      push((h - 1) * w + x)
    }
    for (let y = 0; y < h; y++) {
      push(y * w)
      push(y * w + w - 1)
    }
    while (stack.length) {
      const k = stack.pop()!
      const x = k % w
      if (x > 0) push(k - 1)
      if (x < w - 1) push(k + 1)
      if (k >= w) push(k - w)
      if (k < w * (h - 1)) push(k + w)
    }
    const out = new Uint8Array(w * h)
    for (let k = 0; k < out.length; k++) out[k] = outside[k] ? 0 : 1
    return out
  }
  dilate(g: Uint8Array): Uint8Array {
    const { w, h } = this
    const out = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!g[y * w + x]) continue
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) out[ny * w + nx] = 1
          }
      }
    return out
  }
  blobs(cells: number[]): { cells: number[]; cx: number; cy: number; w: number; h: number }[] {
    const { w } = this
    const left = new Set(cells)
    const out: { cells: number[]; cx: number; cy: number; w: number; h: number }[] = []
    for (const start of cells) {
      if (!left.has(start)) continue
      left.delete(start)
      const stack = [start]
      const blob: number[] = []
      while (stack.length) {
        const k = stack.pop()!
        blob.push(k)
        for (const n of [k - 1, k + 1, k - w, k + w]) {
          if (left.has(n) && Math.abs((n % w) - (k % w)) <= 1) {
            left.delete(n)
            stack.push(n)
          }
        }
      }
      const xs = blob.map((k) => k % w)
      const ys = blob.map((k) => Math.floor(k / w))
      const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      out.push({
        cells: blob,
        cx: this.x0 + ((minX + maxX + 1) / 2) * CELL,
        cy: this.y0 + ((minY + maxY + 1) / 2) * CELL,
        w: (maxX - minX + 1) * CELL,
        h: (maxY - minY + 1) * CELL,
      })
    }
    return out
  }
}

const sum = (o: Record<string, number>, k: string) => o[k] ?? 0
const fmt = (n: number) => (Math.round(n * 10) / 10).toString()

export function analyzeGcode(parsed: ParsedGcode, gcodePath: string, intent: PrintIntent): SlicePreviewSummary {
  const { layers, settings } = parsed
  const issues: GcodeQualityIssue[] = []
  const topLayers = layers.filter((l) => sum(l.length, "Top surface") > 0).map((l) => l.index)
  // Never recommend the intent that's already selected (the E2E dialog said "top isn't ironed: use Display" on a
  // Display slice): with Display on, the cause is the shape or a custom setting.
  const isDisplay = intent === "display"
  const displayFix = isDisplay
    ? "Display is already selected, so this comes from the shape or a custom setting: change the design, or remove the custom setting."
    : "Use Display piece: smoother top, slower edges."
  const ironingType = (settings.ironing_type ?? "").replace(/^"|"$/g, "").trim()
  const ironingOn = ironingType !== "" && ironingType !== "no ironing"

  // 1. Gap infill on visible top layers (fills slivers where top lines meet curved walls: ragged edge).
  const gapTop = topLayers
    .map((i) => ({ i, gap: sum(layers[i].length, "Gap infill"), top: sum(layers[i].length, "Top surface") }))
    // Even a little gap fill on the very top layer shows (13 mm made the apple logo's edge ragged).
    .filter((x) => x.gap > 5)
  if (gapTop.length) {
    const worst = gapTop.reduce((a, b) => (b.gap > a.gap ? b : a))
    issues.push({
      code: "gap_infill_on_top",
      severity: "warn",
      title: "Ragged top edge",
      message: `Gap infill on the top surface (${fmt(worst.gap)} mm of thin squiggles on layer ${worst.i + 1}). It leaves a ragged fringe where the top lines meet the edges.`,
      layers: gapTop.map((x) => x.i),
      where: "along the edges of the top face, mostly where they curve",
      fix: isDisplay
        ? "Display is already selected: the slivers come from the shape. Widen narrow spots of the top face or round tight corners in the design, or print the show face down on the plate."
        : displayFix,
    })
  }

  // 2. Large flat top without ironing.
  const ironed = layers.some((l) => sum(l.length, "Ironing") > 0)
  const topArea = Math.max(0, ...topLayers.map((i) => layers[i].segments.filter((s) => s.feature === "Top surface").reduce((a, s) => a + segLen(s.coords) * s.lineWidth, 0)))
  if (!ironed && topArea > 300) {
    const cm2 = Math.round(topArea / 100)
    issues.push({
      code: "no_ironing_flat_top",
      severity: "warn",
      title: "Top lines will show",
      // Say why in plain words: ironing off (the intent or a custom setting), or on but the slicer made no passes.
      message: ironingOn
        ? `Ironing is turned on, but the slicer didn't iron this top (no ironing passes in the G-code), so the top lines will show on the flat face (about ${cm2} cm²).`
        : isDisplay
          ? `Ironing is turned off for this slice by a custom setting, so the top lines will show on the flat face (about ${cm2} cm²).`
          : `The top is a large flat face (about ${cm2} cm²) and isn't ironed, so the top lines will show.`,
      layers: topLayers.slice(-1),
      where: "the top face",
      fix: ironingOn
        ? "Slice it again. If it still isn't ironed, the top lines will show: accept that, or print the show face down on the plate for the smoothest face."
        : isDisplay
          ? 'Remove the custom "ironing_type" setting to iron the top.'
          : displayFix,
    })
  } else if (!ironed && ironingOn && topArea > 0) {
    // Asked for ironing, got none, on a small top: say so instead of letting "Smooth ironed top" stand.
    issues.push({
      code: "ironing_skipped_small_top",
      severity: "info",
      title: "Top too small to iron",
      message: `Ironing is turned on, but the top is too small to iron (about ${Math.round(topArea)} mm²), so it prints without ironing. On a top this small the lines barely show.`,
      layers: topLayers.slice(-1),
      where: "the top face",
    })
  }

  // 3. Fast visible surfaces (outer walls and top skin), ignoring the first layer.
  let wallMax = 0
  let topMax = 0
  for (const l of layers.slice(1)) {
    wallMax = Math.max(wallMax, l.maxSpeed["Outer wall"] ?? 0)
    topMax = Math.max(topMax, l.maxSpeed["Top surface"] ?? 0)
  }
  if (wallMax > 150 || topMax > 150) {
    issues.push({
      code: "fast_visible_walls",
      severity: "warn",
      title: "Fast outer walls",
      message: `Visible surfaces print fast (outer walls up to ${Math.round(wallMax)} mm/s, top up to ${Math.round(topMax)} mm/s). Edges and corners will be less crisp.`,
      fix: displayFix,
    })
  }

  // 4. Only one wall under the top skin.
  if (settings.only_one_wall_top === "1" && topLayers.length) {
    issues.push({
      code: "single_top_wall",
      severity: "info",
      title: "Thin top edge",
      message: "The top layers use a single wall, so the top edge is a single line and can look thin or uneven.",
      layers: topLayers.slice(-1),
      fix: displayFix,
    })
  }

  // 5. Extrusions in mid-air: cells of a layer that are neither over the previous layer's extrusions nor inside
  // its outline (sparse infill leaves gaps that are still "inside"), with 1 cell (0.5 mm) of overhang allowed.
  // Bridges (Bridge / Internal Bridge) span gaps on purpose: short ones are fine, long ones get their own note.
  // Overhang walls (or gap fill) crossing a short gap with both ends resting on printed areas, e.g. the apple v3 leaf
  // stick's flat underside, print like a bridge: anchored spans up to ~10 mm are fine (print journal), so they're
  // "short bridge" info, not mid-air warnings. A thin sliver held at both ends (a round underside: v1's stem, one
  // loop wide) still droops, so it stays a mid-air warning with the flat-underside fix.
  const midAir: { layer: number; x: number; y: number; size: number; sliver?: boolean }[] = []
  const shortBridges: { layer: number; span: number; x: number; y: number }[] = []
  const longBridges: { layer: number; span: number }[] = []
  const grid = new LayerGrid(parsed.bbox)
  let below = layers.length ? grid.dilate(grid.withInterior(grid.raster(layers[0]))) : null
  for (let i = 1; i < layers.length && below; i++) {
    const here = grid.raster(layers[i])
    const bridges = grid.raster(layers[i], (f) => BRIDGES.has(f))
    const nearBridge = grid.dilate(grid.dilate(bridges)) // walls along a bridge's edges ride on it
    const unsupported: number[] = []
    for (let k = 0; k < here.length; k++) if (here[k] && !below[k]) unsupported.push(k)
    for (const b of grid.blobs(unsupported)) {
      if (b.cells.length < 3) continue
      const bridgeShare = b.cells.filter((k) => bridges[k]).length / b.cells.length
      if (bridgeShare > 0.6) {
        const span = Math.min(b.w, b.h)
        if (span > 10) longBridges.push({ layer: i, span })
        continue
      }
      if (b.cells.filter((k) => nearBridge[k]).length / b.cells.length > 0.5) continue // the edge of a bridge
      const span = anchoredSpan(grid, b.cells, below)
      const anchored = span !== null && span <= SHORT_BRIDGE_MM
      if (anchored && bandWidth(layers[i], grid, b.cells) >= MIN_BRIDGE_BAND_MM) {
        shortBridges.push({ layer: i, span, x: b.cx, y: b.cy })
        continue
      }
      midAir.push({ layer: i, x: b.cx, y: b.cy, size: b.cells.length, ...(anchored ? { sliver: true } : {}) })
    }
    below = grid.dilate(grid.withInterior(here))
  }
  if (midAir.length) {
    const first = midAir[0]
    issues.push({
      code: "starts_mid_air",
      severity: "warn",
      title: "Starts in mid-air",
      message: `Something starts in mid-air on layer ${first.layer + 1} (z ${fmt(layers[first.layer].z)} mm, around x ${fmt(first.x)}, y ${fmt(first.y)}): it has nothing under it and will droop or string.`,
      layers: [...new Set(midAir.map((m) => m.layer))].slice(0, 20),
      where: `around x ${fmt(first.x)}, y ${fmt(first.y)} mm on the bed`,
      fix: first.sliver
        ? "It's held at both ends but starts as a thin sliver (a round underside), which droops. Give it a flat underside at least 1.5 mm wide so it bridges, or add supports."
        : "Change the design so it grows from something below (flat bottom, 45° chamfer under it, or split the part), or add supports.",
    })
  }
  if (shortBridges.length) {
    const first = shortBridges[0]
    const widest = Math.max(...shortBridges.map((s) => s.span))
    issues.push({
      code: "short_bridge",
      severity: "info",
      title: "Short bridge",
      message: `A short bridge on layer ${first.layer + 1} (z ${fmt(layers[first.layer].z)} mm, around x ${fmt(first.x)}, y ${fmt(first.y)}): it crosses a ${fmt(Math.max(widest, CELL))} mm gap with both ends resting on the part, so it prints like a bridge (spans up to about ${SHORT_BRIDGE_MM} mm do).`,
      layers: [...new Set(shortBridges.map((m) => m.layer))].slice(0, 10),
      where: `around x ${fmt(first.x)}, y ${fmt(first.y)} mm on the bed`,
      fix: "Usually fine. A flat underside on the part that crosses the gap keeps the bridge clean.",
    })
  }
  if (longBridges.length) {
    const worst = longBridges.reduce((a, b) => (b.span > a.span ? b : a))
    issues.push({
      code: "long_bridge",
      severity: "info",
      title: "Long bridge",
      message: `A ${Math.round(worst.span)} mm bridge on layer ${worst.layer + 1} (z ${fmt(layers[worst.layer].z)} mm): it may sag a little underneath.`,
      layers: [...new Set(longBridges.map((m) => m.layer))].slice(0, 10),
      fix: "Usually fine. For a cleaner underside, shorten the span or add a chamfer/arch in the design.",
    })
  }

  // 7. Straight top lines ending against curved walls: every line end leaves a tiny blob/gap, and along a curve
  // they form a sawtooth band just inside the edge (ironing at 10% flow doesn't hide it). Concentric top lines
  // follow the outline instead.
  const lastTop = topLayers.length ? layers[topLayers[topLayers.length - 1]] : null
  if (lastTop) {
    const ends = topLineEnds(lastTop)
    const curved = curvedWallZone(lastTop, grid)
    const onCurve = ends.filter(([x, y]) => curved.cells[grid.cellOf(x, y)]).length
    const perMm = curved.lengthMm > 0 ? onCurve / curved.lengthMm : 0
    if (curved.lengthMm > 20 && onCurve > 20 && perMm > 0.3) {
      issues.push({
        code: "top_lines_hit_curves",
        severity: "warn",
        title: "Rough band near curved edge",
        message: `The top surface's straight lines end against the curved edge ${onCurve} times (${fmt(perMm)} per mm of curve on layer ${lastTop.index + 1}). That leaves a rough, sawtooth band just inside the edge.`,
        layers: [lastTop.index],
        where: "a 1–2 mm band inside the curved edges of the top face",
        fix: "Use concentric top lines (Display piece picks them for curved outlines), or print the face down.",
      })
    }
  }

  // 7b. The same on the plate side (Display only, where that face can be the show face): straight first-layer lines
  // ending against a curved wall left a thin groove ~1 mm inside the edge (1-inch apple F, face down); concentric
  // bottom lines (H) didn't. One straight-lined 1-inch apple: ~75 turns along ~250 mm of curved wall (0.3/mm); the
  // concentric one: a handful.
  if (isDisplay && layers.length) {
    const ends = [...topLineEnds(layers[0], "Bottom surface"), ...lineTurns(layers[0], "Bottom surface")]
    const curved = curvedWallZone(layers[0], grid)
    const onCurve = ends.filter(([x, y]) => curved.cells[grid.cellOf(x, y)]).length
    const perMm = curved.lengthMm > 0 ? onCurve / curved.lengthMm : 0
    if (curved.lengthMm > 20 && onCurve > 20 && perMm > 0.1) {
      issues.push({
        code: "bottom_lines_hit_curves",
        severity: "info",
        title: "Groove near curved edge (plate side)",
        message: `The first layer's straight lines end against the curved edge ${onCurve} times (${fmt(perMm)} per mm of curve). On the plate side that can leave a thin groove just inside the edge.`,
        layers: [0],
        where: "about 1 mm inside the curved edges of the face on the plate",
        fix: "Use concentric bottom lines (Display piece picks them for curved outlines).",
      })
    }
  }

  // 8 + 9. Flat decorative top: a sharp 90° top edge (outline unchanged over the last ~1 mm) and the plate side
  // would be the cleanest face.
  if (lastTop && lastTop.index === layers.length - 1 && topArea > 300) {
    const below = layers[Math.max(0, lastTop.index - Math.max(1, Math.round(1 / (lastTop.height || 0.2))))]
    const a = grid.raster(lastTop, (f) => f === "Outer wall")
    const b = grid.raster(below, (f) => f === "Outer wall")
    const da = grid.dilate(a)
    const db = grid.dilate(b)
    let inBoth = 0
    let total = 0
    for (let k = 0; k < a.length; k++) {
      if (a[k]) {
        total++
        if (db[k]) inBoth++
      }
      if (b[k] && !da[k]) total++
    }
    // A flat piece: one top face, and much thinner than it is wide.
    const [bx0, by0, bx1, by1] = parsed.bbox
    const flatTopOnly = topLayers.length <= 2 && lastTop.z <= 0.3 * Math.min(bx1 - bx0, by1 - by0)
    if (total && inBoth / total > 0.9) {
      issues.push({
        code: "no_edge_chamfer_display",
        severity: "info",
        title: "Sharp top edge",
        message: "The top face meets the sides at a sharp 90° edge, which shows every layer line and top-line end right at the edge.",
        layers: [lastTop.index],
        where: "the top edge all the way round",
        fix: "Add a small chamfer or rounded edge (0.6–1 mm) to the top edge in the design.",
      })
    }
    const firstArea = layers[0].segments.filter((x) => !NOT_PART.has(x.feature)).reduce((acc, x) => acc + segLen(x.coords) * x.lineWidth, 0)
    if (flatTopOnly && firstArea > 0.6 * topArea) {
      issues.push({
        code: "show_face_down",
        severity: "info",
        title: "Best face is on the plate",
        message: "This is a flat display piece: the side on the build plate comes out the smoothest (it takes the plate's finish).",
        fix: "To show off the front, print it face-down: mirror the design and flip it so the display face is on the plate.",
      })
    }
  }

  // 6. Stringing risk: many travels over empty space without retracting, or short retraction at high temperature.
  let openTravels = 0
  let gapTravels = 0
  for (const l of layers.slice(1)) {
    const occ = occupancy(l)
    for (const t of l.travels) {
      const len = Math.hypot(t.x2 - t.x1, t.y2 - t.y1)
      if (len < 2) continue
      const mx = (t.x1 + t.x2) / 2
      const my = (t.y1 + t.y2) / 2
      if (occ.has(key(Math.floor(mx / CELL), Math.floor(my / CELL)))) continue
      gapTravels++
      if (!t.retracted) openTravels++
    }
  }
  const retract = Number(settings.retraction_length?.split(",")[0]) || 0
  const temp = Number(settings.nozzle_temperature?.split(",")[0]) || 0
  if (openTravels > 10 || (gapTravels > 40 && retract > 0 && retract < 1 && temp >= 215)) {
    issues.push({
      code: "stringing_risk",
      severity: "info",
      title: "Some strings likely",
      message: `${gapTravels} moves cross empty space${openTravels ? ` (${openTravels} without retracting)` : ""} with ${retract || "?"} mm retraction at ${temp || "?"} °C: expect some fine strings between separate areas.`,
      fix: "Usually cosmetic (a heat gun or brush removes it). Fewer separate islands in the design, or drier filament, helps.",
    })
  }

  return {
    gcodePath,
    intent,
    layerCount: layers.length,
    firstLayer: 0,
    topLayers,
    issues,
  }
}

const SHORT_BRIDGE_MM = 10
const MIN_BRIDGE_BAND_MM = 1.5 // apple v3 flat underside: ~2 mm band (2 loops); v1 round stem: ~1 mm (1 loop)

/** Width (mm) of the band a layer extrudes inside a blob: extruded area / length-weighted mean line length. */
function bandWidth(layer: ParsedLayer, grid: LayerGrid, blob: number[]): number {
  const cells = new Set(blob)
  let area = 0
  let len1 = 0
  let len2 = 0
  for (const s of layer.segments) {
    if (NOT_PART.has(s.feature)) continue
    const c = s.coords
    for (let i = 0; i < c.length; i += 4) {
      const len = Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])
      if (!len) continue
      const steps = Math.max(1, Math.ceil(len / (CELL / 2)))
      let hits = 0
      for (let k = 0; k <= steps; k++) if (cells.has(grid.cellOf(c[i] + ((c[i + 2] - c[i]) * k) / steps, c[i + 1] + ((c[i + 3] - c[i + 1]) * k) / steps))) hits++
      if (hits * 2 < steps + 1) continue
      area += len * s.lineWidth
      len1 += len
      len2 += len * len
    }
  }
  return len2 > 0 ? area / (len2 / len1) : 0
}

/**
 * If an unsupported blob rests on supported cells at two separate places (its ends), the gap between those anchors in
 * mm; null when it hangs from one side only (a cantilever) or from nothing. Anchors = supported cells within ~1 mm of
 * the blob, grouped by touch; the two biggest groups must be apart (not one strip along an edge).
 */
function anchoredSpan(grid: LayerGrid, blob: number[], supported: Uint8Array): number | null {
  const { w, h } = grid
  const inBlob = new Set(blob)
  const anchors = new Set<number>()
  for (const k of blob) {
    const x = k % w
    const y = Math.floor(k / w)
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = ny * w + nx
        if (supported[n] && !inBlob.has(n)) anchors.add(n)
      }
  }
  if (!anchors.size) return null
  const groups = grid.blobs([...anchors]).sort((a, b) => b.cells.length - a.cells.length)
  if (groups.length < 2 || groups[1].cells.length < 2) return null
  // Closest distance between the two biggest anchor groups = the span the blob crosses.
  let best = Infinity
  for (const a of groups[0].cells)
    for (const b of groups[1].cells) {
      const d = Math.hypot((a % w) - (b % w), Math.floor(a / w) - Math.floor(b / w))
      if (d < best) best = d
    }
  // Two anchor groups that nearly touch are one support seen through a notch, not two ends.
  if (best < 2) return null
  return best * CELL
}

function segLen(c: number[]) {
  let s = 0
  for (let i = 0; i < c.length; i += 4) s += Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])
  return s
}
