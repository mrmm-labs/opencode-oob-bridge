## ADDED Requirements

### Requirement: A message for a session that waits on a question is held

When a session has an open question, a plain message sent to its chat SHALL NOT be sent to the session. The connector SHALL tell the thread that the session waits on a question and SHALL offer: show the question again, do not send the message, and send it anyway (steered). A reply to the question's message SHALL still answer the question, and a message starting with `!` SHALL still be steered at once.

#### Scenario: Plain message while a question is open

- **WHEN** a plain message arrives for a session with an open question
- **THEN** nothing is sent to the session and the thread shows the three choices

#### Scenario: Send anyway

- **WHEN** the person taps Send anyway
- **THEN** the kept message reaches the session steered

#### Scenario: Skip

- **WHEN** the person taps Skip
- **THEN** nothing is sent and the thread says so

#### Scenario: Answer

- **WHEN** the person taps Answer
- **THEN** the question is posted again at the bottom of the thread and the message is not sent
