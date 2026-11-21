## MODIFIED Requirements

### Requirement: The session's reply is streamed into the topic

While the session works the topic SHALL show "typing…". The assistant text SHALL appear as one message that grows as the reply is written, by the transport the channel offers (see streaming), and SHALL get its final formatting when the turn ends.

#### Scenario: Reply grows

- **WHEN** the assistant text grows during a turn
- **THEN** one message is updated by the best transport the channel offers and ends with its final formatting
