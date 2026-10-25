// Claude plan usage, from the SDK's `rate_limit_event` messages (claude.ai subscription logins).
// Usage is account-wide, so we keep only the latest reading, not one per session.
// The documented SDKRateLimitInfo has {status, rateLimitType, utilization, resetsAt}. CLI 2.1.29x also sends an
// undocumented `unifiedWindows: {five_hour: {utilization 0..1, resetsAt epoch-s}, seven_day: {...}}`, which we
// prefer when present.
import type { AgentBilling, PlanUsage, PlanUsageWindow } from "../../shared/types"
import { billingOf, defaultProfile } from "./profiles"
import { emit } from "../events"

let latest: PlanUsage | null = null

export function billingMode(): AgentBilling {
  // R11b: how the default agent profile signs in (a project's own profile can differ; its runs carry their billing).
  try {
    return billingOf(defaultProfile())
  } catch {
    return "plan"
  }
}

function win(w: unknown): PlanUsageWindow | null {
  if (!w || typeof w !== "object") return null
  const o = w as { utilization?: unknown; resetsAt?: unknown }
  if (typeof o.utilization !== "number") return null
  return { utilization: o.utilization, resetsAt: typeof o.resetsAt === "number" ? o.resetsAt : null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function onRateLimitEvent(info: any) {
  if (!info || typeof info !== "object") return
  const uw = info.unifiedWindows ?? {}
  let fiveHour = win(uw.five_hour)
  let sevenDay = win(uw.seven_day)
  if (!fiveHour && !sevenDay && typeof info.utilization === "number") {
    const w = { utilization: info.utilization, resetsAt: info.resetsAt ?? null }
    if (info.rateLimitType === "five_hour") fiveHour = w
    else if (String(info.rateLimitType).startsWith("seven_day")) sevenDay = w
  }
  latest = {
    status: info.status ?? "allowed",
    fiveHour: fiveHour ?? latest?.fiveHour ?? null,
    sevenDay: sevenDay ?? latest?.sevenDay ?? null,
    updatedAt: new Date().toISOString(),
  }
  emit({ type: "agent.usage", billing: billingMode(), usage: latest })
}

export function getUsage(): { billing: AgentBilling; usage: PlanUsage | null } {
  const billing = billingMode()
  return { billing, usage: billing === "plan" ? latest : null }
}
