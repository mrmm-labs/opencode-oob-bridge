## ADDED Requirements

### Requirement: Headless sessions share one topic per project

In a forum supergroup a top-level session that was never viewed in a TUI SHALL post to one topic named `<project> · agents`, created on first use, and SHALL NOT get a topic of its own. A session is viewed when the host's session has `time.viewed`.

#### Scenario: Parentless and never viewed

- **WHEN** a top-level session with no `time.viewed` posts in a forum group
- **THEN** its message is in `<project> · agents` and no topic is made for the session

#### Scenario: Parentless and viewed

- **WHEN** a top-level session with `time.viewed` posts
- **THEN** it gets its own topic named with its project and title

#### Scenario: Child of a parentless session

- **WHEN** a subagent of an unviewed top-level session asks a question
- **THEN** the question is in `<project> · agents`

#### Scenario: Two sessions, one topic

- **WHEN** two unviewed sessions of one project post
- **THEN** both are in the same topic and only one topic was created

### Requirement: Other sessions keep their own topic

A session whose root has a parent, a session with chat on, and a session that already has its own topic SHALL follow the one-topic-per-session rule. `channels.telegram.topics.headless` SHALL be `"project"` (default) or `"session"`; with `"session"` every top-level session gets its own topic.

#### Scenario: Setting off

- **WHEN** `topics.headless` is `"session"`
- **THEN** an unviewed top-level session gets its own topic

#### Scenario: Chat on

- **WHEN** an unviewed session has chat on
- **THEN** it posts to a topic of its own

### Requirement: A session that is viewed later moves on, and nothing is rewritten

When a session that posted to the shared topic is later viewed, or turns chat on, its next message SHALL go to a topic of its own. Topics that exist SHALL NOT be deleted or renamed, and messages already sent SHALL NOT be moved or edited, except by the update of an open question or approval card.

#### Scenario: Viewed after posting

- **WHEN** a session posts to the shared topic, is then viewed, and posts again
- **THEN** the first message stays in the shared topic and the second is in a new topic of the session

#### Scenario: Own topic first

- **WHEN** a session already has its own topic and is not viewed
- **THEN** it keeps posting to its own topic

### Requirement: Messages in the shared topic name their session

Each message the bridge sends in the shared topic SHALL begin with a tag with the session title (the last 6 characters of the id when titles are redacted), and an edit of such a message SHALL keep it. The shared topic SHALL have no status card, pinned message, rename or typing indicator.

#### Scenario: Two agents

- **WHEN** two sessions post to the shared topic
- **THEN** each message begins with the title of its session

### Requirement: A reply in the shared topic goes to the session of the message

A message in the shared topic that replies to a message of the bridge SHALL be delivered to the session that message was sent for. A message that replies to no known message SHALL be refused with a hint to reply to an agent's message.

#### Scenario: Reply to an agent

- **WHEN** the operator replies to a message of one session in the shared topic
- **THEN** the text is delivered to that session only

#### Scenario: No reply

- **WHEN** the operator writes in the shared topic without replying to a message
- **THEN** nothing is delivered and the topic gets a hint
