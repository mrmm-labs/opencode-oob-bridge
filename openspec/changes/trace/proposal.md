## Why

When a Telegram message goes missing the operator cannot tell where: the poll, the queue, the routing, the host, the reply. The log held one line per update and nothing for what the bridge sent, there were no counters of lost messages, and a stall left no trace until the watchdog fired.

## What Changes

- **One trace per Telegram update and per message the bridge sends**, with an id, timed steps and an outcome. The id of an update follows the session's turn, so its cards, stream edits and reply share it.
- **A log line for each inbound and outbound outcome with the trace id.** `log.level` is `warn`, `info` (default) or `debug` (also each step).
- **Spans and metrics** on the existing OTLP export: inbound received, delivered, refused, dropped and retried, outbound sent and failed, queue depth, last good poll and send, API latency and errors by code.
- **`/oob trace [n]` and `/trace [n]`** list the last updates and sends with their path; `/oob status` shows the counters and the last error.
- **A Grafana dashboard** for the metrics in `docs/`.

## Capabilities

### Added Capabilities

- `tracing`: traces, log levels, metrics and the trace views.

## Out of scope

Tracing ntfy and the other connectors, persisting traces across a restart, and a pull-based metrics endpoint.

## Impact

- **Existing surface audit.** `src/trace.ts` (new), `src/otel.ts` (`emit`), `src/connectors/telegram.ts`, `src/bridge.ts`, `src/control.ts`, `src/commands.ts`, `src/menu.ts`, `src/config.ts`.
