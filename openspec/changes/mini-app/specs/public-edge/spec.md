## ADDED Requirements

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

A request whose source is a configured edge proxy SHALL be accepted only with init data. A bearer token from such a source SHALL be refused. A request from another private address MAY use either scheme.

#### Scenario: Bearer through the proxy

- **WHEN** a request from an edge proxy address carries the bearer token
- **THEN** it is refused with 401

### Requirement: The client address is trusted only from the edge

The bridge SHALL take the client address from `X-Forwarded-For` only when the connection comes from a configured edge proxy, and SHALL ignore the header otherwise. After 10 failed authentications a minute from one client address it SHALL answer 429 for five minutes.

#### Scenario: Spoofed header

- **WHEN** a direct client sends `X-Forwarded-For`
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

The edge SHALL forward only `/app/`, `/v1/` and `GET /healthz` to the bridge and SHALL refuse every other path. It SHALL pass the `Authorization` header unchanged, limit request bodies to 256 KiB, and rate-limit by client address.

#### Scenario: Other path

- **WHEN** a request for `/admin` reaches the edge
- **THEN** it is refused and not forwarded

### Requirement: The edge reaches the bridge over a private path

The bridge SHALL be reached from the edge over a private network address that only the proxy can use, and the bridge SHALL listen on that address only. The bridge SHALL NOT open a connection to the edge for this path.

#### Scenario: Bridge address

- **WHEN** the bridge is configured for the Mini App
- **THEN** it listens on a private address and on no public one

### Requirement: The stream passes through the edge

The edge SHALL NOT buffer the event stream and SHALL allow an idle timeout of at least 120 seconds. The bridge SHALL send a comment line at least every 25 seconds.

#### Scenario: Five quiet minutes

- **WHEN** the stream carries no events for five minutes
- **THEN** it stays open because of the comment lines

### Requirement: The edge holds no secret for this path

The edge SHALL NOT hold the bot token for the Mini App path, SHALL NOT authenticate on the bridge's behalf, and SHALL NOT log the `Authorization` header or the query string.

#### Scenario: Edge logs

- **WHEN** a request with init data passes the edge
- **THEN** the edge's logs hold no init data

### Requirement: The edge can be checked

The repository SHALL provide `pnpm run edge:check <url>` that checks an unauthenticated request is refused, init data of another user is refused, stale init data is refused, `/app/` answers, `/admin` is refused and the stream stays open for five minutes.

#### Scenario: Check passes

- **WHEN** the check runs against a correct edge
- **THEN** every item passes and the command exits 0
