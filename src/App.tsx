import { lazy, Suspense, useEffect } from "react"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { StatusBar } from "@/components/StatusBar"
import { LibraryScreen } from "@/components/library/LibraryScreen"
import { Workspace } from "@/components/workspace/Workspace"
import { PrintConfirmDialog } from "@/components/dialogs/PrintConfirmDialog"
import { SettingsDialog } from "@/components/dialogs/SettingsDialog"
import { FinishedPrintAsk, PrintResultDialog } from "@/components/dialogs/PrintResultDialog"
import { GlobalConfirm } from "@/components/versions"
import { HandoffHost } from "@/components/agent/HandoffDialog"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { MachinesScreen } from "@/components/machines/MachinesScreen"
import { AgentsScreen } from "@/components/agents/AgentsScreen"
const StyleBoard = lazy(() => import("@/design/StyleBoard"))
import { MachineDialog } from "@/components/machines/MachineDialog"
import { api } from "@/lib/api"
import { loadUnits } from "@/lib/units"
import { useTheme } from "@/components/theme-provider"
import { startEventSocket } from "@/lib/ws"
import { useStudio } from "@/stores/studio"
import { installCommands } from "@/lib/commands"
import { AppOverlays } from "@/components/CommandPalette"
import { ProjectActionsHost } from "@/components/library/project-actions"

export function App() {
  const route = useStudio((s) => s.route)
  const refreshPrinter = useStudio((s) => s.refreshPrinter)
  const { theme } = useTheme()

  // ⌘K palette, ⌘N/⌘O/⌘, and "?" (browser), or the native menu's commands (desktop app)
  useEffect(() => installCommands(), [])

  useEffect(() => {
    startEventSocket()
    // first run: show the setup wizard until it's finished or skipped once
    api
      .getSettings()
      .then((s) => {
        loadUnits(s.units)
        if (!s.onboardedAt) useStudio.getState().setOnboarding({ open: true, step: 0 })
      })
      .catch(() => {})
    void refreshPrinter()
    void useStudio.getState().loadMachines()
    // fallback poll in case the server doesn't push printer.status; machines list for temps/progress
    const t = setInterval(() => {
      if (useStudio.getState().wsStatus !== "open" || !useStudio.getState().printer) void refreshPrinter()
      void useStudio.getState().loadMachines()
    }, 10_000)
    return () => clearInterval(t)
  }, [refreshPrinter])

  return (
    <TooltipProvider delay={400}>
      <div className="relative flex h-svh flex-col overflow-hidden bg-background text-xs text-foreground">
        <div className="min-h-0 flex-1">
          {route.name === "project" ? (
            <Workspace key={route.id} projectId={route.id} />
          ) : route.name === "machines" ? (
            <MachinesScreen />
          ) : route.name === "agents" ? (
            <AgentsScreen />
          ) : route.name === "style" ? (
            <Suspense fallback={null}>
              <StyleBoard />
            </Suspense>
          ) : (
            <LibraryScreen />
          )}
        </div>
        <FinishedPrintAsk />
        <StatusBar />
      </div>
      <PrintConfirmDialog />
      <PrintResultDialog />
      <GlobalConfirm />
      <HandoffHost />
      <OnboardingWizard />
      <MachineDialog />
      <SettingsDialog />
      <AppOverlays />
      <ProjectActionsHost />
      <Toaster theme={theme === "light" ? "light" : "dark"} position="bottom-right" />
    </TooltipProvider>
  )
}

export default App
