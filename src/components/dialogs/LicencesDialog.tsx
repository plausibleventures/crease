import { useState } from "react"
import { Loader2Icon } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** Settings > About > Licences: the generated THIRD_PARTY_NOTICES.txt (tools/notices.ts), loaded on demand. */
export function LicencesButton() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const show = () => {
    setOpen(true)
    if (text !== null) return
    import("../../../THIRD_PARTY_NOTICES.txt?raw")
      .then((m) => setText(m.default))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }
  return (
    <>
      <Button variant="outline" size="sm" onClick={show}>
        Licences
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Licences</DialogTitle>
            <DialogDescription>
              Crease is built with other people's open-source software, libraries and printer profiles. Their
              licences and copyright notices are below.
            </DialogDescription>
          </DialogHeader>
          {err ? (
            <div className="border border-err/40 bg-err/10 p-2 text-caption text-err">Couldn't load the licences: {err}</div>
          ) : text === null ? (
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2Icon className="animate-spin" /> Loading…
            </div>
          ) : (
            <pre
              aria-label="Third-party notices"
              className="max-h-[65vh] overflow-auto whitespace-pre-wrap border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
            >
              {text}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
