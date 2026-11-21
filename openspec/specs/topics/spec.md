# topics Specification

## Purpose

In a Telegram forum group each top-level session gets its own topic, so a conversation per session stays separate. Elsewhere everything goes to the one chat with the session named in each message.

## Requirements

### Requirement: One topic per top-level session

In a forum supergroup the bridge SHALL create one topic per top-level session and send that session's messages to it. The topic SHALL be named `<project> · <session title>`, or only the project when `redact` is `title`. A session switched off before it has a topic SHALL NOT get one.

#### Scenario: First push of a session

- **WHEN** a mirrored top-level session sends its first message in a forum group
- **THEN** a topic named with its project and title exists and holds the message

#### Scenario: Not a forum

- **WHEN** the chat is private or a group without topics
- **THEN** messages go to the chat and each names its project and session

### Requirement: The topic follows the session title

The topic SHALL be renamed when the session is renamed, at most once a minute.

#### Scenario: Two renames in a minute

- **WHEN** a session is renamed twice within one minute
- **THEN** the topic is renamed at most once in that minute

### Requirement: Topic icon and color are stable

Each topic SHALL get a color that follows the project and an icon chosen from a small family per project, the same every time for the same session. `icons` SHALL pin an emoji for an agent or project. When the icon list is unavailable only the color SHALL be set.

#### Scenario: Pinned icon

- **WHEN** `icons` maps `^coordinator$` to an emoji and a coordinator session gets its topic
- **THEN** the topic and the card use that emoji

### Requirement: Missing Manage topics right is reported, not fatal

Without the Manage topics admin right the bridge SHALL say so in the chat at most once an hour, post in the main chat meanwhile, retry every 5 minutes, and show the condition in `/oob status`. Granting the right SHALL need no restart.

#### Scenario: Right granted later

- **WHEN** the admin right is granted while the bridge runs
- **THEN** the next retry creates the topic with no restart
