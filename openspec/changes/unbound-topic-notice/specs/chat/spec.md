## ADDED Requirements

### Requirement: A message in a topic without a session is answered

The bridge SHALL, for a prompt or media message in a topic that no session owns, set the ignored reaction and post one line in that topic saying to write in a session topic. It SHALL NOT deliver the message to any session.

#### Scenario: General topic

- **WHEN** a person writes plain text in a topic no session is bound to
- **THEN** the reply "No session here; write in a session topic" is posted in that topic and nothing reaches the core
