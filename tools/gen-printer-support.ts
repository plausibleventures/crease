// Regenerate docs/printer-support.md from shared/printer-support.ts (the support matrix).
// Usage: npx tsx tools/gen-printer-support.ts
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderSupportDoc } from "../shared/printer-support"

const out = join(dirname(fileURLToPath(import.meta.url)), "../docs/printer-support.md")
writeFileSync(out, renderSupportDoc())
console.log(`wrote ${out}`)
