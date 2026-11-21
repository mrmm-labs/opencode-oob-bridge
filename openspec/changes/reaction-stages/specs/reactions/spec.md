## MODIFIED Requirements

### Requirement: A prompt is acknowledged by a reaction

A prompt accepted from a chat SHALL get a reaction on the person's message and no text. The emoji SHALL be ⚡ for a prompt sent to an idle session or steered into a running turn, and ✍ for one that waits because the session is busy. `reactions.agents` SHALL replace ⚡ for the agents it names. `reactions` SHALL override each stage's emoji.

#### Scenario: Prompt to a build agent

- **WHEN** a prompt is sent to an idle session whose agent is build
- **THEN** the message gets ⚡ and the bot posts no text

#### Scenario: Prompt queued

- **WHEN** a prompt arrives for a busy session and delivery is queue
- **THEN** the message gets ✍

#### Scenario: Agent override

- **WHEN** `reactions.agents` names the agent that received the prompt
- **THEN** the message gets that emoji instead of ⚡

## ADDED Requirements

### Requirement: The reaction follows the message through its stages

A plain prompt SHALL get 👀 when it is received. It SHALL then get ✍, ⚡ or the agent's emoji when it is delivered, 💔 when its delivery failed, 🙈 when no session is bound to the topic or the chat refused it, and 🤷 when it is held because the session waits on a question. When the session replies, every message of it that waited for a reply SHALL get 👌. Each emoji SHALL replace the one before on the same message.

#### Scenario: Sent, then replied

- **WHEN** a prompt is sent and the session later posts its reply
- **THEN** the message wears 👀, then ⚡, then 👌

#### Scenario: No session in the topic

- **WHEN** a message arrives in a topic that has no session
- **THEN** it gets 🙈 and nothing is sent to a session

#### Scenario: Held behind a question

- **WHEN** the session waits on a question
- **THEN** the message gets 🤷

#### Scenario: Delivery fails

- **WHEN** the host refuses the prompt and the bridge will retry
- **THEN** the message gets 💔, and ⚡ if a retry succeeds

### Requirement: Reactions are best effort and rate limited

A failed reaction call SHALL be logged and SHALL NOT change what is sent to the session. Two reaction calls SHALL be at least 400 ms apart, and a message SHALL NOT be given the emoji it already wears. An emoji outside Telegram's bot set SHALL be replaced by `reactions.default`, then 👀.

#### Scenario: Refused reaction

- **WHEN** Telegram refuses every reaction call
- **THEN** the prompt still reaches the session

#### Scenario: Two messages at once

- **WHEN** two prompts arrive together
- **THEN** their reaction calls are spaced apart
