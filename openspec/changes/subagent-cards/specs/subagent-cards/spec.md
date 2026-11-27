## ADDED Requirements

### Requirement: A subagent has a card in its parent's topic

When a session runs a subagent, the bridge SHALL post one card in the topic of the root session, showing the description, the agent, the status (running, waiting, done, idle or error), the time it has run, and the last line of its last text, trimmed. A grandchild SHALL have its own card in the root's topic, led by `↳`.

#### Scenario: A subagent starts

- **WHEN** a child of a session with a topic starts a turn
- **THEN** one card with its agent, description and `running` is posted in that topic

#### Scenario: A grandchild

- **WHEN** a child of a subagent starts a turn
- **THEN** its card is posted in the root's topic and starts with `↳`

### Requirement: The card is edited in place, paced and never deleted

The bridge SHALL edit the card for status, last line and run time, never delete it, and never send an edit whose text equals the one shown. Edits of one card SHALL be debounced and at least 8 seconds apart, and the run time SHALL change the text at most once a minute. A final result SHALL stay on the card.

#### Scenario: Status changes

- **WHEN** a subagent finishes with a last text
- **THEN** its card is edited to `done` with that line, and no message is posted or deleted

#### Scenario: A burst of changes

- **WHEN** a card's status and last line change three times within a second
- **THEN** one edit with the latest text is sent, and the next edit of that card waits for the gap

### Requirement: A subagent's prompt replies to its card

A question of a subagent, and a permission posted as a message of its own, SHALL be posted as a reply to its card in the parent's topic, and the answer SHALL reach the child session. While a prompt of the child is pending its card SHALL show `waiting`.

#### Scenario: A question

- **WHEN** a subagent asks a question
- **THEN** the question is posted as a reply to its card, the card shows `waiting`, and the answer is delivered to the child session

### Requirement: No card without a topic of the root's own

A subagent SHALL NOT get a card when its root session has no topic of its own: when the root posts in the shared `<project> · agents` topic, or the chat is not a forum. Its prompts SHALL post as before.

#### Scenario: A headless parent

- **WHEN** a child of a headless session starts a turn and asks a question
- **THEN** no card is posted, and the question goes to the shared topic as before
