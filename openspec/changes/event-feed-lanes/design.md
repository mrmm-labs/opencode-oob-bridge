## Context

`boot()` in `src/server.ts` reads `ctx.event.subscribe` in a `for await` loop whose body awaited `sessions.ensure(id)` before it applied the event and passed it on. `ensure` calls `ctx.session.get`, which has no time limit. The host reloads and disposes location instances often (18 loads of this plugin in 25 minutes around the failure), and a session of a disposed location may never answer.

## Decisions

- **Lanes, not a global queue.** The loop only dispatches. A lane is a promise chain per session id; it is dropped once its last event ends. Events with no session id run at once. Order inside a session is kept because `apply`, the core and the bridge see the events of one session in the order they arrived.
- **Bounded `session.get`.** 8 seconds, then the cache simply has no entry; `routed()` already handles a session with no facts. This also bounds `host.session()`, which the reply path calls.
- **Why not a restart watchdog yet.** A silent stream cannot be told from an idle one without another signal. This change removes the one cause found; a probe that compares the database's busy sessions with the events seen is a separate change.

## What a client may rely on

- One unresponsive session delays only its own events, by at most 8 seconds per `session.get`.

Left to the host: answering `session.get`.
