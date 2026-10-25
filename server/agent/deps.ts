// Indirection over the other server modules the agent calls, so tests (and the scratch
// verification script) can swap in fakes without module mocking. Production code uses the
// real implementations below; nothing else should mutate this object.
import { getProject, projectDir, saveCheckpoint, updateProject } from "../projects/store"
import { checkPart, exportPart, listParameters, renderPart, setPartOrientation } from "../cad/index"
import { slicePart } from "../slicer/index"
import { getPrinterStatus, requestPrint } from "../printer/index"
import { buildAssemblyGuide, checkAssemblyMotion, readAssembly, renderAssemblyStep, writeAssembly } from "../assembly/index"

export const deps = {
  getProject,
  projectDir,
  saveCheckpoint,
  updateProject,
  renderPart,
  checkPart,
  exportPart,
  listParameters,
  setPartOrientation,
  slicePart,
  getPrinterStatus,
  requestPrint,
  writeAssembly,
  readAssembly,
  renderAssemblyStep,
  buildAssemblyGuide,
  checkAssemblyMotion,
}
export type AgentDeps = typeof deps
