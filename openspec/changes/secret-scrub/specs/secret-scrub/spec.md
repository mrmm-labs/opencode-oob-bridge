## ADDED Requirements

### Requirement: Outbound text is masked through the scrub socket

When `scrub.socket` is set, the bridge SHALL send the text of every push, edit, streamed update and posted reply through the scrub socket before a connector sends it, and SHALL send what the socket returns. It SHALL use one request per push, covering the title, message, tags, session name, question text and card text, and SHALL leave ids, priority and transport facts unchanged.

#### Scenario: Value in a message

- **WHEN** a push message holds a value the socket knows
- **THEN** the connector sends the text the socket returned and never the original

#### Scenario: One round trip

- **WHEN** a push has a title, a message, tags and a card
- **THEN** the socket receives exactly one request for it

### Requirement: The scrub client speaks protocol v1 and keeps text out of errors

The client SHALL send `{"v":1,"id","op":"scrub","text","origin":"outbound","caller":"oob-bridge"}` as one line, SHALL accept only a reply with the same id and `"ok":true` and a text, and SHALL fail on anything else. A failure SHALL name a kind (unreachable, timeout, refused, malformed, too large) and never include text from either side.

#### Scenario: Wrong id

- **WHEN** the reply carries another id
- **THEN** the call fails as malformed and the reply text is not used

### Requirement: Fail closed to the title

If the socket is unreachable, locked, loading, slow or answers badly, the bridge SHALL send a push with its title only: the message replaced by a fixed notice, with no tags, card, buttons or session name. It SHALL drop streamed updates and posted replies, and SHALL log the failure kind.

#### Scenario: Locked broker

- **WHEN** the socket answers locked
- **THEN** the connector receives the original title and a fixed notice, and no original message text

#### Scenario: Unreachable socket

- **WHEN** nothing listens on the socket path
- **THEN** a reply is not posted and a streamed update is dropped

### Requirement: Scrubbing is off unless configured

Without `scrub.socket` the bridge SHALL behave as before. `scrub` SHALL reject unknown keys, a relative socket path and a timeout outside 100 to 30000 ms.

#### Scenario: Bad config

- **WHEN** `scrub.socket` is a relative path
- **THEN** the config is refused with a message naming the key

### Requirement: Limits are stated

The README SHALL say that text which does not pass through a connector, such as the relay link and Mini App views, is not scrubbed, and that only values the broker knows are masked.

#### Scenario: Reader checks the limits

- **WHEN** a reader opens the scrub section of the README
- **THEN** both limits are stated
