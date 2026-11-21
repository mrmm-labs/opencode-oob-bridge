## Why

The relay link moved from the tailnet to a LAN-only internal ingress with TLS. The bridge refuses any link host that is not loopback or on the tailnet, so it refuses that URL. A reverse proxy in front of the relay also makes a second lock on the upgrade useful.

## What Changes

- **`link.allowHosts`**: exact hostnames the link may dial over `wss://`, besides loopback and the tailnet. Default empty.
- **`link.key` and `LINK_KEY`**: an optional pre-shared key, sent as `X-OOB-Link-Key`. The relay checks it before the WebSocket upgrade; the HMAC handshake is still required.

## Capabilities

### Added Capabilities

- `relay-link`: the allowed hosts and the pre-shared key.

## Impact

- **Existing surface audit.** `src/link/hosts.ts`, `src/link/client.ts`, `src/link/start.ts`, `src/config.ts`, `src/link/frame.ts` (and its copy in `relay/src/shared`), `relay/src/config.ts`, `relay/src/link.ts`, `relay/src/main.ts`.
