// What first-run setup still has left: computed from the real state (a designer that works, any printer, chosen
// preferences), so a step done elsewhere (Designers, Machines, Settings) counts too. Feeds the quiet "Finish setup".
import { create } from "zustand"
import { profileHealth } from "@/components/agents/parts"
import { api } from "@/lib/api"
import { useStudio } from "@/stores/studio"

export type SetupStep = "designer" | "printer" | "preferences"
/** Wizard screens, in order. */
export const SETUP_SCREENS = ["welcome", "designer", "printer", "preferences", "done"] as const
export const screenOf = (s: SetupStep) => SETUP_SCREENS.indexOf(s)

interface SetupState {
  /** Steps not done yet, in setup order; null until checked. */
  left: SetupStep[] | null
  onboarded: boolean
  refresh: () => Promise<void>
}

export const useSetup = create<SetupState>((set) => ({
  left: null,
  onboarded: true,
  refresh: async () => {
    try {
      const [profiles, probes, machines, settings] = await Promise.all([api.agentProfiles(), api.agentRuntimes().catch(() => []), api.machines(), api.getSettings()])
      const def = profiles.profiles.find((p) => p.isDefault)
      const ready =
        !!def &&
        profileHealth(
          def,
          profiles.runtimes.find((r) => r.kind === def.runtime),
          probes.find((x) => x.runtime === def.runtime),
        ).ready === true
      const left: SetupStep[] = []
      if (!ready) left.push("designer")
      if (!machines.length) left.push("printer")
      if (settings.units !== "mm" && settings.units !== "in") left.push("preferences")
      set({ left, onboarded: !!settings.onboardedAt })
    } catch {
      /* server not up yet: keep the last answer */
    }
  },
}))

/** Open setup at the first step still left (or the start); Next then skips the steps already done. */
export function openSetup(left: SetupStep[] | null = useSetup.getState().left) {
  if (!left?.length) return useStudio.getState().setOnboarding({ open: true, step: 0 })
  useStudio.getState().setOnboarding({ open: true, step: screenOf(left[0]), only: left.map(screenOf) })
}
