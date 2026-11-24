## ADDED Requirements

### Requirement: /qa and /update are in the menu and in both help texts

The registered command list SHALL include `/qa` and `/update`, and `/help` SHALL name them in a session's topic and in General.

#### Scenario: Registered

- **WHEN** the command list is registered
- **THEN** it includes `qa` and `update`

#### Scenario: Help

- **WHEN** `/help` is sent in a topic or in General
- **THEN** the answer names `/qa` and `/update`
