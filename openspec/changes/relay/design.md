## Context

The phone reaches the relay over public HTTPS. The Mac reaches it over a private network, dialing out. The relay sits between and holds as little as it can.

## Decisions

### D1. One process, three ports

Port 8080 serves the public face and `POST /beat`. Port 8081 serves only the link WebSocket and is never routed publicly. Port 9090 serves `/metrics` and nothing else. Separate ports let a proxy expose the first, a private network the second and a scraper the third, with no path rules to get wrong.

### D2. The frame code is copied, and a test keeps the copies equal

`src/link/frame.ts` and `initdata.ts` hold the MAC, the nonce cache and the init data check for the bridge. The relay is built from `relay/` alone, so it holds copies in `relay/src/shared/`, refreshed by `pnpm --dir relay sync`. A test in the bridge's suite fails when a copy differs, so the two ends cannot drift.

### D3. The relay verifies init data when it can

With a verify-only bot token the relay checks the hash, the user, and the age before a request reaches the link. Without it, the relay checks shape, user and age only and says so at start. The token is read once, never logged, and used for nothing else: the relay has no code that calls Telegram except `sendMessage` with the alert bot's own token. The bridge still verifies every request, because the link is a second door that could be reached with a stolen link secret.

### D4. Bodies and rate limits belong to the relay

A proxy that buffers bodies also buffers event streams, so the 256 KiB cap is enforced here, by counting bytes as they arrive. Requests per second and requests in flight are limited per client address, taken from a configured header. The proxy's own limits stay as a second layer.

### D5. A stream idle for 25 seconds gets a comment line

The bridge sends keep-alive comments already. The relay adds one when a stream has been idle for `SSE_KEEPALIVE_SECONDS`, so a tunnel that closes idle connections never sees a quiet one even if the bridge is busy.

### D6. A restart forgets and waits

The dead-man state is in memory. After a restart the relay says nothing until the first heartbeat, because it cannot know whether the bridge was alive before. This is documented so an outage during a relay restart is not a surprise.

### D7. No image is published, and no private detail is in the repository

The repository ships source, a Dockerfile and docs. A deployer builds the image. The optional release job exists for the owner of a private registry: its host, user and token are secrets, GitHub does not mask variables, and a value derived from a secret (the host of `host/project`, the image reference) is not masked unless the job masks it. The job masks both first, passes every command output through a filter and uses no action that renders the reference in a summary. A hygiene step greps tracked files and commit messages against a deny-list and prints `file:line` only.

## Risks

- The relay is internet-facing. It holds the link secret, the heartbeat token, the alert bot token, and optionally the verify token. Rotation is a restart. The README says which of these can do what.
- A wrong client-address header makes every client look the same and turns the per-client limit into a global one. The README says to set it to a header the proxy overwrites.
- Alerts depend on Telegram being reachable from the relay. A failure is logged and retried at the next reminder.
