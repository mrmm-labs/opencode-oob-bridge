## ADDED Requirements

### Requirement: A question can be answered from a channel with no window open

The bridge SHALL deliver a form reply through the local OpenCode service, and SHALL post a question with its answer controls whenever that service answers or a window is attached. A window SHALL relay a reply only when the service cannot. The note to answer at the Mac SHALL be posted only when neither can deliver.

#### Scenario: No window attached

- **WHEN** a question arrives and no TUI is attached but the service answers
- **THEN** it is posted with its buttons and an answer is delivered through the service

#### Scenario: Service cannot, window attached

- **WHEN** the service refuses the reply and a window is attached
- **THEN** the window relays the reply

#### Scenario: Neither

- **WHEN** the service does not answer and no window is attached
- **THEN** the question is posted with the note to answer at the Mac and no buttons

### Requirement: The reaction ends at 👌 or 💔 after the reply

When a session's reply has been posted to a chat, the bridge SHALL set 👌 on each message of that session waiting for it, and SHALL set 💔 when the reply could not be posted. It SHALL log each reaction it set with its stage.

#### Scenario: Reply sent

- **WHEN** the session replies and the reply is posted
- **THEN** the message wears 👌 and the log holds a reaction line with stage done

#### Scenario: Reply fails

- **WHEN** posting the reply fails
- **THEN** the message wears 💔
