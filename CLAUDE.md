# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server (hot reload)
npm run build      # TypeScript compile + Vite production build
npm run preview    # Preview production build locally
```

No test runner is configured. TypeScript strict mode (`"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`) enforces correctness at build time — run `npm run build` to type-check.

## Architecture

**Hestia Control Suite** is a single-page React 18 / TypeScript / Vite app that configures and monitors IoT hardware (NTN satellite dongles and LoRa modules) over USB serial. It requires a browser with Web Serial API support (Chrome/Edge on HTTPS or localhost).

### Protocol stack

```
Browser UI → Web Serial API (native or polyfill) → Modbus RTU (CRC16) → Hardware
                                                  → MDFU UART (firmware update)
```

- **Modbus RTU** encoding/decoding: [utils/modbus.ts](utils/modbus.ts) (`buildReadInputRegisters`, `buildWriteMultipleRegisters`, `parseMbResponse`, `crc16`)
- **MDFU firmware update**: [utils/ntnUpdate.ts](utils/ntnUpdate.ts) orchestrates two phases; [utils/mdfu.ts](utils/mdfu.ts) holds pure MDFU protocol functions (ported from pymdfu); [utils/mdfuTransport.ts](utils/mdfuTransport.ts) handles UART framing (`encodeFrame`, `decodeFrame`)

### Data upload

`UplinkPanel` (full-width row above the Satellite Modem panel on the NTN Dongle tab) calls `sendUplinkData()` in useDongleConnection, ported from Hestia-sample-Python `--ud_data`: check 0xEA7D == 0 (uplink buffer free), write the UTF-8 payload as hex text + CRLF from 0xC550 (64 registers per FC 0x10 write), then wait up to 60 s for the ACK on 0xF060/0xF061 (`pollNtnReply()`, shared with `sendNtnModuleCommand()`), with polling paused.

### Hardware model variants

`DongleModel` (`'A1' | 'A2' | 'A1+' | 'A2+'`) and `LoraModuleType` (`'single-ch' | '8-ch'`) are selected in [components/DongleModelPanel.tsx](components/DongleModelPanel.tsx) and persisted to `localStorage`. Both are passed as parameters to `useDongleConnection(dongleModel, loraModule)`.

- **A2 mode** has a different App.tsx layout: Serial Log moves to the right column and a LoRa Data panel appears showing `AT+BISULGET` payload (8-ch) or `AT+BISGET=?` payload (single-ch).
- **A1+ / A2+** use the Nordic nRF9151 modem. Use `isNordicModel()` / `hasLoraModel()` from DongleModelPanel.tsx instead of comparing model strings (A2+ behaves like A2 for LoRa). Nordic models show `NordicPanel` (full-width row on the NTN Dongle tab): network mode (NSTATE + SGP4/NTN/GNSS/TN triggers), modem readiness (NCHECK), auto-MO queue (MOBUF/MOCOUNT), LEO satellite config (SET_TARGET_ID + SET_TLE; TLE pasted or found by searching CelesTrak for `SATELIOT`, the only supported name) and Advanced Diagnostics (any query + raw commands). NVER and NSTATE are read on connect; the NVER provider suffix (`getFirmwareOrbit()`: `-GEO`/`-LEO`) strikes out the unavailable mode, and readiness, the MO queue and *Send to Dongle* are enabled only on LEO firmware (`leoFirmware`). All go through `sendNtnModuleCommand()` in useDongleConnection: write ASCII+CRLF to 0x9C40 (FC 0x10), then poll 0xF060 (reply length in registers) and read 0xF061, with polling paused (`runWithPollingPaused`). Pure protocol helpers (reply parsing, TLE validation) are in [utils/nrf9151.ts](utils/nrf9151.ts), ported from Hestia-sample-Python.
- **8-ch** LoRa module uses `AT+BISULGET` instead of `AT+BISGET=?`. The `EightChDevice` type in [types.ts](types.ts) represents its device format.

### State management

No global store. Two independent custom hooks own all hardware state:

- **[hooks/useDongleConnection.ts](hooks/useDongleConnection.ts)** — NTN dongle: serial port lifecycle, read loop, Modbus request queue, device data polling (STATUS every 10 s, RSRP/SINR per CSQ/GPS interval, LoRa every 30 s), NTN config apply. Takes `(dongleModel, loraModule)` params.
- **[hooks/useLoRaConnection.ts](hooks/useLoRaConnection.ts)** — LoRa module: independent serial port, PCIE2 AT command wrapper, LoRa device list (up to 16 slots).
- **[hooks/useDongleConnectionAT.ts](hooks/useDongleConnectionAT.ts)** — *NTN Dongle - AT* tab: switches the dongle to UART passthrough over Modbus (password + 0xC350 = 3) and runs a line-based AT session. The session *Disconnect* (`stopReadLoop()`), *Serial Disconnect* and leaving the tab (`disconnect()`) all call `switchToModbusMode()`, which writes the escape `MODBUS_MODE_SEQUENCE` (`01 02 05 01 02`, in [utils/modbus.ts](utils/modbus.ts)) to return the dongle to Modbus mode, but only if an AT session put it (or found it) in passthrough on the open port.
- **[hooks/useFirmwareUpdate.ts](hooks/useFirmwareUpdate.ts)** — Firmware update: opens its own serial port via `WebSerialAdapter` (buffered pump loop to avoid lost bytes on timeout), calls `runUpdate()` from ntnUpdate.ts.
- **[hooks/useFirmwareUpdate9151.ts](hooks/useFirmwareUpdate9151.ts)** — *Firmware Update - 9151* tab (nRF9151 modem FOTA): reuses `WebSerialAdapter`, calls `runNrf9151Update()` from [utils/nrf9151Fota.ts](utils/nrf9151Fota.ts), which switches the dongle to UART passthrough over Modbus (password + 0xC350 = 3, like the AT tab; skipped with *Skip Modbus phase*) and then runs the `AT!OTAVER?` / `AT!OTABEGIN` / `AT!OTADATA` (256 B hex chunks) / `AT!OTAEND` / `AT!OTAREB` sequence ported from `9151_ota/fota_test/fota_test.py`. The version is not read back after `AT!OTAREB`: the modem takes ~3 min to boot the new image. Afterwards it waits 2.5 min, writes the raw escape `01 02 05 01 02` to return the dongle to Modbus mode, and sets the Modbus password; the update completes only if the password is acked.

