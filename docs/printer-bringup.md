# SPARKX i7 bring-up checklist

Goal: go from "printer on the network" to one confirmed small print from Crease, one gated step at a time.
Stop at the first step that fails and write down what happened (an issue is a good place).
Everything up to step 4 is read-only or upload-only. Nothing here starts a print except step 5, and that goes through the app's confirmation dialog.

Before you start
- Printer powered, homed once from its own screen, bed empty, Generic/CR PLA loaded (CFS slot 1 or the external spool).
- Find its IP on the touchscreen (Settings → Network). Below: `I7=192.168.x.y`.
- Mac and printer on the same LAN. `ping $I7` works.

## 1. Probe (read-only)

```sh
npx tsx tools/probe-printer.ts $I7
```

Writes `docs/printer-probe-$I7.md`. Look for:
- [ ] **Open ports.** 7125 means Moonraker. 4408/4409 means Fluidd/Mainsail; the probe also tries Moonraker through them. 9999 means Creality's own WebSocket API. 8000 means the WebRTC camera. 8080 means mjpg-streamer.
- [ ] **Moonraker reachable without root?** (SPEC open question.) If not:
  - Enable root on the touchscreen (Settings → Root account information, wait 30 s, accept). SimplyPrint's i7 guide does this.
  - Re-probe. Record both results.
  - A 401/403 means Moonraker's `[authorization]` doesn't trust our IP. Note it and do not change the printer config yet.
