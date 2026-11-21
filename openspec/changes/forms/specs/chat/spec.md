## MODIFIED Requirements

### Requirement: Permissions are never answered from a channel

A permission prompt SHALL NOT be granted or denied from a channel unless `permissions.remote` allows it (default off). With it off the message SHALL say to answer in the TUI and SHALL have no Allow or Deny button.

#### Scenario: Permission pushed

- **WHEN** a session asks for a permission and `permissions.remote` is off
- **THEN** the Telegram message has no Allow or Deny button

#### Scenario: Policy on

- **WHEN** a session asks for a permission and `permissions.remote` is `once`
- **THEN** the message has Allow once and Deny buttons
