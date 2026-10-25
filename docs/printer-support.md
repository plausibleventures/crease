# Printer support matrix

<!-- Generated from shared/printer-support.ts by `npx tsx tools/gen-printer-support.ts`. Do not edit by hand. -->

Crease has been used with real prints on **one printer: a Creality SPARKX i7** (firmware 1.1.5.10). Everything else is either *simulated only* (exercised against the built-in practice printer, a Moonraker simulation, or the OrcaSlicer CLI) or *untested*. OrcaSlicer ships presets for hundreds of models, so the model list is long, but a slicer preset is not the same as printer support.

Levels: ✓ verified on real hardware · ~ simulated only · ? untested · – not supported

| Family | Slicer preset | Save print file (by hand) | Send + control (Moonraker) | Colour / material slots | Creality job tracking (:9999) | Camera |
|---|---|---|---|---|---|---|
| **Practice printer (built in)** | ~ simulated | ~ simulated | ~ simulated | ~ simulated | – unsupported | ~ simulated |
| **Creality SPARKX i7** | ✓ verified | ✓ verified | ✓ verified | ✓ verified | ~ simulated | ✓ verified |
| **Creality Klipper printers with CFS** | ? untested | ? untested | ? untested | ? untested | ? untested | ? untested |
| **Creality Klipper printers (single spool)** | ? untested | ? untested | ? untested | – unsupported | ? untested | ? untested |
| **Bambu Lab** | ? untested | ? untested | – unsupported | – unsupported | – unsupported | – unsupported |
| **Other Klipper printers (Moonraker)** | ? untested | ? untested | ~ simulated | – unsupported | – unsupported | ~ simulated |
| **Other printers (Marlin, PrusaLink, OctoPrint …)** | ? untested | ? untested | – unsupported | – unsupported | – unsupported | – unsupported |

## Details

### Practice printer (built in)

Covers: Crease's pretend printer.

- **Slicer preset** — ~ simulated only. Uses the SPARKX i7 profile, so files match what a real i7 gets.
- **Save print file (by hand)** — ~ simulated only. Save print file works the same way; nothing to print it on.
- **Send + control (Moonraker)** — ~ simulated only. A Moonraker simulation inside Crease: heats, prepares, prints, finishes. Nothing moves.
- **Colour / material slots** — ~ simulated only. Shows the colours you typed in for it; a made-up CFS unit for testing.
- **Creality job tracking (:9999)** — – not supported. The dev mock (MOCK_CREALITY=1, MOCK_CREALITY_WS_PORT) emulates Creality firmware; the practice printer doesn't.
- **Camera** — ~ simulated only. A drawn picture of the print, via a Moonraker-style snapshot URL.

### Creality SPARKX i7

Covers: SPARKX i7 (with or without CFS-lite), firmware 1.1.5.10. Verified on: SPARKX i7.

- **Slicer preset** — ✓ verified on real hardware. Tuned copy of OrcaSlicer's i7 preset; calibration cube, apple logo and test plates printed.
- **Save print file (by hand)** — ✓ verified on real hardware. The same G-code that printed over the network. Printing it from a USB stick on the touchscreen is untested.
- **Send + control (Moonraker)** — ✓ verified on real hardware. Upload, start, cancel, Preparing phase and end detection on real prints. Pause/resume from the app: untested.
- **Colour / material slots** — ✓ verified on real hardware. CFS slots and colours read from the printer; slot mapping fixed after the first print. Material codes other than PLA (001001): unverified.
- **Creality job tracking (:9999)** — ~ simulated only. Listening to :9999 for layer/time left: verified. Starting jobs through Creality's service so the touchscreen tracks them: experimental, simulator only (off by default).
- **Camera** — ✓ verified on real hardware. WebRTC on :8000 with Google's STUN server. Local-only (no STUN): implemented, untested on the printer.

### Creality Klipper printers with CFS

Covers: K2, K2 Plus, K2 Pro, Hi (Combo), K1-series with CFS-C.

- **Slicer preset** — ? untested. OrcaSlicer's own preset; never printed from Crease.
- **Save print file (by hand)** — ? untested. Standard G-code for the printer's touchscreen / USB; never tried.
- **Send + control (Moonraker)** — ? untested. Same Creality-Klipper + Moonraker path as the i7, so it should work; K1-series stock firmware may need root for Moonraker.
- **Colour / material slots** — ? untested. Expected to read the same Moonraker `box` object as the i7; never seen on these printers.
- **Creality job tracking (:9999)** — ? untested. The :9999 websocket is documented for the K1/K2 family (OrcaSlicer, community notes); never tried here.
- **Camera** — ? untested. K2-family firmware is reported to use the same WebRTC camera on :8000 as the i7.

