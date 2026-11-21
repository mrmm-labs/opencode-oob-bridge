# Self-host the relay

The relay is a small Node service that sits between your phone and the bridge on your computer. It has three jobs:

1. **Public edge.** It serves the Telegram Mini App over HTTPS and rejects anything that is not from you before the bridge sees it.
2. **Private link.** The bridge dials _out_ to the relay over a WebSocket. Requests from the phone travel down that connection. Your computer opens no inbound port.
3. **Dead-man receiver.** It watches the bridge's heartbeat and sends you a Telegram message when the heartbeat stops.

This folder holds the source, a Dockerfile, tests and generic deployment examples. No image is published: you build it yourself and push it to a registry you control.

## Who needs it

You need the relay if you want the Mini App to work when your phone is not on your tailnet, or if you want an alert when your computer goes silent that does not depend on the computer itself.

You do not need it for the Telegram chat, the `/oob` commands or the HTTPS dead-man's switch. The bridge works without it, and `core.bind: tailscale` stays as a fallback for reaching the core API from a device on your tailnet.

## Architecture

```text
phone (Telegram Mini App)
   │  HTTPS
   ▼
┌───────────────────────────── relay ──────────────────────────────┐
│ :8080  public   pre-filter → init data check → forward → /beat   │
│ :8081  link     WebSocket, HMAC + nonce, one bridge at a time    │
│ :9090  metrics  Prometheus text, keep it private                 │
│        dead-man state machine → Telegram sendMessage             │
└───────────────────────────────────────────────────────▲──────────┘
                                                        │ outbound WebSocket,
                                                        │ opened by the bridge
                                                  bridge on your computer
                                                  (checks init data again)
```

The public port and the link port are separate listeners. Publish only 8080. Keep 8081 and 9090 on a private network.

## Build it yourself

```sh
docker build -t <your-registry>/oob-relay:<tag> relay/
docker push <your-registry>/oob-relay:<tag>
```

For a registry that serves both amd64 and arm64 hosts:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <your-registry>/oob-relay:<tag> --push relay/
```

The image runs as user 65532 with a read-only root file system, so it needs no writable path.

## Configuration

Every setting is an environment variable. A secret may instead be read from a file: set `NAME_FILE` to a path (for example a mounted secret) and leave `NAME` unset.

| Variable                    | Default                    | Meaning                                                                                                                                                                |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINK_SECRET`               | required                   | Shared key for the link, at least 32 characters. Also `LINK_SECRET_FILE`.                                                                                              |
| `OPERATOR_USER_ID`          | unset                      | Your numeric Telegram user id. Unset or not a number: every `/v1` request is refused with 503.                                                                         |
| `TELEGRAM_BOT_TOKEN_VERIFY` | unset                      | Token of the bot that owns the Mini App, used only to check the init data signature. Unset: the relay checks shape, user and age, and the bridge checks the signature. |
| `MAX_AGE_SECONDS`           | 3600                       | Oldest init data accepted, by its `auth_date`.                                                                                                                         |
| `HEARTBEAT_TOKEN`           | unset                      | Bearer token for `POST /beat`, at least 32 characters. Unset: `/beat` is off.                                                                                          |
| `TELEGRAM_BOT_TOKEN`        | unset                      | Bot that sends dead-man alerts. Only `sendMessage` is called, never `getUpdates`.                                                                                      |
| `TELEGRAM_CHAT_ID`          | unset                      | Chat that receives the alerts. Either of the two unset: alerts are only logged.                                                                                        |
| `TELEGRAM_API_BASE`         | `https://api.telegram.org` | Telegram API base, for tests or a local Bot API server.                                                                                                                |
| `PORT`                      | 8080                       | Public listener.                                                                                                                                                       |
| `LINK_PORT`                 | 8081                       | Link listener (`/link` only).                                                                                                                                          |
| `METRICS_PORT`              | 9090                       | Metrics listener (`/metrics` only).                                                                                                                                    |
| `BIND_ADDRESS`              | `0.0.0.0`                  | Address for all three listeners.                                                                                                                                       |
| `LINK_MAX_SKEW_SECONDS`     | 60                         | Clock difference tolerated on the link (1 to 60).                                                                                                                      |
| `MAX_BODY_BYTES`            | 262144                     | Largest request body, 256 KiB at most.                                                                                                                                 |
| `SSE_KEEPALIVE_SECONDS`     | 25                         | Comment line sent on idle event streams.                                                                                                                               |
| `REQUEST_TIMEOUT_SECONDS`   | 60                         | How long a request waits for the bridge.                                                                                                                               |
| `CLIENT_IP_HEADER`          | unset                      | Header your proxy sets with the real client address, for rate limits. Unset: the socket address is used.                                                               |
| `RATE_LIMIT_PER_SECOND`     | 20                         | Sustained requests per client.                                                                                                                                         |
| `RATE_LIMIT_BURST`          | 40                         | Burst allowance per client.                                                                                                                                            |
| `BEAT_RATE_PER_SECOND`      | 5                          | Limit on `POST /beat`.                                                                                                                                                 |
| `MAX_IN_FLIGHT_PER_CLIENT`  | 20                         | Open requests per client.                                                                                                                                              |
| `MAX_IN_FLIGHT_TOTAL`       | 16                         | Open requests in all, matching what the bridge accepts.                                                                                                                |
| `INTERVAL_SECONDS`          | 30                         | Heartbeat interval the bridge uses; silence is judged against it.                                                                                                      |
| `MISSED_BEATS`              | 3                          | Intervals of silence before the alert.                                                                                                                                 |
| `STOPPING_GRACE_SECONDS`    | 300                        | How long a clean stop is tolerated before it counts as silence.                                                                                                        |
| `REMINDER_SECONDS`          | 1800                       | Gap between repeated alerts while silent.                                                                                                                              |

