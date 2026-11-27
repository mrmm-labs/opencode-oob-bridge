## ADDED Requirements

### Requirement: Topics can be tidied on request

`/topics` in a chat and the `topics` RPC op SHALL list every open topic with its name, the time since its session was last active and a verdict, `close` or `keep`, and by default SHALL change nothing. A topic is `close` when its session is deleted or unknown, or idle longer than `idleHours` (default 24) while not working, with no chat on and nothing waiting; any other is `keep`.

#### Scenario: Dry run

- **WHEN** `/topics` is sent with no argument
- **THEN** each open topic is listed with a verdict, and no topic is closed and no file is changed

#### Scenario: Deleted session

- **WHEN** a topic belongs to a session the host does not know
- **THEN** its verdict is `close`

#### Scenario: Idle limit

- **WHEN** `idleHours` is 48 and a session was last active 30 hours ago
- **THEN** its verdict is `keep`

### Requirement: Busy sessions and waiting questions are never closed

A topic SHALL be `keep` when its session is working, has chat on, or has a question or permission waiting, whatever its age, and when it is the session the command was sent from. Shared topics and the Approvals topic SHALL always be `keep`.

#### Scenario: A question waits

- **WHEN** a session idle for ten days has a question waiting
- **THEN** its verdict is `keep`

#### Scenario: Working

- **WHEN** a session is working
- **THEN** its verdict is `keep`

#### Scenario: Current session

- **WHEN** `/topics apply` is sent from the topic of a session whose verdict would be `close`
- **THEN** that topic stays open

### Requirement: Apply closes only the close topics, and never deletes

`apply` SHALL close each `close` topic with `closeForumTopic` and SHALL NOT delete a topic or change a message. Only the paired owner SHALL be able to apply.

#### Scenario: Apply

- **WHEN** the owner sends `/topics apply`
- **THEN** exactly the `close` topics are closed and the rest are not

#### Scenario: Not the owner

- **WHEN** another member sends `/topics apply`
- **THEN** nothing is closed and they are told only the owner may

### Requirement: Closed topics of deleted sessions are forgotten, after a backup

`apply` SHALL drop an entry from the topics file only when its topic was already closed before the run and its session no longer exists, and SHALL copy the file to a backup first.

#### Scenario: Cleanup

- **WHEN** the map holds a closed topic of a deleted session, a closed topic of a live session and an open topic of a deleted session
- **THEN** only the first is dropped, a backup of the file exists, and the third is closed

#### Scenario: Dry run

- **WHEN** the run is a dry run
- **THEN** no entry is dropped and no backup is made

### Requirement: A topic stays open while its session is open or working

The bridge SHALL NOT close the topic of a session that is open in a TUI or working, that has chat on, that has a question or permission waiting, or that has had an event in the last 2 minutes. It SHALL NOT close a shared topic or the Approvals topic.

#### Scenario: Open in a TUI

- **WHEN** a TUI shows a session that has been idle for hours
- **THEN** its topic stays open

#### Scenario: Working

- **WHEN** a session is working
- **THEN** its topic stays open

#### Scenario: A question waits

- **WHEN** an idle session has a question or permission waiting
- **THEN** its topic stays open

#### Scenario: Recent activity

- **WHEN** a session went idle 30 seconds ago
- **THEN** its topic stays open until 2 minutes have passed with no event of it

### Requirement: An idle topic is closed after the settle time

When a session is not open in any TUI, not working, has no chat and nothing waiting, and has been quiet for the settle time, the bridge SHALL close its topic with `closeForumTopic`, once. `topics.closeIdle` (default true) SHALL govern sessions that were viewed and `topics.closeHeadless` headless ones; with the switch off the bridge SHALL NOT close that kind by itself.

#### Scenario: A TUI closes the session

- **WHEN** the TUI that showed a session stops showing it and the settle time passes
- **THEN** its topic is closed

#### Scenario: Switch off

- **WHEN** closeIdle is false and a viewed session goes idle
- **THEN** its topic is not closed

### Requirement: A closed topic is reopened by activity

A closed topic SHALL be reopened when a turn starts, when a question or permission is posted to it, when a message is posted to it, and when the user writes in it. A topic the bridge reopened SHALL NOT be closed again for 10 minutes.

#### Scenario: The user writes in it

- **WHEN** the user writes in the closed topic of an idle session
- **THEN** the topic is reopened and is not closed again within 10 minutes

#### Scenario: A question

- **WHEN** a session whose topic is closed asks a question
- **THEN** the topic is reopened before the question is posted

### Requirement: A session open in a TUI is known per TUI

The control SHALL keep the session each TUI shows, and SHALL treat a session as open while a TUI that has reported within the presence window shows it. A TUI that stops reporting SHALL stop counting.

#### Scenario: Two TUIs

- **WHEN** two TUIs show two different sessions
- **THEN** both sessions are open

#### Scenario: A TUI goes silent

- **WHEN** a TUI stops reporting
- **THEN** its session is no longer open after the presence window
