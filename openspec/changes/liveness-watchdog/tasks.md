## 1. Liveness

- [x] 1.1 `pollOkAt`, `sendOkAt`, `silentMs` on the channel status and the snapshot. Verify: `watchdog.test.ts` wedged-loop and send-time tests.
- [x] 1.2 `/oob status` lines. Verify: typecheck; the lines read the snapshot fields tested above.

## 2. Watchdog

- [x] 2.1 Watchdog with `bridge_stalled` and restart. Verify: `watchdog.test.ts` restart-once and ignore tests.
- [x] 2.2 Start and stop with the bridge. Verify: `server.test.ts` restart and stop tests.

## 3. Dead-man

- [x] 3.1 `poll_stalled` reason. Verify: `watchdog.test.ts` degraded check.
