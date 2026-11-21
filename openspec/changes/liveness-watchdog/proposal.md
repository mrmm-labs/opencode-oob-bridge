## Why

The bridge can stop doing its job while the server stays up and nothing is logged. A receive loop stuck on one call (a hung secret command, a host call that never returns) leaves `connected: true` from its last good poll, the dead-man heartbeat keeps saying `up`, and the operator learns it from the silence.

## What Changes

- **Liveness per channel.** Each channel reports when it last answered a poll (`pollOkAt`), when it last accepted a send (`sendOkAt`) and, while its receive loop runs, how long since that loop last made a step (`silentMs`).
- **Watchdog in the server half.** Every 30 s it checks the channels. A loop silent for more than 150 s logs `bridge_stalled` (channel, silence, last poll, last send, step) and restarts the bridge. The restart keeps the process lock, so there is still one poller.
- **Dead-man tied to the loop.** A channel whose loop is silent past the limit makes the heartbeat `degraded` with the reason `poll_stalled:<channel>`.
- **`/oob status`** shows the last poll, the last send and a warning for a silent loop.

## Capabilities

### Modified Capabilities

- `server-bridge`: the watchdog.
- `deadman`: the stalled-loop reason.

## Out of scope

Detecting a stall of the send path (nothing says a send is due), a restart of the whole OpenCode server, traces and metrics.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`loop`, `call`, `status`), `src/connectors/types.ts`, `src/server.ts` (`boot`), `src/deadman.ts` (`selfCheck`), `src/control.ts`, `src/rpc.ts`, `src/view.ts`, `src/menu.ts`.
