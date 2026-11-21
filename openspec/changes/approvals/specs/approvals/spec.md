## ADDED Requirements

### Requirement: Approvals are a local endpoint on a unix socket

The bridge SHALL serve approval requests on a unix socket in a directory with mode 0700, with the socket at mode 0600, and SHALL NOT open a TCP listener or webhook for it. The instance that runs the bridge SHALL own the socket, a stale socket SHALL be replaced, and the service SHALL be off unless `approvals.enabled` is true.

#### Scenario: Socket modes

- **WHEN** the service starts
- **THEN** the directory is 0700 and the socket is 0600

#### Scenario: Disabled

- **WHEN** `approvals.enabled` is not true
- **THEN** no socket exists

### Requirement: Every caller proves who it is

A request SHALL carry the caller's name, a timestamp and an HMAC over the method, path, timestamp and body hash with the caller's key. The bridge SHALL refuse an unknown caller, a bad HMAC and a timestamp more than 60 seconds off. The proof of a POST SHALL work once inside its window; a repeated read or withdrawal changes nothing and is not refused.

#### Scenario: Bad MAC

- **WHEN** a request carries a wrong HMAC
- **THEN** it is refused as unauthenticated and nothing is sent to a chat

#### Scenario: Old timestamp

- **WHEN** a request's timestamp is 90 seconds old
- **THEN** it is refused

#### Scenario: Replayed POST

- **WHEN** the same signed POST is sent a second time inside the window
- **THEN** it is refused as unauthenticated

### Requirement: A class not configured for the caller is refused

A request SHALL name an action class. A class not in the configuration, or not listed for that caller, SHALL be refused. A caller SHALL NOT raise or lower the level of a class or add a channel.

#### Scenario: Unlisted class

- **WHEN** a caller asks for a class it is not listed for
- **THEN** the request is refused as `forbidden_class`

### Requirement: Levels are a tap, a tap with a code, or the machine

L1 SHALL need a tap on Approve. L2 SHALL need a tap on Approve and then a valid one-time code. L3 SHALL NOT be relayed: the bridge SHALL answer it at once with `needs_local`. A request MAY ask for a higher level than its class minimum and SHALL NOT ask for a lower one. A tap on Deny from the operator SHALL be enough for any class.

#### Scenario: L3

- **WHEN** a request needs level 3
- **THEN** the bridge answers `needs_local` and sends no approval message

#### Scenario: Deny at any level

- **WHEN** the operator taps Deny on an L2 request
- **THEN** the request is denied with no code asked

### Requirement: Presence decides the order

In `afk` mode the phone SHALL be asked first. In `present` mode the bridge SHALL refuse a phone request with `needs_local` and the reason `present`. Switching to present SHALL withdraw pending requests with the reason `present`. A caller that cannot reach the bridge SHALL behave as in present mode. The mode SHALL be changeable only from the TUI.

#### Scenario: Present refuses

- **WHEN** a request arrives while the mode is present
- **THEN** it is refused with `needs_local` and the reason `present`

#### Scenario: Switch to present

- **WHEN** the mode changes from afk to present with a request pending
- **THEN** the request is withdrawn with the reason `present`

#### Scenario: Mode from a chat

- **WHEN** a chat message asks to change the presence mode
- **THEN** the mode does not change

### Requirement: Only the paired operator counts

The bridge SHALL accept an approval tap or code only from the Telegram user id stored at pairing, not from the chat id. Other members of a group SHALL be ignored. A chat paired before the user id was stored counts its owner only when it is a private chat (the chat id is then the user id); a group paired earlier has no operator until it is paired again, and requests fail as `not_paired`.

#### Scenario: Another member taps

- **WHEN** a group member who is not the operator presses Approve
- **THEN** the request stays pending and the tap is logged without content

### Requirement: L2 uses a one-time code used once per step

L2 SHALL use a TOTP code (RFC 6238, SHA-1, 6 digits, 30-second step, one step of tolerance). A time step SHALL be accepted at most once. Three wrong codes SHALL deny the request. The bridge SHALL delete the message holding the code on a best-effort basis.

#### Scenario: Replayed code

- **WHEN** a code that was accepted is typed again for another request in the same step
- **THEN** it is refused

#### Scenario: Three wrong codes

- **WHEN** the operator types three wrong codes
- **THEN** the request is denied with the reason `bad_code`

### Requirement: Answers are signed by the bridge

