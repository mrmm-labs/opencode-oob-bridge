## ADDED Requirements

### Requirement: Each bound topic has a pinned app message

A topic bound to a session SHALL hold a message "📱 Open app" with one Mini App deep-link button, `s_<session id>`, in the link form that works in a group, pinned without a sound. The bridge SHALL make sure it exists when the topic is bound and once at startup for each topic already bound, and SHALL remember its message id for the topic.

#### Scenario: First bind

- **WHEN** a topic is bound to a session and has no app message
- **THEN** one message with the deep-link button is posted and pinned without a sound

#### Scenario: Restart

- **WHEN** the bridge restarts and the topic already has its app message
- **THEN** no message is posted and nothing is pinned again

### Requirement: The app message is edited, never duplicated or deleted

The bridge SHALL edit the app message in place and SHALL NOT delete it or pin it again once pinned. When Telegram no longer has it, the bridge SHALL post a new one and pin it. When the bot may not pin, the message SHALL stay unpinned and `topic_pin_failed` SHALL be logged with the reason. `topic_pin` SHALL be logged with the thread and the outcome.

#### Scenario: Message deleted in Telegram

- **WHEN** the edit finds the message gone
- **THEN** a new message is posted and pinned and its id replaces the old one

#### Scenario: No right to pin

- **WHEN** Telegram refuses the pin for missing rights
- **THEN** the message stays in the topic unpinned and `topic_pin_failed` is logged with the reason
