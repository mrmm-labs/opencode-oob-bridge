## ADDED Requirements

### Requirement: Permissions that cannot be answered in a chat are announced by one digest

When `permissions.notify` is `digest` (the default) and a permission cannot be answered from a channel, the bridge SHALL post one message per root session to each chatting channel, and SHALL edit it in place as permissions arrive and are answered or cancelled. The message SHALL show the number waiting and a breakdown by agent and action. It SHALL be edited at most once every 10 seconds, and SHALL read "none waiting" when the count reaches zero. Quiet hours SHALL apply to it.

#### Scenario: Many permissions

- **WHEN** a subagent asks for the same permission 58 times
- **THEN** one message shows the count and the breakdown, and it is edited as the count changes

#### Scenario: All answered

- **WHEN** the last waiting permission is answered at the Mac
- **THEN** the message reads "none waiting"

### Requirement: The notify mode

`permissions.notify` SHALL be `digest`, `all` or `off`. With `all` each permission SHALL be posted as its own message. With `off` none SHALL be posted to a chat, and the permissions waiting SHALL still be listed in the status.

#### Scenario: Off

- **WHEN** `notify` is `off` and a permission is asked
- **THEN** nothing is posted to the chat and `/oob status` lists it

### Requirement: Answerable permissions are always posted with their buttons

When `permissions.remote` is `once` or `all`, the bridge SHALL post each permission with its buttons whatever `permissions.notify` says.

#### Scenario: Remote on, notify off

- **WHEN** `remote` is `once`, `notify` is `off` and a permission is asked
- **THEN** it is posted with its buttons
