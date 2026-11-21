# public-edge Specification

## Purpose
TBD - created by archiving change mini-app. Update Purpose after archive.

## Requirements

### Requirement: The bridge accepts Telegram init data from the operator only

The API SHALL accept `Authorization: tma <init data>` as a credential. The bridge SHALL verify the hash with the HMAC of the bot token, compare in constant time, accept only the operator's user id, and refuse init data older than `miniApp.maxAgeSeconds` (default 3600). A failure SHALL answer 401, or 403 for another user, with no detail.

#### Scenario: Valid init data

- **WHEN** a request carries fresh init data of the operator
- **THEN** it is accepted

#### Scenario: Stale init data

- **WHEN** init data is two hours old
- **THEN** the answer is 401

#### Scenario: Another user

- **WHEN** init data names another user and its hash is valid
- **THEN** the answer is 403

### Requirement: The public path accepts init data only

A request that arrives through the relay link SHALL be accepted only with init data, and a bearer token on it SHALL be refused. A direct request on the tailnet SHALL be accepted only with the bearer token. No secret SHALL be embedded in the Mini App script.

#### Scenario: Bearer through the link

- **WHEN** a request frame on the relay link carries the bearer token
- **THEN** it is refused with 401

### Requirement: The client address is trusted only from the edge

The bridge SHALL take the client address from the `client` field of a relay-link frame and SHALL NOT read any header for it. After 10 failed authentications a minute from one client address it SHALL answer 429 for five minutes.

#### Scenario: Spoofed header

- **WHEN** a request on the link carries `X-Forwarded-For`
- **THEN** the header is ignored

#### Scenario: Guessing

- **WHEN** one client address fails authentication 11 times in a minute
- **THEN** it gets 429 for five minutes

### Requirement: The edge exposes a public HTTPS hostname

The hosting SHALL provide a hostname with a valid certificate, TLS 1.2 or newer, a redirect from http to https and a strict transport security header. The hostname SHALL be registered with BotFather as the Mini App address.

#### Scenario: Plain http

- **WHEN** the hostname is requested over http
- **THEN** it redirects to https

### Requirement: The edge forwards a short list of paths

The edge SHALL serve only `/app/`, `/v1/` and `GET /healthz`, SHALL answer 404 to every other path and SHALL NOT forward it. It SHALL pass the `Authorization` header unchanged, limit request bodies to 256 KiB, and rate-limit by client address.

#### Scenario: Other path

- **WHEN** a request for `/admin` reaches the edge
- **THEN** it is refused and not forwarded

### Requirement: The edge reaches the bridge over a private path

The edge SHALL reach the bridge only over the tailnet. The preferred way is the relay link: the bridge connects out to the relay's tailnet-only address, and the relay SHALL NOT dial the bridge. In the fallback mode the bridge SHALL listen on a tailnet address only (`core.bind: tailscale`) and the edge SHALL connect to it. The bridge SHALL NOT listen on a public address in either mode.

#### Scenario: Preferred mode

- **WHEN** a link is configured
- **THEN** the bridge opens no listening port for the Mini App

#### Scenario: Fallback mode

- **WHEN** the bridge is bound to `tailscale`
- **THEN** it listens on a tailnet address and on no public one

### Requirement: The edge pre-filters init data

The edge SHALL refuse a request to `/v1/` that carries no well-formed init data, init data that names another user than the operator, or an `auth_date` older than the configured maximum age. It SHALL NOT claim to have verified the hash unless it holds a verify-only token and has checked it. The bridge verifies every request in any case.

#### Scenario: Missing init data

- **WHEN** a request to `/v1/sessions` carries no init data
- **THEN** the edge refuses it with 401 and does not use the link

#### Scenario: Another user

- **WHEN** init data names another user
- **THEN** the edge refuses it with 403

### Requirement: The edge says when the Mac is offline

When no link is up the edge SHALL answer 503 to `/app/` and `/v1/`, with a static page for `/app/` that says the Mac is offline.

#### Scenario: Link down

- **WHEN** a phone opens the app while the bridge is not connected
- **THEN** it sees that the Mac is offline

### Requirement: The stream passes through the edge

The edge SHALL NOT buffer the event stream and SHALL allow an idle timeout of at least 120 seconds. The bridge SHALL send a comment line at least every 25 seconds.

#### Scenario: Five quiet minutes

- **WHEN** the stream carries no events for five minutes
- **THEN** it stays open because of the comment lines

### Requirement: The edge holds no secret for this path

The edge SHALL NOT hold the bearer token and SHALL NOT authenticate on the bridge's behalf. It MAY hold a verify-only copy of the bot token to check init data hashes, which it SHALL NOT use to call Telegram. It SHALL NOT log the `Authorization` header or the query string. Besides the link secret and that token it holds nothing for this path.

#### Scenario: Edge logs

- **WHEN** a request with init data passes the edge
- **THEN** the edge's logs hold no init data

### Requirement: The edge can be checked

The repository SHALL provide `pnpm run edge:check <url>` that checks an unauthenticated request is refused, a bearer token is refused, init data of another user is refused, stale init data is refused, `/app/` answers, `/admin` answers 404 and the stream stays open for five minutes.

#### Scenario: Check passes

- **WHEN** the check runs against a correct edge
- **THEN** every item passes and the command exits 0
