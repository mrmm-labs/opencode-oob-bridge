## Context

Spans already existed per prompt and per push, but with a trace id derived from the session, so an update and the reply it caused were not one trace and an update had no id at all.

## Decisions

- **A module-level `Traces`** holds the last 200 traces in memory, the counters and the telemetry it was attached to at each boot. It outlives a bridge restart in the process, so counters do not reset on `/oob restart`.
- **Context by AsyncLocalStorage.** The code that handles an update runs inside its trace, so every Telegram call made for it is a step without passing the trace around.
- **The outbound trace links by session.** When a prompt is delivered, its trace is remembered for the session. A push or reply for that session reuses its id and takes the update span as parent; the link ends at the turn's final card.
- **Counted once.** An update is counted `received` when polled and `delivered`, `refused` or `dropped` when it is done, not on each retry; a retry adds `retried`.
- **Levels.** `warn` logs failed outcomes only, `info` every outcome (default), `debug` adds a `trace_step` line per step.
- **No text.** Only ids, kinds, outcome, a reason cut at 80 characters, and durations are recorded.

## What a client may rely on

- `/trace` and `/oob trace` never show message text.

Left to the collector: the metric names after conversion to Prometheus.
