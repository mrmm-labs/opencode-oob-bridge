# reactions Specification

## Purpose
The bot acknowledges a prompt with a reaction on the person's own message and no text, so the topic stays quiet and the person still sees which agent took it.

## Requirements

### Requirement: A prompt is acknowledged by a reaction
A prompt accepted from a chat SHALL get a reaction on the person's message and no text. The emoji SHALL show the agent that received it: by default build 👨‍💻, plan 🤔, general 😎, explore 🤓, coordinator 🫡 and any other agent 👀. A prompt that waits because the session is busy SHALL get ✍, and one steered into the running turn SHALL get ⚡. `reactions` SHALL override these, with `agents` keyed by agent name.

#### Scenario: Prompt to a build agent
- **WHEN** a prompt is sent to an idle session whose agent is build
- **THEN** the message gets 👨‍💻 and the bot posts no text

#### Scenario: Prompt queued
- **WHEN** a prompt arrives for a busy session and delivery is queue
- **THEN** the message gets ✍

### Requirement: Unusable reactions degrade to text
Telegram lets a bot use only a fixed set of emoji. A configured emoji outside it SHALL be ignored with a log line and the default SHALL be used. When Telegram refuses the reaction the bot SHALL say `→ sent to <agent> · <project>`. A prompt that could not be sent SHALL still get a text message.

#### Scenario: Reaction refused
- **WHEN** Telegram refuses the reaction call
- **THEN** the bot replies `→ sent to build · shop`

#### Scenario: Send failed
- **WHEN** the prompt could not be sent to the session
- **THEN** a text message says so
