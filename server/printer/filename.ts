// The file name a print goes by on the printer and in "Save print file": the project's current name (not its folder
// id, which keeps the name it was created with) plus the slice's own name, e.g. "desk-hook_plate.gcode".
import { slugify } from "../projects/store"

export function printFileName(projectName: string, file: string): string {
  return `${slugify(projectName)}_${file}`.replace(/[^\w.-]+/g, "_")
}
