## ADDED Requirements

### Requirement: Topics of idle headless sessions are closed, never deleted

The bridge SHALL close the topic of a headless session that is idle, with `closeForumTopic`, and SHALL NOT delete a topic or rename or rewrite a message. A session is headless when it has no parent, no TUI has viewed it, chat is off for it, it is not working and nothing waits on its answer. A topic shared by several sessions SHALL NOT be closed.

#### Scenario: Idle headless session

- **WHEN** a headless session is idle and has a topic of its own
- **THEN** that topic is closed and nothing is deleted

#### Scenario: Not headless

- **WHEN** a session has been viewed, has a parent, has chat on, is working or has a question waiting
- **THEN** its topic is left open

#### Scenario: Shared topic

- **WHEN** idle headless sessions share one topic
- **THEN** that topic stays open

### Requirement: Topics are closed at start and when a session ends

At start the bridge SHALL close the topics already in its topics file whose session is headless and idle, and afterwards it SHALL close a topic when its session ends.

#### Scenario: Old topics

- **WHEN** the bridge starts with three topics of idle headless sessions and one of a viewed session
- **THEN** the three are closed and the fourth is not

#### Scenario: A session ends

- **WHEN** a headless session with a topic of its own finishes its turn
- **THEN** its topic is closed

### Requirement: A closed topic is reopened when its session is active again

A topic the bridge closed SHALL be reopened with `reopenForumTopic` before anything is posted to it, and when its session starts a turn. The status card of an idle session SHALL NOT reopen it.

#### Scenario: A new turn

- **WHEN** a session whose topic is closed starts a turn
- **THEN** the topic is reopened and the card shows it working

#### Scenario: A late card edit

- **WHEN** the card of an idle session whose topic is closed is refreshed
- **THEN** the topic stays closed

### Requirement: Closing can be switched off

`channels.telegram.topics.closeHeadless` SHALL default to true. When false the bridge SHALL close nothing, and SHALL still reopen a topic it closed earlier when it is used.

#### Scenario: Off

- **WHEN** closeHeadless is false and a headless session ends
- **THEN** no topic is closed

### Requirement: Every close and reopen is logged

Each close and reopen, and each failure of either, SHALL be written to the log with the session and the topic. A failed close SHALL NOT stop delivery or be retried before the session ends again.

#### Scenario: A close fails

- **WHEN** Telegram refuses to close a topic
- **THEN** the failure is logged and the session's messages still arrive
