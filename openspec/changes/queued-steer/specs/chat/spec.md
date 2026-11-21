## ADDED Requirements

### Requirement: A queued message does not wait forever

When a chat message reaches a busy session with queue delivery and `chat.queueSteerSeconds` is above 0, the bridge SHALL keep it. If the session is still busy after that many seconds, the bridge SHALL steer it into the running turn and tell the thread "steered in after Ns". If the session finishes or is interrupted first, the bridge SHALL send it as a normal prompt. Held messages of one session SHALL be sent in the order they arrived.

#### Scenario: A long turn

- **WHEN** a message arrives for a session that stays busy past the limit
- **THEN** it is sent steered and the thread says so

#### Scenario: The session frees up first

- **WHEN** the session finishes before the limit
- **THEN** the message is sent as a normal prompt and no steer notice is posted

#### Scenario: The bridge stops

- **WHEN** the bridge stops while a message is held
- **THEN** it is handed to the session's queue

### Requirement: chat.queueSteerSeconds sets the limit

`chat.queueSteerSeconds` SHALL default to 30 and accept whole numbers from 0 to 86400. The value 0 SHALL keep a message queued behind the turn.

#### Scenario: Zero

- **WHEN** `chat.queueSteerSeconds` is 0
- **THEN** the message is queued behind the turn at once

#### Scenario: A bad value

- **WHEN** the value is negative, fractional or above 86400
- **THEN** the config is refused with a message naming the key
