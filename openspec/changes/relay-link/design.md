## Context

The Mac and the cluster share a tailnet. The relay on the cluster has a tailnet-only address (a Tailscale ingress Service) and a public hostname (a public tunnel) that serves only the Mini App. A request from a phone arrives at the relay and must reach the bridge, which holds the bot token.

## Decisions

### D1. The bridge dials out

The bridge opens a WebSocket to the relay's tailnet address and reconnects with the same backoff as the channels. It opens no listening port for this path. The relay sends request frames down the connection and the bridge sends response frames back. A WebSocket client is in the host runtime, so there is no new dependency. A spike in the first task checks that, and falls back to a held `fetch` pair only if the host lacks one.

### D2. One secret, a MAC on every frame

The secret is shared by the bridge and the relay. Each frame, and the HTTP upgrade that opens the link, carries `ts`, `nonce` and `mac`, where `mac` is the HMAC-SHA256 of `direction`, `ts`, `nonce` and the body. The direction (`up` or `down`) stops a frame being reflected. The receiver refuses a time stamp more than 60 seconds off, a nonce it saw inside that window, and a bad MAC (constant-time compare). A secret is cheap to share and rotate, and a captured frame is useless a minute later. Tailscale already encrypts the path, so the link does not add TLS.

### D3. Tailnet hosts only

The link refuses a URL whose host is not loopback, in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, or a `*.ts.net` name. A misconfigured public host would otherwise carry a MAC-only channel across the internet without TLS.

### D4. Same handler, same gates

A request frame is run through the core API handler in process, so every gate (init data, permissions, rate limits, `permissions.remote`) is the one the HTTP API has. The link counts as the edge: a request on it accepts init data only, never the bearer token, and its client address is the `client` field of the frame, which the relay fills from the tunnel's client-address header. Only `/app/`, `/v1/` and `GET /healthz` are served.

### D5. The init data is verified at the bridge

The relay cannot verify init data without the bot token, and the token stays on the Mac. The relay only pre-filters (well-formed, the operator's user id, fresh `auth_date`) to drop junk early. The bridge decides.

### D6. The heartbeat is a frame

The `deadman` payload is sent as a `beat` frame every interval and answered with an `ack` frame. The relay alerts when no beat arrives for N minutes, so an outage of the link is an alert. That includes a tailnet failure on the Mac while the bridge still runs. The relay cannot tell the two apart, and for the operator both mean the phone cannot reach the Mac. The HTTPS heartbeat remains for anyone who wants an independent path.

## Risks

- A leaked secret lets someone with tailnet access talk to the bridge. The frames still need valid init data for any action, and the tailnet ACL should allow only the relay to the Mac. Rotation is a restart on both sides.
- A relay that is down looks like an outage to the phone only. The bridge keeps retrying and reports the link in `/oob status`.
- Clock skew beyond 60 seconds breaks the link. Both ends run NTP, and the refusal names the skew.
