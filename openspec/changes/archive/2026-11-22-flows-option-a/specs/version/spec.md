## ADDED Requirements

### Requirement: The status says what is open

The control snapshot SHALL carry a read-only `drain` object with the counts `open`, `questions`, `approvals` and `permissions` of prompts still pending, and nothing else about them. `/oob version` SHALL print a line with the counts when `open` is above zero, and the status the core API serves SHALL include the object.

#### Scenario: Something is open

- **WHEN** one question and one approval are pending
- **THEN** `drain` is `{ open: 2, questions: 1, approvals: 1, permissions: 0 }`

#### Scenario: Nothing is open

- **WHEN** nothing is pending
- **THEN** `open` is 0 and `/oob version` prints no such line