All hooks use refs (`portRef`, `readerRef`, `keepReadingRef`, `responseBufferRef`, `responseResolveQueueRef`) so serial state survives re-renders without stale closure issues.

### Request/response pattern (critical)

Modbus is synchronous request/response over a shared byte stream. The read loop in `useDongleConnection` accumulates bytes in `responseBufferRef` until a complete frame arrives, then dispatches it to the **FIFO promise queue** (`responseResolveQueueRef`). Callers `await sendRequest(frame)` which pushes a resolver onto the queue and waits (2 s timeout).

`lastExpectedResponseBytesRef` tracks the expected byte count of the in-flight request so the read loop can discard stale responses that arrive with the wrong length (avoids mismatched frames from previous timed-out requests).

`lastCommandRef` still exists and tracks the last sent command type; `pollCurrentConfig` now parses responses inline rather than relying on it, but other paths still use it.

### Tab switching behavior

[App.tsx](App.tsx) has two tabs (NTN Dongle | LoRa Configuration). Each hook owns its own independent serial port — NTN and LoRa cannot hold ports simultaneously.

Tab switching is coordinated via an **async `handleTabSwitch`** function in App.tsx, which `await`s the appropriate `disconnect()` before calling `setActiveTab`:

- **NTN → LoRa:** calls `disconnect()` from `useDongleConnection` (stops read loop → clears poll interval → closes port), then switches tab.
- **LoRa → NTN:** calls the LoRa disconnect function registered via the `onRegisterDisconnect` prop, then switches tab.

`LoRaConfig` exposes its `disconnect` to App.tsx through a mount-time callback registration pattern — `onRegisterDisconnect` prop receives the function and stores it in a `loraDisconnectRef`. This avoids lifting the hook instantiation and allows App.tsx to `await` cleanup before the tab switch renders.

### Key type definitions ([types.ts](types.ts))

- `ConnectionState` enum: `DISCONNECTED | CONNECTING | CONNECTED | ERROR`
- `DriverMode` enum: `AUTO | NATIVE | POLYFILL` (auto tries native first, falls back to WebUSB polyfill)
- `DongleData`, `DongleStatus`, `NTNConfig` — NTN dongle runtime data and config
- `PCIE2CommandResult`, `DongleConnectionHandle` — PCIE2 AT command interface
- `LoRaDevice` (includes `otaaAppKey` for OTAA mode), `LoRaConfig`, `EightChDevice` — LoRa types
- `LoRaSetupProgress` — progress reporting during LoRa bulk setup
- `MODBUS_CONSTANTS` — all register addresses as named constants

### CSQ/GPS refresh interval

Holding register `0xC35B` (`ADDR_CSQ_GPS_INTERVAL`, FC 0x06 write, saved to dongle EEPROM) sets how often the dongle firmware refreshes CSQ (RSRP/SINR) and GPS from the NTN module: `0`=off, `1/2/3/4`=1/10/30/60 min, `0xFE`=default ~0.9 s; other values return exception 0x03. It is read in `pollCurrentConfig` and set from `CsqGpsIntervalPanel`. `pollStatus` ticks every 10 s (`STATUS_POLL_MS`) for STATUS; A2 LoRa data is read every 30 s (`LORA_POLL_MS`); RSRP/SINR are only re-read at the rate given by `getSignalPollMs()` in [types.ts](types.ts) (never when off). The read loop also frames FC 0x06 echoes (8 B) and exception responses (5 B).

### Configuration persistence

The following are saved to `localStorage` (no backend):
- NTN config (APN, remote IP/port) — key `ntn-dongle-config`
- Serial log, LoRa log, firmware log — capped at 500 entries each
- `DongleModel` selection — key `ntn-dongle-model`
- `LoraModuleType` selection — key `ntn-lora-module`

### Styling

Tailwind CSS 3 with two custom colors in `tailwind.config.js` (`slate-850`, `slate-900`). Use `clsx` + `tailwind-merge` for conditional classes.

### Deployment

`vite.config.ts` sets `base: './'` for GitHub Pages relative-path compatibility. Build output goes to `dist/`.
