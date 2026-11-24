## ADDED Requirements

### Requirement: /qa asks the session for an interactive Q&A

`/qa [topic]` SHALL be a session command. It SHALL send the session a fixed instruction to collect its open decisions and ask them with the question tool, with the delivery of `/steer`, and SHALL reply "⚡ steered in" when the session was busy and "→ sent" when it was not. A typed topic SHALL be added to the instruction as a focus, on one line and cut to 200 characters, and SHALL never be used as a path, a model or an agent.

#### Scenario: Idle session

- **WHEN** `/qa` is sent in the topic of an idle session with chat on
- **THEN** the instruction is sent with delivery `steer` and the bot says "→ sent"

#### Scenario: Busy session with a topic

- **WHEN** `/qa billing` is sent in the topic of a running session
- **THEN** the instruction ends with "Focus: billing", is steered in, and the bot says "⚡ steered in"

#### Scenario: A long topic

- **WHEN** the topic is longer than 200 characters
- **THEN** only its first 200 characters are sent

### Requirement: /qa follows the session command rules

`/qa` SHALL be refused in General as the other session commands are, SHALL need chat on, and SHALL pass `chat.deny`.

#### Scenario: In General

- **WHEN** `/qa` is sent in General
- **THEN** nothing is sent to any session and the bot says it acts on a session

#### Scenario: Chat off

- **WHEN** chat is off for the session
- **THEN** nothing is sent and the bot says chat is off
