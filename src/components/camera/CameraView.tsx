import { useEffect, useRef, useState, type ReactNode } from "react"
import { CameraIcon, CameraOffIcon, Loader2Icon, RefreshCwIcon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { connectCamera, registerVideo } from "@/lib/camera"
import { fmtDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { MachineWithStatus } from "@shared/types"

/** True while the element is on screen and the window isn't hidden (streams pause otherwise). */
function useVisible(ref: React.RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState === "visible")
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.01 })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  useEffect(() => {
    const on = () => setPageVisible(document.visibilityState === "visible")
    document.addEventListener("visibilitychange", on)
    return () => document.removeEventListener("visibilitychange", on)
  }, [])
  return inView && pageVisible
}

type CamState = "idle" | "connecting" | "live" | "error"

/**
 * Live printer camera. Creality WebRTC cameras stream video (connected only while visible); other cameras fall
 * back to snapshot frames. `overlay` is drawn on top (e.g. layer / time left).
 */
export function CameraView({ machine, className, overlay, fit = "cover" }: { machine: MachineWithStatus; className?: string; overlay?: ReactNode; fit?: "cover" | "contain" }) {
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const visible = useVisible(box)
  const webrtc = machine.camera?.type === "creality-webrtc"
  const connected = !!machine.status?.connected
  const [attempt, setAttempt] = useState(0)
  // Outcome of the current session only: a new session (retry, became visible, ...) starts as "connecting".
  const session = `${machine.id}:${attempt}:${visible}:${connected}`
  const [result, setResult] = useState<{ session: string; state: CamState; error: string | null }>({ session: "", state: "idle", error: null })
  const [via, setVia] = useState<{ session: string; via: "local" | "stun"; label: string } | null>(null)
  const state: CamState = result.session === session ? result.state : "connecting"
  const error = result.session === session ? result.error : null

  useEffect(() => {
    if (!webrtc || !visible || !connected) return
    const v = video.current
    let pc: RTCPeerConnection | null = null
    let cancelled = false
    let unregister = () => {}
    const fail = (msg: string) => !cancelled && setResult({ session, state: "error", error: msg })
    connectCamera(machine, (stream) => {
      if (!v || cancelled) return
      v.srcObject = stream
      void v.play().catch(() => {})
      unregister()
      unregister = registerVideo(machine.id, v)
    })
      .then(({ pc: p, via, label }) => {
        if (cancelled) return p.close()
        pc = p
        setVia({ session, via, label })
        p.onconnectionstatechange = () => {
          if (p.connectionState === "failed" || p.connectionState === "disconnected") fail("The camera stream dropped.")
        }
      })
      .catch((e: Error) => fail(e.message))
    return () => {
      cancelled = true
      unregister()
      pc?.close()
      if (v) v.srcObject = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `machine` changes every poll; the session key covers what matters
  }, [webrtc, visible, connected, machine.id, session])

  return (
    <div ref={box} className={cn("relative overflow-hidden bg-black", className)}>
      {webrtc ? (
        <video
          ref={video}
          muted
          playsInline
          autoPlay
          className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain", state !== "live" && "opacity-0")}
          onPlaying={() => setResult({ session, state: "live", error: null })}
        />
      ) : (
        <SnapshotFrames machine={machine} visible={visible} fit={fit} />
      )}
      {webrtc && state !== "live" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-caption text-muted-foreground">
          {!connected ? (
            <>
              <CameraOffIcon className="size-5" /> Offline
            </>
          ) : state === "error" ? (
            <>
              <CameraOffIcon className="size-5 text-err" />
              <span className="max-w-56 text-center">{error ?? "Camera unavailable"}</span>
              <Button size="xs" variant="outline" onClick={() => setAttempt((a) => a + 1)}>
                <RefreshCwIcon /> Retry
              </Button>
            </>
          ) : (
            <>
              <Loader2Icon className="size-5 animate-spin" /> connecting to camera…
            </>
          )}
        </div>
      )}
      {webrtc && state === "live" && (
        <span
          className={cn("absolute top-1.5 left-1.5 size-1.5 animate-pulse rounded-full", via?.session === session && via.via === "stun" ? "bg-warn" : "bg-err")}
          title={`live · ${via?.session === session ? via.label : "connecting"}`}
        />
      )}
      {overlay}
    </div>
  )
}

/** Snapshot polling for Moonraker / mjpeg cameras (every 5 s while visible). */
function SnapshotFrames({ machine, visible, fit }: { machine: MachineWithStatus; visible: boolean; fit: "cover" | "contain" }) {
  const [t, setT] = useState(() => Date.now())
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!visible) return
    const i = setInterval(() => setT(Date.now()), 5000)
    return () => clearInterval(i)
  }, [visible])
  if (!machine.status?.connected || failed || machine.camera?.type === "none")
    return (
      <div className="flex size-full items-center justify-center text-muted-foreground">
        <CameraOffIcon className="size-5" />
      </div>
    )
  return (
    <img
      src={`/api/machines/${encodeURIComponent(machine.id)}/snapshot?t=${t}`}
      alt={`${machine.name} camera`}
      className={cn("size-full", fit === "cover" ? "object-cover" : "object-contain")}
      onError={() => setFailed(true)}
    />
  )
}

/** Layer, time left, temps and phase over the video, in the terminal style. */
export function PrintOverlay({ machine }: { machine: MachineWithStatus }) {
  const st = machine.status
  if (!st?.connected) return null
  const pct = Math.round((st.progress ?? 0) * 100)
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-0.5 bg-black/70 px-2.5 py-1.5 text-caption text-foreground">
      <span className={cn(st.state === "printing" || st.state === "preparing" ? "text-primary" : "text-muted-foreground")}>{st.state}</span>
      {st.state === "preparing" && st.phase && <span>{st.phase}</span>}
      {st.layer != null && (
        <span>
          layer {st.layer}
          {st.totalLayers ? `/${st.totalLayers}` : ""}
        </span>
      )}
      {(st.state === "printing" || st.state === "paused") && <span>{pct}%</span>}
      {st.timeLeftS != null && <span>{fmtDuration(st.timeLeftS)} left</span>}
      <span className="ml-auto text-muted-foreground">
        nozzle {Math.round(st.extruder.temp)}/{Math.round(st.extruder.target)}° · bed {Math.round(st.bed.temp)}/{Math.round(st.bed.target)}°
      </span>
    </div>
  )
}

/** "Watch print": a large camera view with the live print status overlaid. */
export function WatchPrintButton({ machine, size = "xs" }: { machine: MachineWithStatus; size?: "xs" | "sm" }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)} title="Watch the print">
        <CameraIcon /> Watch print
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{machine.name}</DialogTitle>
            <DialogDescription>{machine.status?.filename ?? "No job running"}</DialogDescription>
          </DialogHeader>
          {open && <CameraView machine={machine} fit="contain" className="aspect-video w-full border" overlay={<PrintOverlay machine={machine} />} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
