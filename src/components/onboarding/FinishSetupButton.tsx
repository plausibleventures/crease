// The quiet way back into skipped setup steps: "Finish setup · 2 left". Shown only after first-run setup was closed
// and while something is still left. Never a toast, badge or popup.
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useStudio } from "@/stores/studio"
import { openSetup, useSetup } from "./setup-state"

export function FinishSetupButton({ className, size = "sm" }: { className?: string; size?: "sm" | "xs" }) {
  const left = useSetup((s) => s.left)
  const onboarded = useSetup((s) => s.onboarded)
  const setupOpen = useStudio((s) => s.onboarding.open)
  useEffect(() => {
    if (useSetup.getState().left === null) void useSetup.getState().refresh()
  }, [])
  if (!onboarded || setupOpen || !left?.length) return null
  return (
    <Button variant="ghost" size={size} className={cn("text-muted-foreground hover:text-foreground", className)} onClick={() => openSetup(left)}>
      Finish setup · {left.length} left
    </Button>
  )
}
