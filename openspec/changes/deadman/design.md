## Context

The existing health signals all live inside the process (`/oob status`, the sidebar, `bridge.log`). A TUI that cannot reach the bridge says "bridge offline", but nobody is looking at it at night.

## Decisions

### D1. Receiver: a small relay service, not a staleness alert in the metrics stack

Two designs were considered for the receiver.

- **A. Small relay service.** It receives heartbeats, keeps the time of the last one, and calls `sendMessage` itself when they stop.
- **B. A heartbeat metric plus a Prometheus staleness rule plus an Alertmanager Telegram receiver.**

Chosen: **A**, for these reasons.

1. B needs something to turn a heartbeat into a metric (a push gateway or an exporter). That is a service anyway, so B has more parts, not fewer.
2. An Alertmanager Telegram receiver cannot say what we need to say: last version seen, last health reasons, how long, and a recovery message. It sends one templated text.
3. A relay can also expose its own metric (`last_heartbeat_timestamp`) so dashboards still work, which makes A a superset.
4. A dead-man's switch must be as simple as possible. A relay is about a hundred lines of stateless logic plus one timestamp.
5. The relay must not depend on the thing it watches or on the private network to the Mac. It runs outside the Mac and is reached over the public internet with a bearer token.

The relay's own death is watched by the existing metrics stack on the hosting side (not specified here).

### D2. Transport

HTTPS POST with a bearer token. The URL must be https, except loopback for tests. The token is a secret reference, never in the config file as text. The heartbeat uses the public internet path, not the private path the core API uses, so a failure of the private network does not hide the bridge's own death.

### D3. Payload

`{ v, id, seq, at, state, reasons, version, pid, channels }`. `state` is `up`, `degraded` or `stopping`. `channels` is a map from channel id to connected boolean. No session titles, paths, chat ids, usernames or message text. `at` is for display only: the receiver judges silence with its own clock.

### D4. Self-check

Each heartbeat first runs the check. It builds the snapshot the TUI would get, passes it through the JSON-only rule of the host (no `undefined` keys), confirms the RPC is registered in the hub, confirms the owner lock is held by this pid, and reads each enabled channel's `connected`. Any failure gives `degraded` with reason codes (`snapshot_invalid`, `rpc_missing`, `lock_lost`, `channel_down:<id>`). A check that throws gives `degraded` with `check_failed`.

### D5. Receiver behaviour (contract)

- Alert when no heartbeat arrived for `missed × interval` (default 3 × 30 s). After a `stopping` heartbeat the window is 5 minutes.
- Alert on the first `degraded` heartbeat that lasts two beats in a row.
- One alert per outage, a reminder every 30 minutes, and a recovery message on the first `up` beat.
- `sendMessage` only. Never `getUpdates`, never `setWebhook`, so the bridge stays the only consumer and Telegram does not answer 409.

## Risks

- The Mac sleeping looks like a crash. The alert text says "no heartbeat" and does not guess the cause.
- A leaked heartbeat token lets someone send fake "up" beats. Mitigation: the token is revocable at the receiver and carries no other right.
