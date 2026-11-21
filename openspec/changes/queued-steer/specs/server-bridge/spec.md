## ADDED Requirements

### Requirement: A Telegram call is tried again after one failed connection

When a Telegram call other than `getUpdates` fails to connect or times out, the connector SHALL repeat it once on a new connection and log `telegram_call_retry`. A second failure SHALL be reported as before.

#### Scenario: A dead connection

- **WHEN** the first `sendMessage` fails and the second works
- **THEN** one message is sent

#### Scenario: Two failures

- **WHEN** both attempts fail
- **THEN** the call fails after exactly two attempts
