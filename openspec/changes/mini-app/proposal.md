## Why

A chat is a poor place to browse sessions, read a conversation tail, review a diff or answer a form with many fields. A Telegram Mini App can, and with the core API it is just another client. The operator wants it hosted on his own infrastructure with public HTTPS. The hosting side is built by the operator, so this change defines exactly what that side must provide.

## What Changes

- **A Mini App** served by the bridge itself under `/app/`: sessions, session detail, questions and forms, permissions (when allowed), resume, stop, model and agent switch, new session, the overnight plan and the digest.
- **A public edge contract**: a relay with a public HTTPS hostname (a public tunnel) that serves only the Mini App assets and its API, and answers 404 to everything else. The relay reaches the bridge over the `relay-link` change: the bridge dials out to the relay over the tailnet, so the laptop opens no listening port. `core.bind: tailscale` stays as the fallback. The relay holds no bot token and no bearer token; it only pre-filters init data.
- **Authentication at the bridge**: Telegram init data, verified with an HMAC over the bot token, accepted only for the operator's user id and only when fresh. A request that arrives through the relay link, or from the edge proxy in the fallback mode, is accepted with that scheme only. No secret is embedded in the Mini App: a key in client-side script is readable by anyone, so none is used.
- **Launching**: a menu button and `web_app` button in a private chat, and a `t.me` direct link button in group topics (inline `web_app` buttons work only in private chats).

## Capabilities

### New Capabilities

- `mini-app`: the app, its screens, launch, live updates and limits.
- `public-edge`: what the hosting must provide, how the bridge authenticates the Mini App, and the checks that prove it.

### Modified Capabilities

None.

## Out of scope

Building the hosting side (hostname, proxy, tunnel, and the receiver of the dead-man switch), a native app, push notifications from the Mini App, offline use, voice notes, more than one operator.

## Impact

- **Existing surface audit.** `core-api` (the actions, SSE, bearer scheme), `relay-link` (the transport), `command-menu`, `turn-card`, `forms`, `overnight` and `digest` (their data), the bot token handling of `src/token.ts`, `package.json` `files` (the app is shipped in the package).
- **Supersession.** None.
- **Downstream.** The operator builds the relay from `public-edge` and `relay-link`, and the dead-man receiver from `deadman`. `relay-link` ships first.
- **Estimate.** Agent 4 days. Operator 1 hour (BotFather app registration, the hostname).
- **Definition of done.** `pnpm test` ends `fail 0`, `pnpm run edge:check` passes against the real hostname, and a recorded session on a phone opens from a topic link, lists sessions and answers a question.
