# Printer status sequences (phase logic fixtures)

`sequences.json` holds sequences of Moonraker status polls (`print_stats`, `virtual_sdcard`, `idle_timeout`,
`pause_resume`, optional Creality `:9999` push data `ws`) with the state Crease should derive
(`server/printer/phase.ts`, tested by `server/printer/phase.test.ts`). `t` is ms after our start of the job.

Field names and idle values come from the read-only probe of the SPARKX i7 (fw 1.1.5.10)
and live observations of its firmware status and end-of-print behaviour. The printer was powered off when R19 was written, so these are
**reconstructed** sequences, not raw recordings: each sequence's `source` says what was observed and what is the
hypothesis being guarded against. Replace or add recorded polls when someone captures a warm start
(docs/printer-bringup.md "Supervised test: warm-start Preparing phase").

File positions use the real calibration cube G-code (373 719 bytes, `START_PRINT` at byte 662, first
`;LAYER_CHANGE` at byte 1237).
