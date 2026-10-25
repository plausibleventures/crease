// Original line-art for empty states and glyphs. One stroke width per drawing (set by the direction via
// --sb-art-stroke), round caps, currentColor for line-work and var(--sb-accent) for the "live" element.
import type { SVGProps } from "react"

const art = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  style: { strokeWidth: "var(--sb-art-stroke, 1.5)" },
}

/** A hot end laying down the first layer: the nozzle draws a path onto an empty plate. */
export function NozzleDrawing(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 240 160" aria-hidden {...props}>
      {/* plate in perspective */}
      <path {...art} d="M30 128 L130 150 L218 120 L118 100 Z" opacity="0.55" />
      <path {...art} d="M30 128 L30 133 L130 155 L218 125 L218 120" opacity="0.35" />
      {/* plate grid */}
      {[0.25, 0.5, 0.75].map((t) => (
        <path key={t} {...art} opacity="0.18" d={`M${30 + 88 * t} ${128 - 28 * t} L${130 + 88 * t} ${150 - 30 * t}`} />
      ))}
      {/* the printed path (accent), drawn by the nozzle */}
      <path
        className="sb-draw"
        {...art}
        stroke="var(--sb-accent)"
        style={{ strokeWidth: "calc(var(--sb-art-stroke, 1.5) * 1.6)" }}
        d="M72 124 L102 130.5 L132 124 L102 117.5 L80 113 L110 106.5 L140 113 L118 118"
      />
      {/* hot end: heater block, heat break, nozzle */}
      <path {...art} d="M104 34 h28 v26 h-28 z" />
      <path {...art} d="M110 22 h16 v12 h-16 z" />
      <path {...art} d="M113 8 v14 M123 8 v14" opacity="0.6" />
      <path {...art} d="M112 60 h12 l-3 14 h-6 z" />
      <path {...art} d="M116.5 74 l1.5 4 l1.5 -4" stroke="var(--sb-accent)" />
      {/* heat shimmer */}
      <path {...art} opacity="0.4" d="M96 44 q-4 -4 0 -8 q4 -4 0 -8 M140 44 q4 -4 0 -8 q-4 -4 0 -8" />
      {/* filament strand from above */}
      <path {...art} opacity="0.5" d="M118 8 C118 0 150 -6 176 8" />
    </svg>
  )
}

/** A spool, seen from the side, with the strand running off. */
export function Spool(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 160 160" aria-hidden {...props}>
      <circle {...art} cx="70" cy="80" r="56" />
      <circle {...art} cx="70" cy="80" r="44" opacity="0.4" />
      <circle {...art} cx="70" cy="80" r="38" stroke="var(--sb-accent)" style={{ strokeWidth: "calc(var(--sb-art-stroke, 1.5) * 4)" }} opacity="0.85" />
      <circle {...art} cx="70" cy="80" r="16" />
      <circle {...art} cx="70" cy="80" r="7" opacity="0.5" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <circle key={a} {...art} r="3.5" opacity="0.45" cx={70 + 28 * Math.cos((a * Math.PI) / 180)} cy={80 + 28 * Math.sin((a * Math.PI) / 180)} />
      ))}
      <path {...art} stroke="var(--sb-accent)" d="M108 62 C126 54 138 64 150 46" />
    </svg>
  )
}

/** A small printer: frame, gantry, a part on the bed. */
export function LittlePrinter(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 160 160" aria-hidden {...props}>
      <path {...art} d="M28 136 V30 h104 v106" />
      <path {...art} d="M20 136 h120" />
      <path {...art} d="M36 60 h88" opacity="0.6" />
      <path {...art} d="M70 54 h20 v14 h-20 z" />
      <path {...art} d="M78 68 h4 l-1 6 h-2 z" />
      <path {...art} d="M40 112 h80" />
      <path {...art} stroke="var(--sb-accent)" d="M66 112 v-18 h28 v18" />
      <path {...art} stroke="var(--sb-accent)" opacity="0.5" d="M66 100 h28 M66 106 h28" />
    </svg>
  )
}

/* ---------- small custom glyphs (16 px grid) for things icon sets don't have ---------- */

const g = { ...art, style: { strokeWidth: "var(--sb-glyph-stroke, 1.5)" } }

export function GlyphNozzle(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <path {...g} d="M5 2h6v5H5zM6.5 7h3l-1 4h-1zM8 11v3" />
    </svg>
  )
}
export function GlyphSpool(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <circle {...g} cx="8" cy="8" r="6" />
      <circle {...g} cx="8" cy="8" r="2" />
      <path {...g} d="M13 4.5 15 3" />
    </svg>
  )
}
export function GlyphLayers(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <path {...g} d="M2 12h12M3 9.5h10M4 7h8M5 4.5h6" />
    </svg>
  )
}
export function GlyphCaliper(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <path {...g} d="M2 3h12M3 3v8l2 2M7 3v6M11 3v1M13 3v1" />
    </svg>
  )
}
export function GlyphHinge(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <path {...g} d="M2 12h6M8 12 13 4" />
      <circle {...g} cx="8" cy="12" r="1.6" />
      <path {...g} d="M10.5 12a4 4 0 0 0-.6-2.3" opacity="0.6" />
    </svg>
  )
}
export function GlyphPlate(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden {...p}>
      <path {...g} d="M1.5 11 8 13.5 14.5 11 8 8.5z" />
      <path {...g} d="M6 10.5V7.5h4v3" />
    </svg>
  )
}

/** Two parts pulled apart along a dashed guide: an assembly waiting to be described. */
export function PartsExploded(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 140" aria-hidden {...props}>
      {/* base box (isometric-ish) */}
      <path {...art} d="M40 92 L100 118 L160 92 L100 66 Z" />
      <path {...art} d="M40 92 V108 L100 134 L160 108 V92" />
      <path {...art} d="M100 118 V134" opacity="0.5" />
      {/* lid lifted, in the accent */}
      <path {...art} stroke="var(--sb-accent)" d="M40 46 L100 72 L160 46 L100 20 Z" />
      <path {...art} stroke="var(--sb-accent)" d="M40 46 V52 L100 78 L160 52 V46" />
      {/* guide lines */}
      <path {...art} opacity="0.45" strokeDasharray="3 4" d="M40 58 V88 M160 58 V88 M100 84 V112" />
      {/* hinge pin */}
      <path {...art} opacity="0.7" d="M150 40 l20 -9" />
    </svg>
  )
}

/** A speech bubble with a blinking cursor beside a nozzle: the designer is waiting for you. */
export function ChatNozzle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 140" aria-hidden {...props}>
      <path {...art} d="M24 26 h112 v58 h-62 l-20 18 v-18 h-30 z" />
      <path {...art} opacity="0.55" d="M40 46 h56 M40 62 h36" />
      <rect x="82" y="56" width="7" height="12" fill="var(--sb-accent)" className="ps-blink-svg" />
      {/* nozzle */}
      <path {...art} d="M150 54 h24 v20 h-24 z M156 74 h12 l-3 12 h-6 z" />
      <path {...art} stroke="var(--sb-accent)" d="M158 104 h30 M162 112 h26" />
      <path {...art} opacity="0.4" d="M162 40 v14 M170 40 v14" />
    </svg>
  )
}
