# chat Specification

## Purpose

Chat lets a person talk to an OpenCode session from its Telegram topic: messages become prompts and the session's replies are posted back. It is off by default and can only be switched on at the Mac.

## Requirements

### Requirement: Chat is off by default and switched on only in the TUI

Chat SHALL be off for every session until it is switched on for that one session in the TUI. Nothing sent from Telegram SHALL switch chat on; the Stop chat button and the topic hint SHALL only switch it off or explain.

#### Scenario: New session

- **WHEN** a session is mirrored for the first time
- **THEN** chat is off for it

#### Scenario: Telegram cannot turn chat on

- **WHEN** a message in a session's topic asks to turn chat on
- **THEN** chat stays off and the message is not sent to the session

#### Scenario: Stop chat button

- **WHEN** the person taps Stop chat on the status card
- **THEN** chat is off for that session

### Requirement: Only the paired chat can talk to a session

The bridge SHALL act only on messages and taps from the paired chat, found by its numeric chat id. A message from any other chat SHALL be dropped unread and logged without its content. A message counts only inside the topic of a chat-enabled session, or as a reply to one of that session's bot messages.

#### Scenario: Message from another chat

- **WHEN** a message arrives from a chat that is not the paired one
- **THEN** it is ignored and the log holds no text of it

#### Scenario: Topic of a session with chat off

- **WHEN** a message arrives in the topic of a session whose chat is off
- **THEN** it is not sent to the session
- **AND** at most one hint an hour says "Chat is off for this session"

### Requirement: chat.deny blocks sessions

A session matching a `chat.deny` entry by agent pattern or directory glob SHALL NOT get chat, even when the person asks for it, and the refusal SHALL say which entry matched.

#### Scenario: Denied directory

- **WHEN** chat is turned on for a session whose directory matches a deny glob
- **THEN** chat stays off and the reply names the directory rule

### Requirement: Prompts reach the session by queue or steer

A prompt sent to an idle session SHALL start a turn. A prompt sent to a busy session SHALL wait for the turn to end when delivery is `queue` (the default), and SHALL be injected into the running turn when delivery is `steer`. A message starting with `!`, or `/steer <text>`, SHALL always be steered. The delivery mode SHALL be settable per session.

#### Scenario: Queue is the default

- **WHEN** a plain message arrives for a busy session and delivery is not changed
- **THEN** the message waits and never interrupts a step

#### Scenario: Bang steers

- **WHEN** a message `!stop and use sqlite` arrives for a busy session
- **THEN** the text without the `!` is steered into the running turn

### Requirement: Answers come before prompts

A reply to a question message, or a tap on its button, SHALL answer that question. Only a message that answers nothing SHALL be a prompt.

#### Scenario: Reply to a question

- **WHEN** the person replies "2" to an open question in the topic
- **THEN** option 2 is the answer and no prompt is sent

### Requirement: The session's reply is streamed into the topic

While the session works the topic SHALL show "typing…". The assistant text SHALL appear in one message edited as it grows, at most once per `chat.streamMs` (800 ms at least), and SHALL get its final formatting when the turn ends.

#### Scenario: Reply grows

- **WHEN** the assistant text grows during a turn
- **THEN** one message is edited, at most once per `chat.streamMs`

### Requirement: A long reply is split and attached

A reply SHALL move to a new message past about 3,800 characters, and at most three messages SHALL be posted. A longer reply SHALL also be attached as `reply.md`.

#### Scenario: Long reply

- **WHEN** a reply is longer than three messages
- **THEN** three messages are posted and the full text is attached as `reply.md`

### Requirement: Only assistant text is posted, redacted

Only assistant text SHALL be posted, never tool calls or reasoning, with Markdown converted to Telegram HTML and everything else escaped. `redact` SHALL apply to what is posted and known secret shapes SHALL be masked.

#### Scenario: Redaction

- **WHEN** `redact` applies to the session
- **THEN** what is posted is redacted and known secret shapes are masked

### Requirement: Sessions can be started from Telegram only from a listed project

Starting a session from Telegram SHALL be off until `chat.projects` lists the folders it may use. A folder SHALL only ever be one of those entries; a path typed in Telegram SHALL never be accepted, and a model SHALL only be one of the listed ones. At most five sessions an hour SHALL be started, each logged and traced, and the new session SHALL be routed to Telegram with chat on and be subject to `chat.deny`.

#### Scenario: No projects configured

- **WHEN** `chat.projects` is empty and `/new` is sent
- **THEN** no session starts

#### Scenario: Typed path

- **WHEN** `/new /etc some prompt` is sent
- **THEN** the path is refused and no session starts

### Requirement: Permissions are never answered from a channel

A permission prompt SHALL NOT be granted or denied from any channel; the message SHALL say to answer in the TUI.

#### Scenario: Permission pushed

- **WHEN** a session asks for a permission
- **THEN** the Telegram message has no Allow or Deny button

### Requirement: Telegram chat acts through the core actions

Every action the Telegram chat takes on a session (prompt, stop, compact, model, agent, rename, resume, new session, answer) SHALL go through the core actions. A refusal rule SHALL be the same for Telegram and for any other client.

#### Scenario: Stop from Telegram

- **WHEN** `/stop` is sent in a topic
- **THEN** the core stop action runs and its result is what the chat reports

#### Scenario: Denied session

- **WHEN** a prompt is sent for a session that matches `chat.deny` from any client
- **THEN** the same refusal is returned
