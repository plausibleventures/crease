import { useStudio } from "@/stores/studio"
import { api } from "@/lib/api"
import { SyncChannel, SyncCursor } from "@/lib/sync"

let started = false

const DEAD_AFTER_MS = 40_000 // the server pings every 15 s; silence this long = dead socket
const TICK_MS = 5_000
const SLEPT_MS = 20_000 // a tick this late means the machine slept (timers don't run while suspended)

/**
 * Single app-wide WebSocket to /ws with jittered exponential-backoff reconnect and R08 resume (see lib/sync.ts):
 * reconnects send the last applied eventSeq; the server replays what was missed or asks for a snapshot (always after
 * a server restart: new instanceId). Sleep/wake and silent socket death are detected from the server's ping frames
 * and timer drift, and force an immediate reconnect.
 */
export function startEventSocket() {
  if (started) return
  started = true
  let attempt = 0
  let current: WebSocket | null = null
  let lastHeard = Date.now()
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const channel = new SyncChannel(new SyncCursor(), {
    apply: (events) => {
      const st = useStudio.getState()
      for (const ev of events) st.handleEvent(ev)
    },
    applySnapshot: (snap) => useStudio.getState().applySnapshot(snap),
    fetchSnapshot: () => api.syncSnapshot(useStudio.getState().project?.id ?? null),
    reconnect: () => {
      if (current) drop(current, true)
    },
  })

  const connect = () => {
    retryTimer = null
    const proto = window.location.protocol === "https:" ? "wss" : "ws"
    const q = channel.attach()
    let ws: WebSocket
    try {
      ws = new WebSocket(`${proto}://${window.location.host}/ws${q ? `?${q}` : ""}`)
    } catch {
      channel.detach()
      schedule()
      return
    }
    current = ws
    lastHeard = Date.now()
    useStudio.getState().setWsStatus("connecting")

    ws.onopen = () => {
      if (ws !== current) return
      attempt = 0
      lastHeard = Date.now()
      useStudio.getState().setWsStatus("open")
    }
    ws.onmessage = (msg) => {
      if (ws !== current) return
      lastHeard = Date.now()
      let frame: unknown
      try {
        frame = JSON.parse(typeof msg.data === "string" ? msg.data : "")
      } catch {
        return
      }
      channel.receive(frame)
    }
    ws.onclose = () => drop(ws, false)
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  /** Forget a socket now (a dead TCP socket's close event can take minutes) and reconnect. */
  const drop = (ws: WebSocket, immediate: boolean) => {
    if (ws !== current) return
    current = null
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    channel.detach()
    useStudio.getState().setWsStatus("closed")
    if (immediate) attempt = 0
    schedule(immediate ? 0 : undefined)
  }

  const schedule = (delay?: number) => {
    if (retryTimer) clearTimeout(retryTimer)
    const base = Math.min(10_000, 500 * 2 ** attempt)
    attempt++
    retryTimer = setTimeout(connect, delay ?? Math.round(base * (0.75 + Math.random() * 0.5)))
  }

  /** Wake / network back / tab visible: reconnect now instead of waiting out the backoff. */
  const nudge = () => {
    if (current) {
      if (current.readyState === WebSocket.OPEN && Date.now() - lastHeard > DEAD_AFTER_MS) drop(current, true)
      return
    }
    attempt = 0
    schedule(0)
  }

  let lastTick = Date.now()
  setInterval(() => {
    const now = Date.now()
    // background tabs throttle timers to ~1/min, so only a visible page reads a late tick as sleep
    const slept = now - lastTick > SLEPT_MS && document.visibilityState === "visible"
    lastTick = now
    if (slept && current) drop(current, true) // the socket may be dead and the server may have restarted meanwhile
    else if (current?.readyState === WebSocket.OPEN && now - lastHeard > DEAD_AFTER_MS) drop(current, true)
    else if (slept) nudge()
  }, TICK_MS)
  window.addEventListener("online", nudge)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") nudge()
  })

  connect()
}
