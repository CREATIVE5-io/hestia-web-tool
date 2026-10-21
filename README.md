# Hestia Control Suite

A browser-based configuration and monitoring tool for **NTN satellite dongles** and **LoRa modules** connected over USB serial. Built with React 18, TypeScript, and Vite.

## Browser requirement

Requires **Chrome or Edge** (desktop) — the [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) is not supported in Firefox or Safari. The app must be served over **HTTPS** or **localhost**.

## Getting started

```bash
npm install
npm run dev       # Dev server at http://localhost:5173
npm run build     # Production build → dist/
npm run preview   # Preview production build locally
```

## Features

### NTN Dongle tab

- **Dongle model** — A1, A2, A1+ or A2+ (A2/A2+ carry a LoRa module; A1+/A2+ use the Nordic nRF9151 modem). Saved to `localStorage`.
- **Driver mode selector** — Auto Detect (tries native OS driver first, falls back to WebUSB polyfill), Native (OS CH340/CP210x driver), or Polyfill (WebUSB). Switch before connecting.
- **NTN Configuration** — Set APN, remote IP, remote port, and local port. Config is saved to `localStorage`. After applying, unplug and replug the dongle.
- **Device information** — Reads model name, firmware version, and IMSI from the connected dongle.
- **NTN Dongle Status** — Tracks module AT ready, SIM ready, network registered, IP ready, and socket ready.
- **Signal metrics** — RSRP (dBm) and SINR (dB), re-read at the dongle's CSQ/GPS refresh interval.
- **Log viewer** — Timestamped TX/RX serial communication log with clear button.

### Satellite Modem (A1+ / A2+)

Shown on the NTN Dongle tab for nRF9151 models. The firmware type (GEO or LEO) is read from `NVER` on connect.

- **Network Mode** — Shows the current mode (`NSTATE`) and switches between LEO, GEO, GNSS and Terrestrial. Modes the firmware can't run are struck out (no LEO on GEO firmware, no GEO on LEO firmware).
- **Modem Readiness** — `NCHECK` checklist: provider resolved, GNSS fix, satellite orbit (TLE), NTN registered, socket open.
- **Auto Message Queue** — Add messages (`MOBUF`), set sends per pass (`MOCOUNT`), check or clear the queue. Messages are sent on each LEO pass.
- **LEO Satellite** — Looks up Sateliot orbit data (TLE) from CelesTrak (only `SATELIOT_<id>` satellites are supported), or accepts a pasted TLE, then sends it to the dongle (`SET_TARGET_ID` + `SET_TLE`).
- **Advanced Diagnostics** (collapsed) — Run any modem query and send raw commands.

Modem Readiness, Auto Message Queue and *Send to Dongle* are only enabled on LEO firmware.

### LoRa Configuration tab

- Connects to a LoRa module via USB serial using PCIE2 AT commands.
- Reads and writes frequency, spreading factor, and channel plan.
- Manages up to 16 LoRa device slots (add, delete, list).

### Tab switching

Switching tabs automatically disconnects the active serial port before the new tab initialises. Both tabs cannot hold a serial connection simultaneously.

## Deployment

`vite.config.ts` sets `base: './'` for GitHub Pages compatibility. Deploy the `dist/` folder to any static host.

## Troubleshooting

**Device picker is empty after clicking Serial Connect**

- If you have installed CH340 or CP210x drivers, switch **Driver Mode** to **Native**.
- If that fails, try **Polyfill** (WebUSB).
- On macOS, check **System Settings → Privacy & Security** for blocked driver extensions.
