# core-api Specification

## Purpose
TBD - created by archiving change core-api. Update Purpose after archive.

## Requirements

### Requirement: The core exposes sessions as view-models

The core SHALL expose, for every session of the instance, a summary (id, title, agent, model, variant, project, state, watch mode, chat setting, last activity, pending prompt count, stuck state) and a detail (the summary plus conversation tail, todos, diff summary, pending questions and pending permissions).

#### Scenario: Summary of a working session

- **WHEN** a client asks for the sessions
- **THEN** each session has a state of working, idle, failed or suspended and its watch and chat settings

#### Scenario: Detail with a pending question

- **WHEN** a session waits for a question and a client asks for its detail
- **THEN** the detail lists the question with its options and its id

### Requirement: A view-model says where each field came from

Each field that is not always available SHALL be filled from the first source that can answer, SHALL name that source, and SHALL be returned as unavailable with a reason when no source can answer. The core SHALL NOT return an empty value in place of an unavailable one.

#### Scenario: No diff source

- **WHEN** no source can produce the diff summary of a session
- **THEN** the field is `{"unavailable": "<reason>"}` and the rest of the detail is returned

#### Scenario: Capabilities listed

- **WHEN** a client reads the meta route
- **THEN** it lists which actions and fields are available now

### Requirement: Every client uses one action set

The core SHALL provide one set of actions: answer a question, reply to a permission, resume, stop, prompt, compact, undo, switch model, switch agent, create a session, set watch, set chat. The Telegram chat, the TUI RPC and the HTTP API SHALL reach the host only through these actions.

#### Scenario: Same result from two clients

- **WHEN** the same action is sent from Telegram and from the HTTP API
- **THEN** the host receives the same call and the same refusal rules apply

#### Scenario: Adapter bypass

- **WHEN** an adapter calls the host without going through the registry
- **THEN** the architecture test fails

### Requirement: Permission replies are refused by default

The reply-to-permission action SHALL be refused, with a reason, unless a policy allows it. With no policy configured it SHALL be refused for every client.

#### Scenario: Reply with no policy

- **WHEN** a client sends a permission reply and no policy is configured
- **THEN** the action is refused with a reason and the host is not called

### Requirement: The API is versioned HTTP and SSE under /v1

The server bridge SHALL serve the view-models and actions as HTTP under `/v1` and a live event stream as SSE at `/v1/events`. Within `/v1` only additive changes SHALL be made, and a breaking change SHALL be served as `/v2` beside `/v1` for at least one minor release.

#### Scenario: Unknown field

- **WHEN** a v1 client receives a field it does not know
- **THEN** it can ignore the field and keep working

#### Scenario: Meta route

- **WHEN** a client reads `/v1/meta`
- **THEN** it gets the API version and the bridge version

### Requirement: The API listens only on a private address

The API SHALL be off unless an address is configured. The address SHALL be loopback or inside the Tailscale ranges. The bridge SHALL refuse a wildcard or public address at startup, log why, and not listen. With no usable address there SHALL be no listener and the status SHALL say why.

#### Scenario: Wildcard bind

- **WHEN** the configured address is `0.0.0.0` or `::`
- **THEN** the bridge does not listen and logs the refusal

#### Scenario: Tailscale keyword

- **WHEN** the configured address is `tailscale` and a local interface has an address in `100.64.0.0/10`
- **THEN** the API listens on that address only, and the status shows it

#### Scenario: Tailscale keyword with no tailnet

- **WHEN** the configured address is `tailscale` and no local interface is in the Tailscale ranges
- **THEN** there is no listener and the status says that no tailnet address was found

#### Scenario: Tailnet address

- **WHEN** the configured address is in `100.64.0.0/10`
- **THEN** the API listens on that address only

### Requirement: Every request is authenticated

Every request to the API SHALL carry a bearer token of at least 256 bits, compared in constant time. A request without a valid credential SHALL get 401 with no detail. The token SHALL be kept with mode 0600 or behind a secret reference, and SHALL be replaceable from the TUI.

#### Scenario: No token

- **WHEN** a request has no Authorization header
- **THEN** the answer is 401 with no detail

#### Scenario: Rotated token

- **WHEN** the token is rotated in the TUI
- **THEN** the old token is refused at once

### Requirement: The event stream can be resumed

The event stream SHALL give each event an id, keep the last 500 events, resume from `Last-Event-ID`, send a full snapshot when the id is older than the kept events, and send a comment line at least every 25 seconds.

#### Scenario: Reconnect

- **WHEN** a client reconnects with the id of the last event it saw
- **THEN** it receives the events after that id

#### Scenario: Id too old

- **WHEN** a client reconnects with an id older than the kept events
- **THEN** it receives a snapshot first

### Requirement: Policy applies to every view-model

Every text field SHALL pass the secret filter and the `redact` setting before it leaves the process. A session that matches `chat.deny` SHALL be listed as blocked with no conversation tail, and its prompt actions SHALL be refused.

#### Scenario: Secret in a message

- **WHEN** a message in the tail holds a token shape
- **THEN** the returned text has it masked

#### Scenario: Denied directory

- **WHEN** a session's directory matches a deny glob
- **THEN** it is listed as blocked and its tail is not returned
