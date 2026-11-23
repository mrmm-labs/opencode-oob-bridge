## MODIFIED Requirements

### Requirement: The status says what is open

The control snapshot SHALL carry a read-only `drain` object with the counts `open`, `questions`, `approvals` and `permissions` of prompts OpenCode confirmed open within the last two checks (or asked less than ten seconds ago), and `unverified`, the count of pending prompts it could not confirm, which `open` does not include, and nothing else about them. `/oob version` SHALL check with OpenCode first and print a line with the counts when `open` or `unverified` is above zero, and the status the core API serves SHALL include the object.

#### Scenario: Something is open

- **WHEN** one question and one approval are pending and OpenCode confirmed the question
- **THEN** `drain` is `{ open: 2, questions: 1, approvals: 1, permissions: 0, unverified: 0 }`

#### Scenario: Nothing is open

- **WHEN** nothing is pending
- **THEN** `open` is 0 and `/oob version` prints no such line

#### Scenario: A question OpenCode dropped

- **WHEN** a question is pending and OpenCode no longer lists its form
- **THEN** the check withdraws it and `open` does not count it

#### Scenario: A question OpenCode cannot be asked about

- **WHEN** a pending question is older than the confirmation window and OpenCode cannot be asked
- **THEN** `open` does not count it and `unverified` does
