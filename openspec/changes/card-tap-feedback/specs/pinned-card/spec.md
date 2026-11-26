## ADDED Requirements

### Requirement: A card button is answered on arrival

A tap on QA, Update or Continue SHALL be answered with a toast naming the action and the session within about one second, before the work starts and before the tap waits for any other update.

#### Scenario: The host is slow

- **WHEN** the host does not answer the work behind a QA tap
- **THEN** the toast "QA sent to <topic>" has already been shown

#### Scenario: A message is still being handled

- **WHEN** a message of the same topic is waiting on the host and a button is tapped
- **THEN** the button is answered and its work runs without waiting for the message

### Requirement: Taps do not run at once with each other

Taps of every card button in one topic SHALL run one after the other, and SHALL NOT wait for messages of that topic.

#### Scenario: Double tap

- **WHEN** the same button is tapped twice quickly
- **THEN** the second runs after the first has finished

### Requirement: The delivery state is shown on the tapped message

After QA, Update or Continue the tapped message SHALL get a reaction for the state: sent, steered, queued or failed. No text SHALL be rewritten. Stop, Resume and Diff keep their result toast.

#### Scenario: Session idle

- **WHEN** QA is tapped and the session is idle
- **THEN** the message wears the sent reaction

#### Scenario: Session busy

- **WHEN** QA is tapped and the session is working
- **THEN** the message wears the steered reaction

#### Scenario: Continue behind a busy turn

- **WHEN** Continue is tapped while the session works and delivery is queue
- **THEN** the message wears the queued reaction

### Requirement: A failed or slow tap says so in the topic

When the work fails, or the host gives no answer within 12 seconds, the topic SHALL get a short line with the action and the reason, and the tapped message SHALL wear the failed reaction. A late answer SHALL say it may still arrive.

#### Scenario: The host refuses

- **WHEN** the host rejects the prompt of a QA tap
- **THEN** the topic says QA was not delivered, with the reason

#### Scenario: No answer in time

- **WHEN** the host does not answer in 12 seconds
- **THEN** the topic says there was no answer and the message may still arrive

### Requirement: The log says what a tap did

The log line of a callback SHALL carry the action, its result (sent, steered, queued, done or failed) and the milliseconds until the toast. A failed result SHALL give the line the outcome failed and the reason.

#### Scenario: Logged

- **WHEN** QA is tapped on a busy session
- **THEN** the line has action qa, result steered and the toast time
