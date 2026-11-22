## ADDED Requirements

### Requirement: An approval is answered only in the app

A chat message for an approval SHALL carry one button, "📱 Review & approve", that opens the approval in the Mini App with the start parameter `a_<approval id>`, and SHALL carry no Approve or Deny button. A tap on an Approve or Deny button of an earlier message SHALL apply nothing and answer with a toast that the decision is made in the app.

#### Scenario: Message buttons

- **WHEN** an approval request reaches a chat
- **THEN** the message has one "📱 Review & approve" button

#### Scenario: Old inline button

- **WHEN** an Approve button of an earlier version is tapped
- **THEN** nothing is decided and the toast says to open the app

### Requirement: Approval messages go to a fixed place

An approval message SHALL be sent to the operator's private chat when the bot can reach it, and otherwise to a topic named "Approvals" in the paired forum chat, created on first use. It SHALL NOT be sent to General or to a session's topic. A failed private send SHALL not be tried again for ten minutes.

#### Scenario: Direct message available

- **WHEN** the operator has started the bot
- **THEN** the approval message is in the private chat

#### Scenario: No direct message

- **WHEN** sending to the private chat fails
- **THEN** the message is in the "Approvals" topic, which is created if it is missing

#### Scenario: Never General

- **WHEN** neither place can be used
- **THEN** nothing is posted to General and the request is reported as undeliverable on that channel
