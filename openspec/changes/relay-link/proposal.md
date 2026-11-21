## Why

The Mini App is reached from a phone through a public HTTPS hostname, and the bridge runs on a laptop. The first design had the hosting reach the bridge over the tailnet, so the bridge had to listen on a port. The operator prefers the other direction: the bridge connects out to a relay, so the laptop opens no listening port for this path, and the same connection carries the dead-man heartbeat.

## What Changes

- **An outbound link.** With `link.url` set, the owning bridge opens one connection to the relay at a tailnet address and keeps it open. The relay sends it requests from the Mini App, and the bridge answers them from its own core API in process.
- **A pre-shared secret.** Every message on the link carries a time stamp, a nonce and an HMAC of the body. The secret is in the Mac Keychain on one side and in an encrypted secret on the cluster on the other. The link refuses a host that is not on the tailnet.
- **The heartbeat on the link.** The bridge sends the dead-man heartbeat as a frame on the link. The relay alerts on Telegram when none arrives for N minutes. The HTTPS heartbeat of `deadman` keeps working.
- **`core.bind: tailscale` stays** as the fallback: the relay reaches the bridge instead of the bridge reaching the relay.

## Capabilities

### New Capabilities

- `relay-link`: the outbound link, its authentication, what may travel on it, and the heartbeat frame.

### Modified Capabilities

- `deadman`: the heartbeat may travel on the link.

## Out of scope

The relay itself (a homelab service), the Mini App (change `mini-app`), more than one Mac, a link to anything but the relay.

## Impact

- **Existing surface audit.** `core-api` (the actions and the init-data scheme are reused through the same handler), `deadman` (payload and `acknowledged()`), `src/token.ts` (secret references), `server.ts` (one owner per machine).
- **Supersession.** None. The tailnet bind of `core-api` stays as the fallback mode.
- **Downstream.** `mini-app` builds on it. The relay is built from this contract and `public-edge`.
- **Estimate.** Agent 1.5 days. Operator 30 minutes (secret in the Keychain and in the cluster secrets, the relay address).
- **Definition of done.** `pnpm test` ends `fail 0`, a recorded run of the bridge against a local relay shows a request answered, a replayed frame refused, and the heartbeat acknowledged.
