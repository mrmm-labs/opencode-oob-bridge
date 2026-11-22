## ADDED Requirements

### Requirement: Text already shown is never rewritten or deleted

The stream of a turn SHALL keep each step's text as its own message: when the assistant starts a new message, the text shown so far stays and the new text goes in new messages. The final reply SHALL edit a streamed message in place only when the final text extends what that message shows; otherwise it SHALL be sent as a new message. No streamed message SHALL be deleted.

#### Scenario: Narration, a tool call, then the answer

- **WHEN** a step writes "Let me look at the files", calls a tool, and the next step writes "All done."
- **THEN** both are messages in the topic, none is edited into the other, and nothing is deleted

#### Scenario: The final extends the stream

- **WHEN** the final text starts with the text the stream shows
- **THEN** that message is edited and no new message is sent

#### Scenario: The final differs

- **WHEN** the final text does not start with the streamed text
- **THEN** it is sent as a new message and the streamed one stays

### Requirement: A final reply that failed is tried again

A final reply that could not be posted SHALL leave the stream as it is and SHALL be posted as a new message after a short wait. The reaction on the person's message SHALL show the failure and then the success.

#### Scenario: One failure

- **WHEN** posting the final fails once
- **THEN** it is posted after the wait and nothing shown is deleted
