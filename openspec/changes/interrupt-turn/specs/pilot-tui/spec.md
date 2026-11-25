## ADDED Requirements

### Requirement: The RPC can interrupt a session

The RPC op `interrupt` with a `session` SHALL interrupt that session's running turn without asking, and SHALL answer with the same result text as the chat.

#### Scenario: Working session

- **WHEN** the op is called for a working session
- **THEN** the host is asked to interrupt it and the answer says so

#### Scenario: Idle session

- **WHEN** the op is called for an idle session
- **THEN** it answers that nothing is running
