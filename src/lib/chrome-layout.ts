// The workspace's floating chrome: how wide the parts list and the chat are for a window, and how much of the stage
// they cover. The stage spans the window under them (src/glass.css .ps-bleed); viewers centre the part in the gap.

/** Fixed chrome heights (px): the status line, the dock that holds the view switcher, the header pill. */
export const STATUS = 24
export const DOCK = 52
export const HEADER = 44
/** The narrowest gap the part keeps between the panels, however wide they are dragged. */
export const MIN_GAP = 380

export type PanelWidths = { sidebar?: number; chat?: number }
export type ChromeLayout = { sidebar: number; chat: number; tools: number; compact: boolean; l: number; r: number; t: number; b: number }

export const SIDEBAR_RANGE: [number, number] = [180, 360]
export const CHAT_RANGE: [number, number] = [280, 560]

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v))

/** Default widths for a window: the parts list and chat give up width first on narrow windows. */
export function defaultWidths(width: number): Required<PanelWidths> {
  return {
    sidebar: width >= 1400 ? 248 : width >= 1200 ? 228 : 208,
    chat: width >= 1400 ? 380 : width >= 1200 ? 348 : 316,
  }
}

/**
 * The chrome for a window size (px) and the widths the user dragged to (if any). Panels never squeeze the part's gap
 * below MIN_GAP: the chat gives way first, then the parts list. `compact` (a narrow gap) drops the labels of the
 * bottom controls to icons. l/r/t/b: how much of each edge the chrome covers (tools excluded).
 */
export function chromeLayout(width: number, height: number, want: PanelWidths = {}): ChromeLayout {
  const d = defaultWidths(width)
  let sidebar = clamp(want.sidebar ?? d.sidebar, SIDEBAR_RANGE)
  let chat = clamp(want.chat ?? d.chat, CHAT_RANGE)
  const room = width - 32 - MIN_GAP // what both panels may take
  if (sidebar + chat > room) {
    chat = Math.max(CHAT_RANGE[0], room - sidebar)
    sidebar = Math.max(SIDEBAR_RANGE[0], room - chat)
  }
  const gap = width - 32 - sidebar - chat
  const tools = Math.round(Math.min(300, Math.max(200, height * 0.36)))
  return { sidebar, chat, tools, compact: gap < 640, l: 8 + sidebar + 8, r: 8 + chat + 8, t: 8 + HEADER + 8, b: STATUS + 8 + DOCK }
}

export function stageInsetsFor(layout: ChromeLayout, toolsOpen: boolean) {
  return { l: layout.l, r: layout.r, t: layout.t, b: layout.b + (toolsOpen ? layout.tools + 8 : 0) }
}

const KEY = "ps-ws-widths"

export function readWidths(): PanelWidths {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as PanelWidths
    return {
      ...(typeof v.sidebar === "number" ? { sidebar: v.sidebar } : {}),
      ...(typeof v.chat === "number" ? { chat: v.chat } : {}),
    }
  } catch {
    return {}
  }
}

export function writeWidths(w: PanelWidths) {
  try {
    if (w.sidebar === undefined && w.chat === undefined) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(w))
  } catch {
    /* not remembered */
  }
}