An answer SHALL be signed with Ed25519 over a string that holds the answer version, the request id, the request hash, the decision, the level, the mode, the approver and the time, and SHALL carry the key id. A caller SHALL be able to verify it with a public key that cannot sign.

#### Scenario: Tampered decision

- **WHEN** an answer's decision is changed after signing
- **THEN** verification fails

#### Scenario: Key rotation

- **WHEN** the key id changes
- **THEN** both keys verify during the overlap the operator sets

### Requirement: Keys live in the Keychain and nowhere else

The signing key and the TOTP seed SHALL be stored in the macOS Keychain through the Security framework from the host process, with an access rule that names the host executable only. They SHALL NOT be written to a file or passed to the `security` command. When the Keychain cannot be used the service SHALL report `unavailable` and SHALL NOT fall back to another store. Keys and the seed SHALL be created, replaced or deleted only by a command typed in the TUI at the Mac, never by the socket or a chat.

#### Scenario: Server read without a prompt

- **WHEN** the server reads a key and macOS would need the operator
- **THEN** the read fails and an `unlock` command typed in the TUI makes the prompt appear at the Mac

#### Scenario: Keychain unusable

- **WHEN** the Keychain cannot be reached
- **THEN** requests are refused as `unavailable` and no key file is created

### Requirement: A request is single use and bounded

An approval SHALL cover the one action in its request and SHALL be single use. A request SHALL expire after its ttl (default 120 s, at most 600 s per class). A request SHALL carry an idempotency key kept 24 hours: a replay SHALL return the stored request and answer, and the same key with a different body SHALL be refused.

#### Scenario: Replay

- **WHEN** the same idempotency key and body are sent again
- **THEN** the stored request and, once decided, the same answer are returned

#### Scenario: Different body

- **WHEN** the same key is sent with another body
- **THEN** it is refused as `idempotency_mismatch`

### Requirement: Abuse is limited

A deny SHALL start a cooldown (default 120 s) for the same caller, class and scope, during which a request SHALL be answered with deny and the reason `cooldown` and nothing SHALL be sent to the chat. Each caller SHALL have at most 3 pending requests and 12 an hour, and a global cap SHALL protect the chat.

#### Scenario: Retry after deny

- **WHEN** a caller repeats a denied request within 120 seconds
- **THEN** it is answered with deny and `cooldown` and no message is sent

#### Scenario: Too many pending

- **WHEN** a caller has 3 pending requests and sends a fourth
- **THEN** it is refused as `rate_limited`

### Requirement: The message states who asks and what

An approval message SHALL state the caller, the session and agent, the class, the level and a plain, redacted summary of at most 500 characters, and the reason of at most 300 characters. It SHALL show identifiers and names only, never values.

#### Scenario: Secret in a summary

- **WHEN** a request's summary holds a token shape
- **THEN** the message shows it masked

### Requirement: A restart expires what is pending

Pending requests SHALL be kept in memory. A restart SHALL expire them with the reason `bridge_restart` and the caller MAY retry with the same idempotency key. A tap on an expired request SHALL say it expired.

#### Scenario: Bridge restarts

- **WHEN** the bridge restarts with a request pending
- **THEN** the request ends as expired with `bridge_restart`

### Requirement: Channels declare what they can prove

A class SHALL list the channels it accepts, default Telegram only. A channel SHALL declare whether it has buttons, whether it identifies the approver and whether it takes typed text, and a request SHALL fail at once with `unavailable` when no accepted channel can reach the level. Telegram is the only channel that declares approvals in this release; ntfy declares none, because a tap there proves nobody and its buttons would need a listener (the weak L1 path of the document is deferred).

#### Scenario: ntfy for an L2 class

- **WHEN** an L2 class lists only ntfy
- **THEN** a request fails at once as `unavailable`

### Requirement: Phone permission replies use the levels

When approvals are enabled and `permissions.remote` is not off, a phone Allow once SHALL need the level of the class `permission.<action>` and Always SHALL need level 2. Without such a class, read-like actions (read, list, glob, grep, webfetch, websearch, codesearch, lsp, skill) SHALL be level 1 and every other action level 2. Only the paired operator's tap SHALL count. A client of the core API, which cannot type a code in the chat, SHALL be refused for level 2.

#### Scenario: Always from the phone

- **WHEN** the operator taps Always on a permission
- **THEN** a one-time code is asked before the rule is saved
