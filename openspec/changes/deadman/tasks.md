## 1. Bridge side

- [ ] 1.1 Add `src/deadman.ts` with the timer, payload and sender (no new dependency). Verify: unit tests with a receiver double for payload shape, interval and the https rule.
- [ ] 1.2 Add the health self-check on the snapshot code path. Verify: tests for each reason code, including a snapshot with an `undefined` key giving `snapshot_invalid`.
- [ ] 1.3 Send `stopping` on `/oob restart` and on dispose, and heartbeat only from the owner. Verify: tests with two instances in one process send one stream of heartbeats.
- [ ] 1.4 Never block the bridge on a failed send, and log once per change of outcome. Verify: a test with an unreachable receiver leaves status answering.
- [ ] 1.5 Config keys `deadman.url`, `deadman.token`, `deadman.intervalSeconds` and README section. Verify: `config.test.ts` and `readme.test.ts`.

## 2. Contract

- [ ] 2.1 Write a reference receiver double under `src/deadman.test-util.ts` that implements section D5. Verify: contract tests: silence alerts once, stopping extends the window, degraded needs two beats, recovery notice, no `getUpdates` call.
- [ ] 2.2 Run a real kill test. Verify: recorded output of the double alerting after the bridge process is killed and again after it restarts.
