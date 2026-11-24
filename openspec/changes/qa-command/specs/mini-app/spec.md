## ADDED Requirements

### Requirement: The session screen has QA and Update actions

While chat is on for a session, the session screen SHALL show QA and Update, which send the `qa` and `update` actions to the action endpoint of `/v1` with the operator's credentials, and no other route. The bridge SHALL refuse them when chat is off or the session is blocked by `chat.deny`. The buttons SHALL be disabled when the action is unavailable.

#### Scenario: Chat on

- **WHEN** the session screen is shown for a session with chat on
- **THEN** it has QA and Update, and a tap runs the action

#### Scenario: Chat off

- **WHEN** chat is off for the session
- **THEN** the screen has neither button, and the bridge refuses either action sent by hand

#### Scenario: No credentials

- **WHEN** an action is sent without credentials
- **THEN** it is refused with 401 and nothing is sent to the session
