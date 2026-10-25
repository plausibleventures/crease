// Colours for what the user's work sits on (3D viewer plate, layer canvas) where CSS tokens can't reach: WebGL
// materials and 2D canvas strokes. `bg` matches the --stage token in src/index.css.
import { useResolvedTheme } from "@/components/theme-provider"

export interface StagePalette {
  bg: string
  /** build plate slab, its 10 mm and 50 mm grid, the printable-area dash and the hairline frame */
  plate: string
  gridMinor: string
  gridMajor: string
  margin: string
  edge: string
  /** text drawn on the plate / canvas ("front of printer", plate size) */
  label: string
  /** layer canvas: 10 mm grid and the previous layer's ghost */
  canvasGrid: string
  ghost: string
  footprint: string
  /** object badges on the layer canvas */
  badgeBg: string
  badgeLine: string
  badgeText: string
  letterBg: string
  letterText: string
}

const DARK: StagePalette = {
  bg: "#141210", // = --stage
  // the bed: two steps above the stage, so the slab reads, pale parts still stand off it and black parts (drawn near
  // true black, see darkLook) show their outline against it
  plate: "#34302d",
  gridMinor: "#403b37",
  gridMajor: "#57524d",
  margin: "#6b655f",
  edge: "#a8a29e",
  label: "rgba(168, 162, 158, 0.9)",
  canvasGrid: "#25211f",
  ghost: "#34302d",
  footprint: "rgba(168, 162, 158, 0.55)",
  badgeBg: "rgba(28, 25, 23, 0.88)",
  badgeLine: "#44403c",
  badgeText: "#f5f5f4",
  letterBg: "#f5f5f4",
  letterText: "#0c0a09",
}

const LIGHT: StagePalette = {
  bg: "#e7e5e4", // = --stage
  plate: "#a8a29e", // a darker stone sheet (lit, it reads lighter) so white and pale parts stand off it
  gridMinor: "#97918b",
  gridMajor: "#7d7671",
  margin: "#625c57",
  edge: "#57534e", // 6:1 on the stage
  label: "rgba(68, 64, 60, 0.95)",
  canvasGrid: "#dedbd8",
  ghost: "#d6d3d1",
  footprint: "rgba(87, 83, 78, 0.6)",
  badgeBg: "rgba(255,255,255,0.92)",
  badgeLine: "#c9c5c1",
  badgeText: "#1c1917",
  letterBg: "#1c1917",
  letterText: "#fafaf9",
}

export function useStagePalette(): StagePalette {
  return useResolvedTheme() === "light" ? LIGHT : DARK
}
