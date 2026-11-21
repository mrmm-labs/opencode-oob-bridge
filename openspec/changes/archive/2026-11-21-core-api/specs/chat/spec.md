## ADDED Requirements

### Requirement: Telegram chat acts through the core actions

Every action the Telegram chat takes on a session (prompt, stop, compact, model, agent, rename, resume, new session, answer) SHALL go through the core actions. A refusal rule SHALL be the same for Telegram and for any other client.

#### Scenario: Stop from Telegram

- **WHEN** `/stop` is sent in a topic
- **THEN** the core stop action runs and its result is what the chat reports

#### Scenario: Denied session

- **WHEN** a prompt is sent for a session that matches `chat.deny` from any client
- **THEN** the same refusal is returned