The relay logs one JSON line per event. Warnings for unset values appear at start-up.

## Bots: a second one, or the same

The dead-man alerts can come from your main bot (set `TELEGRAM_BOT_TOKEN` to its token) or from a second bot made only for alerts. A second bot means the main bot token never reaches the public relay for sending. Either way the relay never calls `getUpdates`, so it cannot steal messages from the bridge.

`TELEGRAM_BOT_TOKEN_VERIFY` is the token of the bot that owns the Mini App. It is used only to verify signatures. Leave it out if you would rather keep that token off the relay; the bridge then does the signature check alone.

To register the Mini App, message BotFather: `/newapp`, pick the bot, and give it the public HTTPS URL of the relay.

## Pair the bridge with the relay

1. Make a key, at least 32 characters:

   ```sh
   openssl rand -base64 48
   ```

2. On the relay, store it as `LINK_SECRET` (an environment secret or a file named by `LINK_SECRET_FILE`).
3. On the bridge machine, store the same value in a secret store and point the config at it. On macOS:

   ```sh
   security add-generic-password -a "$USER" -s oob-relay-link -w
   ```

   ```jsonc
   "link": {
     "url": "ws://<relay-link-address>:8081/link",
     "secret": { "command": ["security", "find-generic-password", "-s", "oob-relay-link", "-w"] }
   }
   ```

   The link URL must be loopback, a tailnet address or a `*.ts.net` name. The bridge refuses anything else.

4. Restart the bridge. `/oob status` shows `Relay link: up`.

To rotate the key, change it on both sides and restart both. A bridge with the old key stays down until it is updated.

## Heartbeats

With a link, the bridge sends each heartbeat as a frame and counts the `ack` as its answer. The HTTPS `POST /beat` endpoint (bearer `HEARTBEAT_TOKEN`) also works and answers 405 to other methods.

Metrics on the metrics port: `oob_bridge_last_heartbeat_timestamp_seconds`, `oob_bridge_state{state}` and `oob_bridge_consecutive_missed`.

Dead-man state is in memory. After a relay restart it stays quiet until the first heartbeat arrives.

## Security model

- **Init data is checked at both ends.** The relay verifies the Telegram signature, the age (`MAX_AGE_SECONDS`) and the user id. The bridge verifies them again, so a compromised relay cannot act as you.
- **The link is authenticated.** The upgrade and every frame carry an HMAC keyed by the shared secret, a timestamp and a nonce. Replays and frames in the wrong direction are dropped. A second bridge replaces the first.
- **A narrow public surface.** Only `/app/`, `/v1/`, `GET /healthz` and `POST /beat` are answered. Anything else is 404 before it touches the link.
- **Bearer tokens never cross.** The bridge refuses its own bearer token on the link; only init data is accepted there.
- **No `getUpdates`.** The relay sends with `sendMessage` only.
- **Limits.** 256 KiB request bodies, per-client rate limits, a cap on open requests, and a block after repeated failed checks.
- **Nothing is stored.** No database, no files, and message text is not logged.

## Deploy

Examples with placeholder names are in [`deploy/`](deploy/):

- [`docker-compose.yml`](deploy/docker-compose.yml)
- [`kubernetes.yaml`](deploy/kubernetes.yaml): Deployment, Service and Ingress

Terminate TLS in front of port 8080 and expose only that port. Reach 8081 from your tailnet or another private network.

## Upgrade and roll back

Build and push a new tag, point the deployment at it and restart. The bridge reconnects by itself. To roll back, point the deployment at the previous tag. There is no state to migrate. The link frame format is versioned with the bridge release; update both together when a release says the link changed.

## Keeping your registry private

The repository ships source only. The release workflow can push an image to a registry you choose, but only when these **secrets** are set on your fork or copy:

| Secret                 | Meaning                                   |
| ---------------------- | ----------------------------------------- |
| `RELAY_REGISTRY`       | Registry host, or host and project.       |
| `RELAY_REGISTRY_USER`  | Registry user or robot account.           |
| `RELAY_REGISTRY_TOKEN` | Registry password or token.               |
| `RELAY_IMAGE_PATH`     | Optional image path. Default `oob-relay`. |

The image is tagged with the release tag. Use secrets, never variables: GitHub does not mask variables in logs, and it never passes secrets to workflows from forks. The push script masks the registry, the full reference and the credentials, filters every command's output and prints no summary.

## Keeping private details out of the repo

CI runs `scripts/hygiene.sh` on every change. It fails when a file or commit message contains a word from `.github/hygiene-denylist.txt` or from the `HYGIENE_DENYLIST` secret (one word per line). It prints only the file and line, never the word. Put your own host names, domain, tailnet name and user names in the secret, not in the file.

## Develop

```sh
pnpm --dir relay install
pnpm --dir relay test
pnpm --dir relay typecheck
```

The relay holds copies of `frame.ts` and `initdata.ts` from the bridge (`src/link/`) in `src/shared/`, so that it builds from this folder alone. `pnpm --dir relay sync` refreshes them, and a bridge test fails when they differ.
