## ADDED Requirements

### Requirement: One receive loop per bot in a process

A receive loop that starts while another loop of the same bot runs in the process SHALL wait for it to end, for at most 5 seconds, before it polls. The bridge SHALL log `telegram_poll_handover` with how long it waited.

#### Scenario: Restart while a long poll is open

- **WHEN** the bridge restarts and the old loop's request has not ended
- **THEN** the new loop does not poll until the old one has ended, so two `getUpdates` are never open together

### Requirement: A getUpdates conflict is reported as a conflict

When `getUpdates` fails with HTTP 409 the connector SHALL log `telegram_poll_conflict` once for the episode, SHALL NOT log `telegram_error` for it, SHALL show "another process is polling this bot (HTTP 409)" in the channel status, and SHALL retry with its backoff. The status SHALL clear when a poll succeeds.

#### Scenario: Three conflicts, then a message

- **WHEN** `getUpdates` answers 409 three times and then works
- **THEN** one conflict line is logged, no error line, the next message is handled, and the status error is cleared
