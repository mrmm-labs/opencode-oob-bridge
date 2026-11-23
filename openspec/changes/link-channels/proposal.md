## Why

The relay link takes one connection on `/link` and replaces an older one with a new one. A second client of the link, such as another local service that wants to talk to the relay, would evict the chat bridge, and the bridge would reconnect and evict it back in a loop. Both clients need their own path and their own secret.

## What Changes

- **Named channels.** The relay also accepts a WebSocket upgrade on `/link/<name>` for each channel the operator configures. The HMAC scheme is the one of `/link`. One connection at a time per channel. The chat bridge on `/link` is untouched and is never evicted by another channel.
- **Path-bound proof.** The upgrade proof is signed for the path it is sent to, and every frame on a channel carries the channel name in its signed body. A proof or a frame for another channel is refused.
- **Per-channel secrets.** Each channel has its own secret and optional key. The bridge secret does not open a named channel and a channel secret does not open `/link`. The nonce cache is shared across channels.
- **Client.** `LinkClient` stops reconnecting when the relay closes it with code 4000 (replaced), and signs the upgrade for the path of its URL.
- **Shutdown.** `Link.close()` closes every upgraded socket.
- **Slow channel consumer.** A channel whose send buffer grows past a limit is closed.
- **Transport only.** The relay hands frames of a channel to an in-process consumer API (`onChannel`, `sendTo`). The relay ships no consumer and no HTTP ingress for channels.

## Capabilities

### Added Capabilities

- `relay-link`: named channels, their isolation, the 4000 rule for clients, shutdown and the send-buffer limit.

## Out of scope

- An HTTP ingress for channels (`POST /ch/<name>/...` forwarded to the connected client). It needs its own auth, limits and routes; it goes in a follow-up spec, `link-channel-ingress`.
- A client class for named channels. A client composes `sealUpgrade`, `seal` and `Verifier` from `frame.ts`.
- Flow control for the chat bridge link (see design).
- The Helm chart of the relay deployment, which lives elsewhere. This repo only documents the variables.

## Impact

- **Existing surface audit.** `relay/src/link.ts` (`upgrade`, `adopt`, `close`), `src/link/frame.ts` and its copy in `relay/src/shared` (`sealUpgrade`, `Verifier.openUpgrade`), `src/link/client.ts` (`connect`, `gone`), `relay/src/config.ts`, `relay/src/main.ts`, `relay/src/metrics.ts`, `relay/README.md`.
- **Deploy order.** A relay without this change answers 404 to `/link/<name>`. Deploy the relay first, then any client of a channel. The chat bridge works with both relays.
- **Definition of done.** `pnpm test` and `pnpm --dir relay test` end `fail 0`, the chat bridge suite is unchanged and passes, `openspec validate --all --strict` passes.
