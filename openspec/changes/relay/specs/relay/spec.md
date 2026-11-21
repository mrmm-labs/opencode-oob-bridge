## ADDED Requirements

### Requirement: The relay serves a short list of paths

The public port SHALL serve `/app` and `/v1` with their sub-paths, `GET /healthz` and `POST /beat`, and SHALL answer 404 to every other path and 405 to `/beat` with another method. It SHALL NOT forward any other path.

#### Scenario: Other path

- **WHEN** a request asks for `/admin`
- **THEN** the answer is 404 and nothing is sent on the link

#### Scenario: Beat with GET

- **WHEN** `GET /beat` arrives
- **THEN** the answer is 405 with `Allow: POST`

### Requirement: The relay checks init data before it forwards

A request to `/v1` SHALL carry `Authorization: tma <init data>`. The relay SHALL answer 401 for missing, malformed or stale init data, 403 for another user than the operator, and 503 for every request while no operator is configured. When it holds a verify token it SHALL also refuse a wrong hash with 401. It SHALL NOT claim a hash was checked when it holds no token.

#### Scenario: Wrong user

- **WHEN** init data names another user
- **THEN** the answer is 403 and no frame is sent

#### Scenario: Tampered hash with a verify token

- **WHEN** one field of the init data changed
- **THEN** the answer is 401

### Requirement: Requests travel as frames and nothing else

The relay SHALL forward a request as one `req` frame holding the method, path, the headers `authorization`, `content-type`, `accept` and `last-event-id`, a body up to `MAX_BODY_BYTES` (default 256 KiB), and the client address. It SHALL answer 413 for a larger body, stream the response frames to the phone in order, and send a `close` frame when the phone leaves.

#### Scenario: Oversized body

- **WHEN** a body of 300 KiB is posted
- **THEN** the answer is 413 and no frame is sent

#### Scenario: Phone leaves

- **WHEN** the phone closes a stream
- **THEN** a `close` frame goes to the bridge

### Requirement: The relay says when the Mac is offline

When no link is up the relay SHALL answer `/v1` with 503 and `/app` with 503 and a static page that says the Mac is offline. When the link drops, requests in flight SHALL end.

#### Scenario: No link

- **WHEN** a phone opens `/app/` and no bridge is connected
- **THEN** it gets 503 and the offline page

### Requirement: The link face accepts one authenticated bridge

The link port SHALL accept a WebSocket upgrade on `/link` only when it carries a time stamp within 60 seconds, a nonce not seen before and a valid MAC, and SHALL verify every frame the same way with the direction `up`. A new link SHALL replace the old one. A refused upgrade or frame SHALL be dropped and counted without its body.

#### Scenario: Replayed upgrade

- **WHEN** the same upgrade headers are used twice
- **THEN** the second is refused

#### Scenario: Second bridge

- **WHEN** a second valid link connects
- **THEN** the first is closed

### Requirement: The relay limits clients

The relay SHALL limit requests per client address (default 20 a second, burst 40), requests in flight per client (default 20) and in total (default 16), and answer 429 or 503. The client address SHALL come from the configured header, or the socket address when none is configured.

#### Scenario: A burst

- **WHEN** one client sends 100 requests at once
- **THEN** the excess is answered 429

### Requirement: The relay is the dead-man receiver

The relay SHALL take a heartbeat from a `beat` frame (and answer an `ack` frame) and from `POST /beat` with a bearer token, and either path SHALL count as alive. It SHALL stay silent until the first heartbeat after it starts. It SHALL call `sendMessage` only, never `getUpdates` or `setWebhook`.

#### Scenario: Restart of the relay

- **WHEN** the relay starts
- **THEN** it sends nothing until a heartbeat arrives

### Requirement: The relay alerts once per outage

The relay SHALL alert after three missed intervals (five minutes after a `stopping` beat) and after two consecutive `degraded` beats, naming the reasons. It SHALL send one alert per outage, remind every 30 minutes and send one recovery message.

#### Scenario: Silence

- **WHEN** no heartbeat arrives for three intervals after an `up` beat
- **THEN** one alert is sent and none again for 30 minutes

#### Scenario: Planned stop

- **WHEN** a `stopping` beat arrives and the next one comes within five minutes
- **THEN** no alert is sent

### Requirement: The relay exposes three metrics

The metrics port SHALL serve `oob_bridge_last_heartbeat_timestamp_seconds`, `oob_bridge_state{state}` and `oob_bridge_consecutive_missed`, and nothing else on that port.

#### Scenario: Scrape

- **WHEN** `/metrics` is requested
- **THEN** the three metrics are in the answer

### Requirement: The relay logs no credential

The relay SHALL NOT log the `Authorization` header, a query string, a body, a token or a secret, and SHALL log a request as a route name, a status and a duration only.

#### Scenario: Request with init data

- **WHEN** a request with init data passes the relay
- **THEN** the log line holds neither the init data nor the path's query

### Requirement: The image is built from the folder alone

The repository SHALL hold a Dockerfile whose build context is `relay/`. The image SHALL run as user 65532, work with a read-only root file system and take every deployment detail from environment variables. CI SHALL build it for linux/amd64 and linux/arm64 and SHALL NOT push it anywhere on a pull request or a branch.

#### Scenario: Read-only run

- **WHEN** the image runs with a read-only root file system as user 65532
- **THEN** `GET /healthz` answers 200

### Requirement: An optional push to a private registry never shows it

A release job SHALL push the image to a registry only when the secrets `RELAY_REGISTRY`, `RELAY_REGISTRY_USER` and `RELAY_REGISTRY_TOKEN` are set, tagged with the release tag. Its first step SHALL mask the registry value and the image reference, and every command output SHALL pass through a filter that replaces them, so neither appears in a log, a summary or an annotation.

#### Scenario: Secrets unset

- **WHEN** the secrets are not set
- **THEN** the job pushes nothing and prints nothing about a registry

#### Scenario: Output that names the registry

- **WHEN** a command prints the image reference
- **THEN** the log shows `***` in its place

### Requirement: Private details stay out of the repository

CI SHALL fail when a tracked file or a commit message of the change matches a word of the deny-list file or of the `HYGIENE_DENYLIST` secret, and SHALL print the file and line only, never the matched word. A registry host listed in the deny-list SHALL fail the check like any other word.

#### Scenario: A deny-listed word

- **WHEN** a tracked file holds a deny-listed word
- **THEN** the build fails and the log names the file and line without the word
