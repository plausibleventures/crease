// Versions (git commits) and "another idea" (git branches) actions, in plain words, with one shared
// confirmation dialog mounted at the app root.
import { useState } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import { Loader2Icon } from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"

interface ConfirmReq {
  title: string
  body: string
  confirm: string
  run: () => Promise<void>
}
const useConfirm = create<{ req: ConfirmReq | null; set: (r: ConfirmReq | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}))

export function GlobalConfirm() {
  const req = useConfirm((s) => s.req)
  const setReq = useConfirm((s) => s.set)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && !busy && setReq(null)}>
      <DialogContent className="sm:max-w-sm">
        {req && (
          <>
            <DialogHeader>
              <DialogTitle>{req.title}</DialogTitle>
              <DialogDescription>{req.body}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReq(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await req.run()
                  } finally {
                    setBusy(false)
                    setReq(null)
                  }
                }}
              >
                {busy && <Loader2Icon className="animate-spin" />}
                {req.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

const agentBusy = (projectId: string) => !!useStudio.getState().agent[projectId]?.running

/** "Go back to this version" — a new version with the old files; nothing is lost. */
export function askRestore(projectId: string, commit: string, label: string) {
  if (agentBusy(projectId)) return void toast("The designer is working", { description: "Stop it first, then go back to an older version." })
  useConfirm.getState().set({
    title: "Go back to this version?",
    body: `“${label}” becomes the current version. Your current version stays in history, so you can come back to it any time.`,
    confirm: "Go back",
    run: async () => {
      try {
        await api.restoreCheckpoint(projectId, commit)
        await useStudio.getState().resync(projectId)
        toast.success("Went back to that version", { description: "Re-rendering the parts…" })
      } catch (e) {
        toast.error("Couldn't go back", { description: errMsg(e) })
      }
    },
  })
}

/** "Try another idea" — a separate copy to experiment with; the chat continues from here. */
export function askTryIdea(projectId: string, fromCommit?: string, label?: string) {
  if (agentBusy(projectId)) return void toast("The designer is working", { description: "Stop it first, then try another idea." })
  useConfirm.getState().set({
    title: "Try another idea?",
    body: fromCommit
      ? `Starts a separate copy from “${label ?? "this version"}”. Your current design is kept as it is; switch back any time from Sessions.`
      : "Starts a separate copy of the design to experiment with. Your current design is kept as it is; switch back any time from Sessions.",
    confirm: "Try another idea",
    run: async () => {
      try {
        const r = await api.createVariant(projectId, fromCommit)
        await useStudio.getState().resync(projectId)
        toast.success(`Now trying: ${r.title}`, { description: "Ask the designer for the change you want to try." })
      } catch (e) {
        toast.error("Couldn't start another idea", { description: errMsg(e) })
      }
    },
  })
}
