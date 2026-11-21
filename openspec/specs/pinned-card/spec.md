# pinned-card Specification

## Purpose
Each topic opens with a status card pinned without a sound. Its first line is all the pinned-message bar shows, so it carries how the session is watched and what it is doing.

## Requirements

### Requirement: A pinned status card is the first message of a topic
The first message of a session's topic SHALL be a status card, pinned without a sound. After the first line it SHALL show the session title, agent and model, project, short session id and last activity. `statusCard: false` SHALL turn it off, and `notify.finished: true` SHALL bring back one message per finished turn.

#### Scenario: Card created
- **WHEN** a topic is created
- **THEN** its first message is the card and it is pinned silently

#### Scenario: Card off
- **WHEN** `statusCard` is false
- **THEN** no card is posted

### Requirement: The first line says how the session is watched
The first line SHALL read `<watch> · <chat> — <state>`. Watch SHALL be `👁 on` (`👁 on·telegram` when forced to one channel), `⏱ auto` or `🔕 off`. Chat SHALL be `💬 on` or `💬 off`. State SHALL be `🟢 Working`, `💤 Idle <time>` or `❌ Failed <time>`. The line SHALL follow `/oob on|off|auto` and `/oob chat` at once, and the topic name SHALL NOT change for it.

#### Scenario: Idle and watched
- **WHEN** a session is forced on, chat is on and the turn ended at 22:06
- **THEN** the first line is `👁 on · 💬 on — 💤 Idle 22:06`

### Requirement: The card is edited in place, rate-limited
The card SHALL be edited in place at most once every 10 seconds. `/status` SHALL redraw it and pin it again.

#### Scenario: Burst of changes
- **WHEN** the state changes five times within 10 seconds
- **THEN** the card is edited at most once in that window

### Requirement: Finished turns do not add messages by default
A finished push SHALL be replaced by the card. Failed pushes SHALL keep their format and make a sound; low priority pushes SHALL arrive without a sound.

#### Scenario: Turn ends
- **WHEN** a turn ends and `notify.finished` is not true
- **THEN** the card changes and no separate message is sent
