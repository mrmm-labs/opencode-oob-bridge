## Context

Today the bridge talks to the host in three places: Telegram commands (`commands.ts`), the TUI RPC ops (`control.ts`, `rpc.ts`) and the push logic (`bridge.ts`). They each pick the host calls they need. The server plugin API (`ctx.session`) offers only part of what the full host client has: list, create, get, remove, switchAgent, switchModel, prompt, generate, command, compact, synthetic, interrupt, update, move, context. It has **no** message list, diff, revert, fork or form reply. `ctx.permission` (list, get, reply), `ctx.vcs` (diff, status) and `ctx.event` exist.

## Decisions

### D1. One module, three layers

`src/core/views.ts` builds view-models, `src/core/actions.ts` holds the action registry, `src/core/api.ts` serves HTTP and SSE. Telegram, the TUI RPC and the HTTP API are adapters over the same registry. A test enumerates the registry and fails when an adapter calls the host by another route.

### D2. Data source ladder

A view-model field is filled from the first source that can answer, and says which one:

1. the server plugin context (`session.get`, `session.context`, `permission.list`, `vcs.diff`);
2. the event cache the bridge already keeps from `event.subscribe`;
3. the read-only database probe already used for stuck sessions (`sqliteProbe`);
4. a relay through an attached TUI, which has the full client (diff by session, revert, form reply).

A field no source can fill is returned as `{ "unavailable": "<reason>" }`, never as an empty value. `/v1/meta` lists which actions and fields are available now.

### D3. API surface (v1)

| Route                                   | Purpose                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| `GET /v1/meta`                          | API version, bridge version, available actions and fields |
| `GET /v1/status`                        | Owner, channels, away state, open prompts                 |
| `GET /v1/sessions`                      | Summaries, newest activity first, paged                   |
| `GET /v1/sessions/{id}`                 | Detail: summary, tail, todos, diff summary, prompts       |
| `GET /v1/sessions/{id}/messages`        | Conversation tail, `limit` and `before`                   |
| `GET /v1/sessions/{id}/diff`            | Diff summary, or the patch with `Accept: text/x-diff`     |
| `POST /v1/sessions`                     | New session in a listed project                           |
| `POST /v1/sessions/{id}/actions/{name}` | One action, JSON body                                     |
| `GET /v1/events`                        | SSE stream                                                |

### D4. Versioning

The path carries the major version. Within `/v1` only additive changes are made: new routes, new optional fields, new event types. A client ignores fields it does not know. A breaking change ships as `/v2` beside `/v1` for at least one minor release.

### D5. Listening

Off unless `core.bind` names an address. The address must be loopback, or inside the Tailscale ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), or a name that resolves only to such addresses. `0.0.0.0`, `::` and public addresses are refused at startup with a log line. No tailnet address available: no listener, and `/oob status` says why. The bridge never dials out for this API.

### D6. Authentication

Every request carries `Authorization: Bearer <token>`. The token is 256 bits, created on first start, stored in the state directory with mode `0600` (a secret reference may replace the file), compared in constant time, and replaced with `/oob core token rotate` in the TUI. A failed request answers `401` with no detail. The Mini App adds a second scheme (`tma`, Telegram init data) in its own change; both go through one authentication function.

### D7. What leaves the process

Every text field passes the secret filter and the `redact` setting. A session that matches `chat.deny` is listed with `blocked` and no tail, and its prompt actions are refused. Permission replies stay refused unless a later change allows them (`permissions.remote`).

### D8. Events

SSE with `id` per event, `Last-Event-ID` resume from a bounded ring (500 events), a full snapshot event when the id is too old, and a comment keep-alive every 25 seconds.

## Risks

- A field the server context cannot fill degrades to `unavailable`. Mitigation: D2 and `/v1/meta`.
- A listener on a laptop is a new attack surface. Mitigation: D5, D6, owner-only listener, tests that refuse wildcard binds.
- The refactor touches code every feature uses. Mitigation: move adapters one at a time, behind the existing tests (`chat.test.ts`, `commands.test.ts`, `control.test.ts`).
