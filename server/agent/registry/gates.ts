// Hard preconditions on the agent's tools, enforced by the registry for every runtime (R01/R05). The logic lives in
// approval.ts / done.ts / review.ts; these adapt it to ToolGate. request_print runs requestPrintGate (approval, guide,
// then slice review of the exact G-code) in its handler, because the print job is bound to the review's sha256.
import { blankDesignGate, sliceOrPrintGate } from "../approval"
import { guideRequired } from "../done"
import type { ToolGate } from "./types"

/** The user approved the current design revision ("Looks great", or asked to print). */
export const approvedDesign: ToolGate = (ctx) => blankDesignGate(ctx.projectId) ?? sliceOrPrintGate(ctx.projectId)

/** Builds that go together have a current picture guide before slicing. */
export const guideBuilt: ToolGate = (ctx) => guideRequired(ctx.projectId)
