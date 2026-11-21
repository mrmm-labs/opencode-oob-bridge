## Context

Telegram Mini Apps are web pages opened inside Telegram. They receive **init data**: a signed query string that names the user and carries an `auth_date`. The Bot API says `web_app` inline buttons work **only in private chats**, so a forum group topic can open the app only through a `t.me` direct link with `startapp`. Direct links need the app to be registered with BotFather.

## Decisions

### D1. The bridge serves the app

The static files ship in the npm package and the bridge serves them under `/app/`. One origin, one version: the app cannot be newer than the API it calls. The edge is then a pure reverse proxy.

### D2. No third-party script

The app reads its launch parameters (init data, theme) from the URL hash and loads no script from another origin. A strict content security policy forbids it, and allows framing by Telegram's web clients only.

### D3. Authentication happens at the bridge

The bridge holds the bot token, so it verifies init data itself: the secret key is the HMAC-SHA256 of the token with the key `WebAppData`, and the hash is the HMAC of the sorted `key=value` lines. It compares in constant time, checks the user id against the paired operator, and rejects init data older than `miniApp.maxAgeSeconds` (default 3600). The bot token never leaves the Mac.

### D4. Two schemes, two doors

Direct tailnet clients may use the bearer token or init data. A request whose source is a configured edge proxy (`core.edgeProxies`) may use **only** init data, so a leaked bearer token is useless through the public hostname. Behind the proxy the real client address comes from `X-Forwarded-For`, trusted only when the source is an edge proxy.

### D5. The edge contract is checkable

Everything the edge must do is a requirement with a check, run by `pnpm run edge:check <url>`: unauthenticated requests are refused, init data of the wrong user is refused, stale init data is refused, the stream survives five minutes, and nothing outside `/app/` and `/v1/` is reachable.

### D6. What the app can do

Exactly the core actions, with the same refusals. Destructive actions (stop, undo, resume) ask for confirmation. Permission buttons follow `permissions.remote` and the approval levels.

## Risks

- A public hostname leads to a laptop. Mitigation: D3 and D4, path allow-list, rate limits at the edge and at the bridge, the private path only from the proxy.
- Init data replay within its lifetime. Mitigation: a one-hour default, short-lived only for read screens, and a confirmation for destructive actions.
