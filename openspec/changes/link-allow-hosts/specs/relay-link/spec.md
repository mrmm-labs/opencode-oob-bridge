## ADDED Requirements

### Requirement: The link may dial hosts the operator names, over wss

The bridge SHALL accept a `link.url` whose host is listed in `link.allowHosts` only when the scheme is `wss`. Entries SHALL be exact hostnames: a wildcard, scheme, port, path or IP address SHALL be refused by key name. `link.allowHosts` SHALL default to empty, and `ws` SHALL remain limited to loopback and tailnet hosts.

#### Scenario: A listed host over wss

- **WHEN** `link.allowHosts` holds `oob-link.home.example.test` and the URL is `wss://oob-link.home.example.test/link`
- **THEN** the bridge dials it

#### Scenario: A listed host over ws

- **WHEN** the same host is used with `ws://`
- **THEN** the bridge refuses the URL, says it needs wss and opens no connection

#### Scenario: A lookalike

- **WHEN** the host is a subdomain, a parent or a suffix of a listed host
- **THEN** the bridge refuses the URL

### Requirement: The relay checks an optional key before the upgrade

When `LINK_KEY` (or `LINK_KEY_FILE`) is set the relay SHALL require the `X-OOB-Link-Key` header on `/link`, check it before the WebSocket upgrade and compare it in constant time. A missing or wrong key SHALL get 401 with no upgrade. The HMAC handshake SHALL still be required. With `LINK_KEY` unset the relay SHALL behave as before.

#### Scenario: Wrong key

- **WHEN** `LINK_KEY` is set and an upgrade carries no key or a wrong one
- **THEN** the relay answers 401 and no connection is made

#### Scenario: Key without HMAC

- **WHEN** an upgrade carries the right key but no valid HMAC
- **THEN** the relay answers 401

### Requirement: The relay refuses a short key and logs refusals without it

The relay SHALL refuse to start when `LINK_KEY` is shorter than 32 characters. A refused key SHALL be logged at most once a minute, with no key material.

#### Scenario: Short key

- **WHEN** `LINK_KEY` has fewer than 32 characters
- **THEN** the relay refuses to start and names `LINK_KEY`

#### Scenario: Many wrong keys

- **WHEN** several upgrades with a wrong key arrive within a minute
- **THEN** one log line is written and it holds no key

### Requirement: The bridge sends the key on every dial

When `link.key` is set the bridge SHALL send it as `X-OOB-Link-Key` on every dial, SHALL trim surrounding whitespace and newlines from the value, and SHALL NOT log it. While the key cannot be read the bridge SHALL stay down with the reason "no key".

#### Scenario: Newline from the secret command

- **WHEN** the `link.key` command prints the key followed by a newline
- **THEN** the header holds the key without it

#### Scenario: Unreadable key

- **WHEN** `link.key` is set and cannot be read
- **THEN** no dial is made and the status says "no key"
