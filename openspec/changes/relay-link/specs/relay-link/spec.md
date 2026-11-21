## ADDED Requirements

### Requirement: The bridge connects out to the relay

When `link.url` is set the owning bridge SHALL open one connection to it and keep it open, reconnecting with backoff. It SHALL open no listening port for the link. Only the owning instance SHALL hold a link.

#### Scenario: Not configured

- **WHEN** no `link.url` is set
- **THEN** no connection is opened

#### Scenario: The relay restarts

- **WHEN** the relay closes the connection
- **THEN** the bridge reconnects without operator action

#### Scenario: Two instances in one process

- **WHEN** two plugin instances run in one process
- **THEN** one link is open

### Requirement: The link goes to a tailnet host only

The bridge SHALL refuse a `link.url` whose host is not a loopback address, an address in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, or a `*.ts.net` name, log why and open no connection.

#### Scenario: Public host

- **WHEN** the URL is `wss://relay.example.com/link`
- **THEN** the bridge refuses it and opens no connection

### Requirement: Every frame is authenticated

The upgrade request and every frame SHALL carry a time stamp, a nonce and the HMAC-SHA256, with the shared secret, of the direction, the time stamp, the nonce and the body. The receiver SHALL refuse a time stamp more than 60 seconds from its clock, a nonce already seen inside that window, and a MAC that does not match, comparing in constant time. A refused frame SHALL be dropped and logged without its body.

#### Scenario: Replay

- **WHEN** a frame is sent twice
- **THEN** the second is refused

#### Scenario: Stale frame

- **WHEN** a frame is 90 seconds old
- **THEN** it is refused

#### Scenario: Reflection

- **WHEN** a frame the bridge sent is sent back to it
- **THEN** it is refused

#### Scenario: Tampered body

- **WHEN** one byte of the body changes
- **THEN** the frame is refused

### Requirement: The secret is a secret

The secret SHALL come from a secret reference, SHALL never be logged or sent, and a missing secret SHALL leave the link off with a logged reason.

#### Scenario: No secret

- **WHEN** `link.url` is set and the secret cannot be read
- **THEN** no connection is opened and the reason is logged

### Requirement: A request on the link meets the same gates as the API

The bridge SHALL answer a request frame by running the core API handler in process. The link SHALL count as an edge: init data SHALL be the only accepted credential, a bearer token SHALL be refused, and the client address SHALL be the frame's `client` field. The bridge SHALL serve only `/app/`, `/v1/` and `GET /healthz`, a body up to 256 KiB and 16 requests in flight, and answer 404, 413 or 503 otherwise.

#### Scenario: Bearer token on the link

- **WHEN** a request frame carries the bearer token
- **THEN** the response is 401

#### Scenario: Other path

- **WHEN** a request frame asks for `/admin`
- **THEN** the response is 404

#### Scenario: Too many at once

- **WHEN** 17 requests are in flight
- **THEN** the 17th is answered 503

### Requirement: Streams pass over the link

A response that streams SHALL be sent as ordered chunk frames and end with a closing frame. A closed request SHALL stop its stream.

#### Scenario: Phone leaves

- **WHEN** the relay reports a request closed
- **THEN** the bridge stops writing to it

### Requirement: The link shows its state

`/oob status`, the sidebar and the snapshot SHALL show whether the link is up, down or not configured, and since when.

#### Scenario: Link down

- **WHEN** the connection is lost
- **THEN** the status says down and since when
