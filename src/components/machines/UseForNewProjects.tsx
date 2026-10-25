// Adding a printer never changes the default silently (UX round 2): once the Add printer form closes on a new
// printer, ask "Use <name> for new projects?". Existing projects keep their printer either way.
import { useState } from "react"
import { create } from "zustand"
import { toast } from "sonner"
import { Loader2Icon } from "@/components/icons"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { api, errMsg } from "@/lib/api"
import { useStudio } from "@/stores/studio"

const useAsk = create<{ machine: { id: string; name: string } | null }>(() => ({ machine: null }))

/** Ask about a printer just added, unless it already is the default (e.g. the practice printer standing in). */
export async function askUseForNewProjects(id: string) {
  await useStudio.getState().loadMachines()
  const m = useStudio.getState().machines?.find((x) => x.id === id)
  if (m && !m.isDefault) useAsk.setState({ machine: { id: m.id, name: m.name } })
}

export function UseForNewProjectsDialog() {
  const m = useAsk((s) => s.machine)
  const [busy, setBusy] = useState(false)
  const close = () => useAsk.setState({ machine: null })
  const yes = async () => {
    if (!m) return
    setBusy(true)
    try {
      await api.setDefaultMachine(m.id)
      await useStudio.getState().loadMachines()
      toast.success(`New projects use ${m.name}`)
      close()
    } catch (e) {
      toast.error("Couldn't change it", { description: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!m} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Use {m?.name} for new projects?</DialogTitle>
          <DialogDescription>Projects you already have keep their printer.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Not now
          </Button>
          <Button onClick={() => void yes()} disabled={busy} autoFocus>
            {busy && <Loader2Icon className="animate-spin" />}
            Yes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
