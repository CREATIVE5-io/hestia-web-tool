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
```

Modbus RTU encoding/decoding lives entirely in [utils/modbus.ts](utils/modbus.ts) (`buildReadInputRegisters`, `buildWriteMultipleRegisters`, `parseMbResponse`, `crc16`).

### State management

No global store. Two independent custom hooks own all hardware state:

- **[hooks/useDongleConnection.ts](hooks/useDongleConnection.ts)** — NTN dongle: serial port lifecycle, read loop, Modbus request queue, device data polling (RSRP/SINR every 3 s), NTN config apply.
- **[hooks/useLoRaConnection.ts](hooks/useLoRaConnection.ts)** — LoRa module: independent serial port, PCIE2 AT command wrapper, LoRa device list (up to 16 slots).

Both hooks use refs (`portRef`, `readerRef`, `keepReadingRef`, `responseBufferRef`, `responseResolveQueueRef`) so serial state survives re-renders without stale closure issues.

### Request/response pattern (critical)

Modbus is synchronous request/response over a shared byte stream. The read loop in `useDongleConnection` accumulates bytes in `responseBufferRef` until a complete frame arrives, then dispatches it to the **FIFO promise queue** (`responseResolveQueueRef`). Callers `await sendRequest(frame)` which pushes a resolver onto the queue and waits (2 s timeout). `lastCommandRef` tracks what was sent so `processIncomingDataWithContext()` knows how to parse the response.

### Tab switching behavior

[App.tsx](App.tsx) has two tabs (NTN Dongle | LoRa Configuration). Each hook owns its own independent serial port — NTN and LoRa cannot hold ports simultaneously.

Tab switching is coordinated via an **async `handleTabSwitch`** function in App.tsx, which `await`s the appropriate `disconnect()` before calling `setActiveTab`:

- **NTN → LoRa:** calls `disconnect()` from `useDongleConnection` (stops read loop → clears poll interval → closes port), then switches tab.
- **LoRa → NTN:** calls the LoRa disconnect function registered via the `onRegisterDisconnect` prop, then switches tab.

`LoRaConfig` exposes its `disconnect` to App.tsx through a mount-time callback registration pattern — `onRegisterDisconnect` prop receives the function and stores it in a `loraDisconnectRef`. This avoids lifting the hook instantiation and allows App.tsx to `await` cleanup before the tab switch renders.

### Key type definitions ([types.ts](types.ts))

- `ConnectionState` enum: `DISCONNECTED | CONNECTING | CONNECTED | ERROR`
- `DriverMode` enum: `AUTO | NATIVE | POLYFILL` (auto tries native first, falls back to WebUSB polyfill)
- `DongleData`, `DongleStatus`, `NTNConfig`, `LoRaDevice`, `LoRaConfig`, `LogEntry`

### Configuration persistence

NTN config (APN, remote IP/port) is saved to `localStorage`. There is no backend.

### Styling

Tailwind CSS 3 with two custom colors in `tailwind.config.js` (`slate-850`, `slate-900`). Use `clsx` + `tailwind-merge` for conditional classes.

### Deployment

`vite.config.ts` sets `base: './'` for GitHub Pages relative-path compatibility. Build output goes to `dist/`.
