# NTN Dongle — AT Mode Flow

This document explains how the **"NTN Dongle - AT"** connection mode actually runs in code, cross-referenced against the manual pseudo-code in [`AT_Command_Flow_pg54-55.txt`](AT_Command_Flow_pg54-55.txt) (NTN_RMM-T1 AT Command User Manual, §7.9 "IP Network Attach Procedure" and §7.10 "Generate IP Data Traffic over UDP").

## Overview

AT mode is an alternative to the existing Modbus-based dongle connection (`hooks/useDongleConnection.ts`). It talks to the module directly with AT commands instead of Modbus RTU frames:

- **`hooks/useDongleConnectionAT.ts`** — owns the serial port, the AT command request/response queue, URC handling, and the connect/status/socket state machine.
- **`utils/atProtocol.ts`** — pure parsing helpers used by the hook: line framing/terminator detection (`OK`/`ERROR`/`+CME ERROR`), quoted-CSV param splitting, tagged-line extraction (e.g. pulling the value out of `!CNWSTA: 0,5`).

Both modes share the same `DongleStatus` / `DongleData` / `NTNConfig` types from `types.ts` and the same `App.tsx` UI (`StatusBadge` cards, RSRP/SINR, LoRa data, log viewer) — AT mode just populates that shared shape differently (see [Status field mapping](#status-field-mapping) below).

## Connect sequence (`initDongle`)

`initDongle()` in `hooks/useDongleConnectionAT.ts:487-550` runs once per connect and mirrors the §7.9 attach procedure step by step. It opens with the same detach → store APN → re-attach cycle used by [Config apply](#config-apply-applyntnconfig), using the previously-saved APN (falling back to the manual's documented default, `vpnus.mono`, via the `DEFAULT_APN` constant) since no explicit config is passed in at connect time:

| Step | Command / wait | Code | Effect |
|---|---|---|---|
| 1 | `AT!CNWATT=0` — detach | L490-492 | implicitly RF OFF |
| 2 | `AT!CPDNDT="IP","<apn>"` — store APN (saved config, else `DEFAULT_APN` = `vpnus.mono`) | L495-498 | stores PDN settings in NVRAM |
| 3 | `AT!CNWATT=1` — re-attach | L501-503 | attaches using the `AT!CPDNDT` settings just stored; implicitly RF ON |
| 4 | `ATI` — read model/FW | L506 | populates `data.modelName` / `data.fwVersion` |
| 5 | `AT!CIMSI` | L513-522 | populates `data.imsi`; sets `status.moduleAtReady` |
| 6 | wait for `+CPIN: READY` URC | `waitForSimReady`, L390-397 | sets `status.simReady` (passive — no query is sent, see [URC handling](#urc-handling)) |
| 7 | poll `AT!CNWSTA?` until `stat` is `1` or `5` | `waitForNetworkRegistered`, L400-416 | sets `status.networkRegistered` |
| 8 | wait for `+IP:` URC (falls back to `AT+IPCONFIG` if it already fired) | `waitForIPReady`, L420-436 | sets `status.downlinkReady` |
| 9 | `AT!CPDNDT?` — read current APN | L534-543 | populates `data.currentConfig.apn` |
| 10 | `autoConnectSocket()` → `establishSocket()` | L546, L439-467 | opens the UDP socket — uses saved remote IP/port/APN if previously Applied, else the manual's §7.10 example defaults (`DEFAULT_REMOTE_IP` = `172.31.79.129`, `DEFAULT_REMOTE_PORT` = `7000`) |
| 11 | `pollStatus()` + `startPolling()` (3 s interval) | L548-549 | begins periodic RSRP/SINR + status refresh |

## Config apply (`applyNTNConfig`)

`applyNTNConfig(config)` (L552-595) is invoked from the "Apply" button in `components/ConfigPanel.tsx`, and follows the §7.9 detach/store/re-attach cycle:

1. `AT!CNWATT=0` — detach (implicitly RF OFF); clears `networkRegistered` / `downlinkReady` / `socketReady`
2. `AT!CPDNDT="IP","<apn>"` — store the new APN in NVRAM
3. `AT!CNWATT=1` — re-attach using the new PDN settings (implicitly RF ON)
4. `waitForNetworkRegistered()` / `waitForIPReady()` — wait for registration and IP assignment again, since the module was detached
5. `establishSocket(config)` — (re)open the UDP socket with the new remote IP/port

## UDP socket establishment (`establishSocket`)

`establishSocket(config)` (L439-467) implements §7.10:

1. If a socket is already open, `AT+ESOCL=<id>` closes it first (L440-444).
2. `AT+ESOC=1,2,1` creates a UDP socket; the `+ESOC=<id>` response line is parsed for the socket id (L446-449).
3. If `config.localPort` is set, `AT+ESOB=<id>,<localPort>` binds it (L454-458).
4. `AT+ESOCON=<id>,<remotePort>,"<remoteIp>"` connects the socket (L461-462).
5. On success, sets `status.socketReady = true` and `data.configApplied = true` (L465-466).

## URC handling

`handleURC(line)` (L238-246) processes unsolicited lines that arrive when no command is pending:

| URC | Effect |
|---|---|
| `+CPIN: ...` | `status.simReady = line.includes('READY')` |
| `*MATREADY:...` | `status.moduleAtReady = line.includes(':1')` |
| `+IP: xxx.xxx.xxx.xxx` | `status.downlinkReady = true` |

## Status field mapping

Both connection modes populate the same 5-field `DongleStatus` (`types.ts`), but derive it differently:

| Field | AT mode (this doc) | Modbus mode (`useDongleConnection.ts`) |
|---|---|---|
| `moduleAtReady` | `AT!CIMSI` success, or `*MATREADY:1` URC | bit 0 of one status register (`processIncomingDataWithContext`) |
| `simReady` | `+CPIN: READY` URC (passive) | bit 1 of the same register |
| `networkRegistered` | `AT!CNWSTA?` polled until `stat` = 1 or 5 | bit 2 of the same register |
| `downlinkReady` | `+IP:` URC, fallback `AT+IPCONFIG` | bit 3 of the same register |
| `socketReady` | `AT+ESOCON` success in `establishSocket` | bit 4 of the same register |

Modbus mode reads all 5 bits atomically from a single register in one request. AT mode assembles the same 5 fields incrementally, from multiple command responses and URCs arriving over the session — so the two modes reuse the exact same `StatusBadge` UI in `App.tsx`, but arrive at "NTN Ready" (all 5 true) via different code paths and timing.

## Parity with the manual pseudo-code

The pg54-55 pseudo-code sends `AT!CNWATT=0` (RF off, implicitly detaching) *before* `AT!CPDNDT` (store PDN settings), then `AT!CNWATT=1` to re-attach with the new settings:

```
send  AT!CNWATT=0     // detach, RF OFF
send  AT!CPDNDT=...   // store PDN settings
send  AT!CNWATT=1     // attach, RF ON
```

Both `initDongle` (steps 1-3, L490-503) and `applyNTNConfig` (L565-579) now follow this cycle exactly. `initDongle` uses the previously-saved APN from `localStorage` (via `loadPersistedNTNConfig()`), falling back to the manual's documented default `DEFAULT_APN = 'vpnus.mono'` (`hooks/useDongleConnectionAT.ts:12`) when nothing has been saved yet; `applyNTNConfig` uses the APN the user just entered in `ConfigPanel`.

§7.10's `AT+ESOC=1,2,1` / `AT+ESOCON=1,7000,"172.31.79.129"` example is likewise reproduced as the fallback in `autoConnectSocket()` (`hooks/useDongleConnectionAT.ts:472-486`) via `DEFAULT_REMOTE_IP = '172.31.79.129'` / `DEFAULT_REMOTE_PORT = '7000'`, so a UDP socket is opened on every connect (matching "NTN Ready if all status are Ready" in the manual) even before the user has ever filled in `ConfigPanel`.

## Related files

- [`hooks/useDongleConnectionAT.ts`](hooks/useDongleConnectionAT.ts) — connection/status/socket state machine
- [`utils/atProtocol.ts`](utils/atProtocol.ts) — AT line parsing helpers
- [`AT_Command_Flow_pg54-55.txt`](AT_Command_Flow_pg54-55.txt) — source manual pseudo-code (§7.9, §7.10)
