## Why

The Mini App and the dead-man alert both need something that is reachable when the Mac is not: a public HTTPS address for the phone and a watcher that notices silence. The `relay-link` and `mini-app` changes specify the two halves that sit on the Mac and on the phone. Nothing yet specifies, builds or ships the program in the middle.

## What Changes

- A relay program under `relay/`: a public HTTPS face for the Mini App, a private link face the bridge dials out to, and a dead-man receiver, in one process.
- The relay checks Telegram init data before it forwards anything: shape, operator user id, age, and the hash when it holds a verify-only token. The bridge keeps checking too.
- It forwards `/app/` and `/v1/` as frames over the link, caps bodies at 256 KiB, limits requests per client, answers 503 with a "Mac offline" page when no link is up, and never calls `getUpdates`.
- It receives the heartbeat on the link (`beat` frames) and on `POST /beat`, runs the dead-man state machine and alerts through `sendMessage` of a second bot.
- It exposes three metrics on its own port.
- A Dockerfile that builds from `relay/` alone (linux/amd64 and linux/arm64), a docker-compose and a Kubernetes example, and a self-hosting README. The repository publishes no image: you build it yourself.
- CI builds the image without pushing, runs the tests, and fails on a deny-listed word without printing it. An optional release job pushes to a private registry named only by secrets, and keeps its name out of every log.
- Bridge side, from `relay-link`: the `link` config, the outbound client, request frames through the core API handler, init data as the only credential on the link, `beat`/`ack` frames, and the link state in the status.

## Capabilities

### New Capabilities

- `relay`: the relay program, its faces, its limits, its alerts, its image and its docs.

### Modified Capabilities

None. The `relay-link` and `mini-app` changes stay as written, except that the edge now MAY hold a verify-only token (see the design).

## Out of scope

The Mini App itself (`mini-app`), any deployment of the image (the operator's own infrastructure repository), a second link at once, TLS termination in the relay (the proxy in front of it does that), and cluster-specific manifests.

## Impact

- **Existing surface audit.** `src/core/api.ts` (credential check, edge mode, path list), `src/deadman.ts` (a link path next to the HTTPS one), `src/config.ts` (`link`), `src/server.ts` (start and stop the link), `src/control.ts` and `src/rpc.ts` (link state), `.github/workflows/`.
- **Supersession.** The `mini-app` design said the edge cannot verify the hash because the token stays on the Mac. The operator chose to let the relay verify with a verify-only token held next to it. The relay never uses that token to call Telegram.
- **Estimate.** Agent 6 hours. Operator 30 minutes (secrets, one registration with BotFather, a deployment).
- **Definition of done.** `pnpm test` and `pnpm --dir relay test` end `fail 0`, the image builds for both architectures in CI, and a bridge test talks to a real relay through the link.