### Creality Klipper printers (single spool)

Covers: K1, K1C, K1 Max, K1 SE, Ender-3 V3 / V3 KE / V3 Plus, Ender-5 Max.

- **Slicer preset** — ? untested. OrcaSlicer's own preset (the K1 preset was sliced in development, never printed).
- **Save print file (by hand)** — ? untested. Standard G-code for the printer's touchscreen / USB; never tried.
- **Send + control (Moonraker)** — ? untested. Creality-Klipper + Moonraker like the i7; K1-series stock firmware may need root before Moonraker answers.
- **Colour / material slots** — – not supported. Single spool (a CFS add-on would be read like the i7's, untested).
- **Creality job tracking (:9999)** — ? untested. K1-family firmware has the :9999 websocket; never tried here.
- **Camera** — ? untested. Auto-detected (WebRTC :8000 or mjpg-streamer :8080); never tried on these printers.

### Bambu Lab

Covers: A1, A1 mini, P1P, P1S, X1C, H2D.

- **Slicer preset** — ? untested. OrcaSlicer's own preset.
- **Save print file (by hand)** — ? untested. Bambu printers normally take a sliced .gcode.3mf from Bambu Studio/Handy; a plain .gcode on the SD card is untested.
- **Send + control (Moonraker)** — – not supported. Bambu uses its own MQTT/FTP protocol, not Moonraker.
- **Colour / material slots** — – not supported. The AMS isn't read.
- **Creality job tracking (:9999)** — – not supported. Not Creality firmware.
- **Camera** — – not supported. Not connected.

### Other Klipper printers (Moonraker)

Covers: Voron, RatRig, Sovol SV07/SV08, Elegoo Neptune 4, Qidi, Anycubic Kobra (Klipper builds), Prusa/others running Klipper.

- **Slicer preset** — ? untested. OrcaSlicer's own preset for the model; its start G-code must match the printer's PRINT_START macro.
- **Save print file (by hand)** — ? untested. Standard G-code; never tried by hand on these printers.
- **Send + control (Moonraker)** — ~ simulated only. Upload, start, pause/resume/cancel, status and end detection follow Moonraker's documented API; exercised only against the built-in practice printer (a Moonraker simulation). Plain Klipper reports print_stats normally, which the simulator also covers.
- **Colour / material slots** — – not supported. Single spool; other multi-colour units (MMU, ERCF, Box Turtle) aren't read.
- **Creality job tracking (:9999)** — – not supported. Not Creality firmware.
- **Camera** — ~ simulated only. Moonraker-listed webcams (snapshot URL) and mjpg-streamer; only the simulator's snapshot was tested.

### Other printers (Marlin, PrusaLink, OctoPrint …)

Covers: Prusa MK4/Core One/Mini, Ender-3 V2/S1, Anycubic, Elegoo (Marlin), anything else in the model list.

- **Slicer preset** — ? untested. OrcaSlicer's own preset (or a generic profile sized to the bed when the model isn't listed).
- **Save print file (by hand)** — ? untested. Save the G-code and print it from the printer's screen / SD card / its own app.
- **Send + control (Moonraker)** — – not supported. Crease only talks to Klipper's Moonraker. PrusaLink / OctoPrint / Marlin serial aren't supported.
- **Colour / material slots** — – not supported. Not read.
- **Creality job tracking (:9999)** — – not supported. Not Creality firmware.
- **Camera** — – not supported. Not connected.

## Without a connection (export only)

Any printer in the model list can be added with **No connection**. Crease slices for it and **Save print file** writes the G-code (`<project>_<part>.gcode`). Copy it to a USB stick / SD card (or send it with the printer's own app), then pick it on the printer's screen. Crease can't see these prints, so there is no progress, camera or end-of-print log.

## How a level goes up

Run the steps in `docs/printer-bringup.md` on the printer, record what happened (with photos) in an issue or PR, then change the level in `shared/printer-support.ts` and regenerate this file. R19's acceptance asks for a second hardware/adapter path to be proven before claiming breadth.
