## Why

If the bridge stops, nothing tells the operator: no question arrives, no alert arrives, and silence looks like "all quiet". The bridge cannot report its own death. An outside watcher can. The failure of v0.13.0 and v0.13.1 (the TUI showed the bridge offline while the process ran) is the same shape: the bridge looked fine from inside and was useless from outside.

## What Changes

- The bridge sends a small authenticated heartbeat over HTTPS to a configured receiver every 30 seconds.
- The heartbeat carries a **health state** from a self-check that runs the same code path as the TUI status call, so a bridge that is up but cannot answer reports itself as degraded.
- A graceful stop or restart sends a `stopping` heartbeat first, so a planned restart does not alert.
- A **receiver contract** says what the watcher does when heartbeats stop: it alerts the operator on Telegram by `sendMessage` only, once per outage, and sends a recovery message. The bridge stays the only `getUpdates` consumer.

## Capabilities

### New Capabilities

- `deadman`: the heartbeat, its payload and health self-check, and the receiver contract.

### Modified Capabilities

None.

## Out of scope

Building or deploying the receiver (the operator builds it from this contract), alerting by any channel other than Telegram, watching sessions rather than the bridge, an uptime history UI.

## Impact

- **Existing surface audit.** `src/server.ts` (hub, owner election, boot and stop), `src/control.ts` (snapshot, probe timers), `src/token.ts` (secret references), `src/logger.ts`. The heartbeat is one more timer in the owner's boot; the self-check reuses the snapshot builder.
- **Supersession.** None.
- **Downstream.** The overnight mode (`afk-overnight`) relies on it. The operator builds the receiver from the contract.
- **Estimate.** Agent 0.5 day. Operator 1 hour (receiver, token, Telegram chat id).
- **Definition of done.** `pnpm test` ends `fail 0` with the deadman tests, and a recorded run shows a receiver double alerting after the bridge process is killed and again after it recovers.
