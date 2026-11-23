## ADDED Requirements

### Requirement: Pending prompts are checked against what OpenCode holds open

Every 60 seconds and at startup the bridge SHALL check each pending question and permission request against the list of open requests OpenCode holds for its session. A prompt that is not listed SHALL be marked `withdrawn` and its message edited to "⚪ Withdrawn: the session stopped asking", never deleted, unless OpenCode says it was answered or cancelled, which it keeps. A session OpenCode no longer has SHALL hold nothing open. When OpenCode cannot be asked, nothing SHALL be closed.

#### Scenario: A form OpenCode no longer lists

- **WHEN** a question is pending and OpenCode lists no open form for its session
- **THEN** the next check marks it `withdrawn` and edits its message

#### Scenario: Still listed

- **WHEN** a pending question is in OpenCode's list
- **THEN** it stays pending and is counted as confirmed

#### Scenario: OpenCode cannot be asked

- **WHEN** the lookup fails
- **THEN** the prompt stays pending, is counted as unverified, and no message is edited

### Requirement: Each check is logged with its counts

A check that looked at a prompt SHALL log `reconcile` with the counts `checked`, `open`, `closed`, `withdrawn` and `unverified`.

#### Scenario: One form dropped

- **WHEN** a check looks at two prompts and withdraws one
- **THEN** `reconcile` is logged with `checked: 2`, `closed: 1` and `withdrawn: 1`
