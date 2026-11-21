## ADDED Requirements

### Requirement: An update is written down before Telegram is told it arrived

The connector SHALL append every update of a `getUpdates` batch to its journal before it moves the offset. When the append fails the connector SHALL leave the offset unchanged, log the failure and back off. At the next start it SHALL handle again every journal entry that was not marked done.

#### Scenario: The journal cannot be written

- **WHEN** an update arrives and the journal write fails
- **THEN** the offset does not move and the update is offered again

#### Scenario: Restart with an unfinished entry

- **WHEN** the connector starts and the journal holds an entry with no `done` line
- **THEN** that update is handled once and then marked done

### Requirement: Handling an update never stops the poll loop

The poll loop SHALL only dispatch updates. Updates of one chat and topic SHALL be handled in order, and a topic SHALL NOT wait for another. An update SHALL end after at most 90 seconds; the topic SHALL be told and the next update of the topic SHALL run.

#### Scenario: A handler never returns

- **WHEN** the handler of one topic's update never returns
- **THEN** polling continues and updates of other topics are handled

#### Scenario: A handler takes too long

- **WHEN** an update exceeds its time limit
- **THEN** the topic is told it could not be handled and the next update of that topic runs

### Requirement: Every update has a logged outcome

For each update the connector SHALL write one `telegram_inbound` log line with the update id, message id, topic, kind, attempt, duration, outcome (`delivered`, `refused`, `ignored`, `rejected`, `failed`, `error` or `handled`) and a reason where there is one. The line SHALL NOT hold message text. The bridge SHALL write one `inbound` line for each message it receives from a channel.

#### Scenario: Delivered, refused, ignored and rejected

- **WHEN** four updates end as delivered, refused by the core, ignored and from another chat
- **THEN** four lines carry those outcomes and none holds the text

### Requirement: A failed delivery is kept, said and tried again

When the host refuses a prompt from a connector that declares `retriesInbound`, the connector SHALL tell the topic why, keep the update open, and try again after 5 seconds, 30 seconds and 2 minutes. After the last try it SHALL say it gave up.

#### Scenario: The host fails once

- **WHEN** the host refuses a prompt once and accepts it on the next try
- **THEN** the topic is told the message was not delivered, and the retry reaches the session and gets its reaction

### Requirement: A running session is not suspended

The suspended-session probe SHALL NOT list a session whose last busy time is later than its last idle time, whatever `time_suspended` holds.

#### Scenario: A running session with a stale suspended time

- **WHEN** a session has `time_suspended` set and a turn is running
- **THEN** the probe does not list it
