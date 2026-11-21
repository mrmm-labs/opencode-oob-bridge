## Context

Telegram Mini Apps are web pages opened inside Telegram. They receive **init data**: a signed query string that names the user and carries an `auth_date`. The Bot API says `web_app` inline buttons work **only in private chats**, so a forum group topic can open the app only through a `t.me` direct link with `startapp`. Direct links need the app to be registered with BotFather.

## Decisions

### D1. The bridge serves the app

The static files ship in the npm package and the bridge serves them under `/app/`. One origin, one version: the app cannot be newer than the API it calls. The relay is then a pure relay: the assets travel over the link like the API, and when the link is down the relay answers 503 with a static page that says the Mac is offline.

### D2. No third-party script

The app reads its launch parameters (init data, theme) from the URL hash and loads no script from another origin. A strict content security policy forbids it, and allows framing by Telegram's web clients only.

### D3. Authentication happens at the bridge

The bridge holds the bot token, so it verifies init data itself: the secret key is the HMAC-SHA256 of the token with the key `WebAppData`, and the hash is the HMAC of the sorted `key=value` lines. It compares in constant time, checks the user id against the paired operator, and rejects init data older than `miniApp.maxAgeSeconds` (default 3600). The bot token never leaves the Mac, so the relay cannot verify the hash. It pre-filters instead (init data present, the operator's user id, a fresh `auth_date`) to drop junk before it reaches the link, and the bridge decides. No secret is placed in the Mini App script, because a key shipped to a browser is public; init data is the only credential the page can carry.

### D4. Two schemes, two doors

A direct client on the tailnet uses the bearer token only. A request that arrives through the relay link uses **only** init data, so a leaked bearer token is useless through the public hostname. The real client address is the `client` field of a link frame. There is no second public path: a reverse proxy in front of the core API (an earlier fallback) is not built, because the link needs no listening port and a proxy would need one.

### D5. The edge contract is checkable

Everything the edge must do is a requirement with a check, run by `pnpm run edge:check <url>`: unauthenticated requests are refused, init data of the wrong user is refused, stale init data is refused, the stream survives five minutes, and nothing outside `/app/` and `/v1/` is reachable.

### D6. What the app can do

Exactly the core actions, with the same refusals. Destructive actions (stop, undo, resume) ask for confirmation. Permission buttons follow `permissions.remote` and the approval levels.

### D7. Transport details the app relies on

The app sends init data as `Authorization: tma <init data>`, the scheme the relay pre-filters. A browser `EventSource` cannot set a header, so the stream is read with `fetch` and parsed in the app, with `Last-Event-ID` on reconnect. The app has no build step: plain ES modules and one stylesheet, served as they are. Telegram's own script is not loaded: the app posts `web_app_ready` and `web_app_expand` itself and reads the theme from the hash and from `theme_changed` events.

### D8. Launch is configured, never guessed

The bridge opens nothing in Telegram until `miniApp.url` (the public `/app/` address) is set. `miniApp.link` (the `t.me` direct link of the registered app) adds the button in group topics.

## Risks

- A public hostname leads to a laptop. Mitigation: D3 and D4, a path allow-list at the relay and the bridge, rate limits at both, and a transport the bridge dials out on (`relay-link`), so nothing listens for the internet.
- Init data replay within its lifetime. Mitigation: a one-hour default, short-lived only for read screens, and a confirmation for destructive actions.