- [ ] **Objects list.** Record the non-standard object names; the CFS unit probably shows up here (e.g. `box`, a filament rack or an RFID object). Paste its state into findings.
- [ ] **Macros.** Check `START_PRINT`:
  - Does it accept `EXTRUDER_TEMP` and `BED_TEMP` (what OrcaSlicer's i7 profile sends)?
  - Does it home, run `BED_MESH_CALIBRATE` and heat itself?
  - Also check `END_PRINT` and `PAUSE`, and whether `M8200` (CFS) exists as a macro or a built-in.
- [ ] **`[bed_mesh]`.** Record `mesh_min`/`mesh_max`. Our profile has `bed_mesh_min 0,0` / `max 255,255`.
- [ ] **Files.** Is the `gcodes` root `rw`?
- [ ] **Cameras.** Is a webcam listed with a snapshot URL that returns an image, and on which port? If none is listed, note whether `:8080/?action=snapshot` answers directly.

## 2. Point the app at the printer (read-only status)

- `npm run dev` without the mock, or keep the mock running and just change the host. In Settings, set printer host = `$I7`, port = the Moonraker port from the probe. Or:
  `curl -XPUT localhost:5174/api/settings -H 'content-type: application/json' -d '{"printer":{"host":"'$I7'","port":7125}}'`
  This takes effect within about 2 s, no restart needed.
- [ ] Status bar shows connected, `isMock: false`, and real temperatures. Check `curl localhost:5174/api/printer/status`.
- [ ] Preheat from the printer's screen. Our extruder/bed temp and target follow it.
- [ ] `curl -o snap.jpg localhost:5174/api/printer/snapshot` returns a real camera frame.
  - If it fails, check which URL the probe found working; `getSnapshot` tries `:80`, `:4408`, `:4409` and the Moonraker port for relative URLs.

## 3. Slice a calibration cube

- Create a project with a 20 mm cube (`cube(20);`) and slice it (Slice button, or `POST /api/projects/:id/parts/:part/slice`).
- [ ] Open `build/<part>.gcode` and check:
  - `START_PRINT EXTRUDER_TEMP=220 BED_TEMP=55` near the top. The parameter names must match the macro found in step 1.
  - `M8200 P S0` / `M8200 O` (CFS select/feed) and `T0`. If the i7 has no `M8200`, the start G-code must be changed before printing.
  - The purge line: `G1 Y0 … G1 X150 … G1 X120 Y0 E15` (front edge of the bed).
  - `EXCLUDE_OBJECT_DEFINE … CENTER=130,130` (part centred on the 260×260 bed), and `; estimated printing time` near the end.
- [ ] Compare against a cube sliced in Creality Print 7 for the i7: same start sequence, temperatures and first-layer height?

## 4. Upload-only test (no print)

```sh
npx tsx tools/probe-printer.ts $I7 --allow-upload
```

This uploads a comment-only file, checks it is listed, then deletes it.
- [ ] Upload 201, listed, delete 200.
- [ ] The printer's own screen and Creality Print don't complain about the foreign file.

## 5. One confirmed small print

- Bed clear. Stay at the printer, ready to hit the touchscreen stop.
- In the app, Print the cube. The confirmation dialog shows the estimate. Tick "bed is clear" and approve.
- [ ] The file uploads as `<project>_<part>.gcode` and the printer starts. The app shows `printing`, then heating, then progress.
- [ ] Watch the first minute:
  - START_PRINT homes, meshes and heats.
  - The CFS loads the right slot (or errors: note the message).
  - The purge line is on the bed.
  - The first layer sticks.
- [ ] Try Pause → Resume once mid-print, from the app.
- [ ] `printer_snapshot` (agent tool) or `/api/printer/snapshot` shows the print.
- [ ] On finish, the app gets `print.finished`, the result prompt appears, and `GET /api/prints` shows `state: complete`.
  Record the outcome (success/failed + notes).
- [ ] Measure the cube (X/Y/Z, expect 20.0 ± 0.2 mm) and note it with the print record.

## 6. First multicolour print (only after step 5 succeeded)

CLI multicolour G-code (CFS) is **unverified on the real i7**. Make the first one small:
- A 40 mm, 2-colour coaster: white base with a red inlay on the top 1 mm. Load White in slot 1 and Red in slot 3, matching Settings → Printer.
- Slice it. Expect `filamentBySlot` for slots 1 and 3 and `colorChanges` ≈ 5. In the G-code, each change should be `M8200 P S2` … `M8200 L I2` … `T2`.
- [ ] The CFS loads slot 1 at the start, then switches to slot 3 at the inlay layers.
  - It should cut, retract, purge at the chute (X267–278) and wipe.
  - The prime tower prints in the back right (x≈160–210, y≈210–240).
- [ ] The colours land where the model says: slot mapping right, no colour bleed beyond a layer or two.
- [ ] Grams per slot are roughly what the app said. Note the actual purge waste.
- If `M8200` sequences misbehave, stop. Compare with a Creality Print 7 multicolour slice of the same model, and record the differences in findings.

## If something goes wrong

- **Cancel:** use the app's Cancel button or the touchscreen. Klipper's `CANCEL_PRINT` runs the printer's own cancel macro.
- **CFS errors on `M8200`:** retry with a profile whose start G-code drops the `M8200` lines and uses the external spool. This needs a profile change in `server/slicer/flatten-profiles.ts` overrides.
- **Moonraker unreachable even with root:** fall back to the SPEC's plan. Slice in Creality Print and send from there; Crease keeps the status read-only.

## Supervised tests added by R19 (2026-10-09)

Written while the printer was off, so none of these have run on the i7. Each needs you at the printer. Record
results in an issue; when one passes, raise its level in `shared/printer-support.ts` and run
`npx tsx tools/gen-printer-support.ts`.

### A. Warm-start Preparing phase (read-only for the app; uses an ordinary approved print)
The phase logic now uses `virtual_sdcard.file_position` (before the file's first `;LAYER_CHANGE` = preparing) and
ignores a layer number left over from the previous job. Fixtures: `server/printer/fixtures/status/sequences.json`.
1. Print something small (approve as usual). As soon as it finishes, start a second small print (warm printer).
2. Watch the machine card: it must say **Preparing · …** until the purge line is done, then **Printing L1**.
3. Capture the real sequence while it prepares (read-only):
   `for i in $(seq 30); do curl -s 'http://10.0.0.24:7125/printer/objects/query?virtual_sdcard&print_stats&idle_timeout' >> warm.jsonl; echo >> warm.jsonl; sleep 2; done`
   Check what `virtual_sdcard.layer` shows while preparing (0, or the previous job's last layer?) and that
   `file_position` stays put during START_PRINT. Add the recording to the fixtures.

### B. "Start prints through Creality's own service" (experimental, default off)
What it does: upload through Moonraker as now, then send over `ws://<printer>:9999`
`colorMatch` (slot → G-code filament) + `multiColorPrint` for CFS files, or `opGcodeFile` for others (see
`server/printer/creality.ts`). If nothing reached the printer it falls back to the normal Moonraker start; if the
messages were sent but the printer doesn't start within 20 s the request fails (it never starts twice).
Tested only against the simulator (`server/printer/creality.test.ts`, and an approved print on the
`MOCK_CREALITY=1 MOCK_CREALITY_WS_PORT=…` mock through the app).
1. Bed clear, a 20 mm cube sliced for White in slot 1. Machines → edit the i7 → tick the experimental box → Save.
2. Send it and approve. Stay at the printer, ready to stop it on the touchscreen.
3. Check: the touchscreen shows the job (name, progress) as if started from Creality Print; the CFS loads slot 1
   (not another colour: that would mean `materialId` / slot ids are wrong); the app shows Preparing → Printing.
4. Try Pause/Resume and Cancel from the app (still Moonraker) and note whether the touchscreen follows.
5. On finish: does the touchscreen clear by itself (deviceState → 0)? Does Moonraker history get an entry?
6. Two-colour test only after 1–5 pass (slots 1 and 3).
If anything is off: untick the box (the normal start is unchanged) and record the `[printer]` log lines.

### C. Local-only camera (no Google STUN)
LAN printers now default to host candidates only; Electron shows the real LAN address
(`WebRtcHideLocalIpsWithMdns` off) and the server swaps any `*.local` mDNS names in the offer for this Mac's
address on the printer's subnet. If no video arrives within 6 s the app retries once with STUN (camera dot turns
amber; hover says so). Unit tests: `server/printer/camera.test.ts`.
1. Only while the printer is idle (or you accept a live view during a print). Open Machines in the desktop app
   (`npm run dev:electron`): the i7 card should show video with a **red** live dot (local). Amber = it fell back.
2. Edit the i7 → Camera connection → "Local network only" → the video must still appear. Then unplug the router's
   internet (or block stun.l.google.com) and reload: still video?
3. Repeat in plain Chrome via `npm run dev` (mDNS names are rewritten by the server there).

### D. Non-PLA CFS material codes
Only `001001` (Hyper PLA) has been seen. Load PETG (or any non-PLA) in a CFS slot, set it on the touchscreen,
then read `curl -s 'http://10.0.0.24:7125/printer/objects/query?box' ` (read-only) and compare
`material_type` with the table in `server/printer/cfs.ts` (expected PETG `006002` Hyper PETG / `000003` Generic PETG).
Mark rows `verified: true` as they're confirmed.

## E. One part at a time (two-colour plate, supervised)
Why: two-colour plates of single-colour parts print much faster "by object" (one colour change instead of one per
layer), but the print head travels over finished parts using the profile's clearance numbers
(`extruder_clearance_radius` 64, `extruder_clearance_height_to_rod` 40 in resources/slicer-profiles/sparkx-i7), which
are inherited and unverified on the i7.
1. Slice a short two-part, two-colour plate (e.g. the box-with-lid starter at 50% height, base White / lid Red) with
   `print_sequence = by object` (Maker mode → slice_plate overrides, or ask the designer).
2. Watch the whole print; be ready to cancel. Pass = the nozzle/hotend never touches the first part when it moves to
   the second, and the gantry clears it.
3. If it passes: Machines → edit the i7 → tick "Safe to print parts one at a time". Note the result in an issue.
