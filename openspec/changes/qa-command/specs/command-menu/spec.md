## ADDED Requirements

### Requirement: /qa is in the menu and in both help texts

The registered command list SHALL include `/qa`, and `/help` SHALL name it in a session's topic and in General.

#### Scenario: Registered

- **WHEN** the command list is registered
- **THEN** it includes `qa`

#### Scenario: Help

- **WHEN** `/help` is sent in a topic or in General
- **THEN** the answer names `/qa`
