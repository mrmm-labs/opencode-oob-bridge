## 1. Link

- [ ] 1.1 Spike: the host has a WebSocket client that can set upgrade headers. Verify: a script connects to a local test server, and the result is in the PR.
- [ ] 1.2 `link` config (`url`, `secret` reference), tailnet-host check. Verify: tests for loopback, tailnet, `*.ts.net` accepted and a public host refused.
- [ ] 1.3 Frame MAC with direction, time window, nonce cache. Verify: tests for a valid frame, a tampered body, a stale time stamp, a replayed nonce and a reflected frame.
- [ ] 1.4 Outbound connection, reconnect with backoff, one link per owner instance. Verify: a test kills the server and sees the reconnect, and two instances open one link.
- [ ] 1.5 Request frames through the core API handler, init data only, `client` as the address, path list, size and in-flight limits. Verify: tests for a bearer token on the link (401), `/admin` (404), an oversized body and 17 requests in flight.
- [ ] 1.6 Streaming responses as chunk frames, the keep-alive comment passes. Verify: a test holds a stream five quiet minutes with a fake clock.

## 2. Heartbeat

- [ ] 2.1 `beat` and `ack` frames from the `deadman` payload, `acknowledged()` from the ack. Verify: a test sees one beat per interval and the acknowledgement reflected in the overnight preflight.
- [ ] 2.2 `/oob status` and the sidebar show the link (up, down, since when). Verify: sidebar and menu tests, README row.

## 3. Check

- [ ] 3.1 `pnpm run link:check <url>` against a relay: connects, a request is answered, a replay is refused. Verify: passes against a local relay in a test.
