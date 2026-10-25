# Slicer profiles (derived from OrcaSlicer)

- Upstream: OrcaSlicer's bundled system presets, https://github.com/OrcaSlicer/OrcaSlicer/tree/main/resources/profiles
  (`Creality/` and `OrcaFilamentLibrary/`), as installed with OrcaSlicer 2.4.2 (`OrcaSlicer.app/Contents/Resources/profiles`).
- Licence: OrcaSlicer is distributed under the GNU Affero General Public License v3 (AGPL-3.0). The profiles folder
  has no separate licence, so we treat these derived files as covered by the AGPL-3.0. Full text: `LICENSE-AGPL-3.0.txt`
  (from https://www.gnu.org/licenses/agpl-3.0.txt, sha256 0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0).
- What we copied, per folder (`sparkx-i7/` today):
  - `machine.json` from "Creality SPARKX i7 0.4 nozzle"
  - `process.json` from "0.20mm Standard @Creality SPARKX i7 0.4 nozzle"
  - `filament-PLA.json`, `filament-PETG.json`, `filament-TPU.json` from "Generic PLA|PETG|TPU @SPARKX i7-all"
- How they were changed: the `inherits` chain is flattened into one file (`server/slicer/flatten-profiles.ts`), and a
  few values were changed: `retraction_distances_when_cut` 28 -> 18 (the CLI rejects 28), `flush_into_infill` = 1 for
  multicolour, plus later hand tuning recorded in git history.
- These are plain-text JSON files and are their own source code. You may copy, modify and redistribute them under the
  AGPL-3.0. A modified copy you distribute must stay under the AGPL-3.0 and say that you changed it.
- Not bundled: the other machine presets offered by the model picker are read from the user's own OrcaSlicer install
  at runtime and flattened into `<PRINTSTUDIO_HOME>/slicer-profiles/` on that computer only.
- Crease does not link OrcaSlicer: it runs the user's separately installed OrcaSlicer CLI as its own program.

This folder is the one part of the repository that is not under Crease's Apache-2.0 licence (see the top-level
NOTICE). See docs/licenses/INVENTORY.md.
