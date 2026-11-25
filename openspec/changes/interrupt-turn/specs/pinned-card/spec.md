## ADDED Requirements

### Requirement: The status card offers Interrupt only while the session works

The status card SHALL show an "⏹ Interrupt" button while the session is working and chat is on for it, and SHALL NOT show it when the session is idle or failed or chat is off. The button SHALL start the same confirmation as `/interrupt`.

#### Scenario: Working

- **WHEN** a session starts a turn
- **THEN** its card has an Interrupt button

#### Scenario: Idle

- **WHEN** the turn ends
- **THEN** the card has no Interrupt button

#### Scenario: Chat off

- **WHEN** a session works with chat off
- **THEN** the card has no Interrupt button

### Requirement: A stuck turn is flagged

When a session has been working and no event of it or of its subagents has been read for `chat.stuckMinutes` (default 30; 0 turns the flag off) the card SHALL say how long it has been busy and without progress.

#### Scenario: No progress

- **WHEN** a session is working and nothing happens for 45 minutes
- **THEN** the card says it has been busy and without progress

#### Scenario: Progress

- **WHEN** a tool of the session reports progress
- **THEN** the flag is cleared
