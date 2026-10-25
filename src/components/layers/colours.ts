// Toolpath feature colours (2D layer canvas and 3D toolpath view share them, so the legend means one thing).
/** Feature colours from the spool palette: walls blue (outer bright), top mint, ironing lime, problems coral/magenta. */
export const FEATURE_COLOURS: Record<string, string> = {
  "Outer wall": "#6f8dff",
  "Inner wall": "#3f4f99",
  "Overhang wall": "#ff5c7a",
  "Sparse infill": "#8a7630",
  "Internal solid infill": "#9a4f8f",
  "Top surface": "#3fe0b0",
  "Bottom surface": "#23806a",
  Bridge: "#ffd23f",
  "Gap infill": "#ff4fd8",
  Ironing: "#b6f23f",
  Skirt: "#66665f",
  Brim: "#8a8a85",
  Support: "#4d4d48",
  "Support interface": "#a3a3a0",
  "Prime tower": "#55554f",
  Custom: "#55554f",
}
/** The same features on the light stage: darker tones for the bright ones, lighter for the dim ones (same ranking). */
export const FEATURE_COLOURS_LIGHT: Record<string, string> = {
  "Outer wall": "#3355e6",
  "Inner wall": "#93a4ee",
  "Overhang wall": "#d0304e",
  "Sparse infill": "#c2a64e",
  "Internal solid infill": "#bf78b3",
  "Top surface": "#0b9a74",
  "Bottom surface": "#74c4ac",
  Bridge: "#c79500",
  "Gap infill": "#cc2aab",
  Ironing: "#5f8f00",
  Skirt: "#a6a69f",
  Brim: "#8a8a85",
  Support: "#b8b8b1",
  "Support interface": "#77776f",
  "Prime tower": "#a9a9a2",
  Custom: "#a9a9a2",
}
export const colourOf = (f: string, light = false) => (light ? FEATURE_COLOURS_LIGHT : FEATURE_COLOURS)[f] ?? (light ? "#94948c" : "#77776f")
export const LEGEND_ORDER = Object.keys(FEATURE_COLOURS)

/** Plain words for the slicer's feature names in the legend (COPY-02); the slicer's own name is on hover. */
const PLAIN_FEATURE: Record<string, string> = {
  "Outer wall": "Outside wall",
  "Inner wall": "Inside walls",
  "Overhang wall": "Overhang",
  "Sparse infill": "Inside fill",
  "Internal solid infill": "Solid inside",
  "Top surface": "Top",
  "Bottom surface": "Bottom",
  Bridge: "Bridges",
  "Internal bridge": "Bridges inside",
  "Gap infill": "Thin gaps",
  Ironing: "Smoothing",
  "Support interface": "Support top",
  "Prime tower": "Purge tower",
  Custom: "Printer moves",
}
export const plainFeature = (f: string) => PLAIN_FEATURE[f] ?? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()
