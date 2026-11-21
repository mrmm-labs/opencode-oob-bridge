## MODIFIED Requirements

### Requirement: Questions and finished turns are pushed

A question SHALL be pushed with its options, a permission SHALL be pushed as a notice that carries answer buttons only when `permissions.remote` allows, and a mirrored top-level session that stops working SHALL send one low-priority push, again each time it is woken and stops. When a prompt is answered in the TUI its notification SHALL be updated to say so, and the first answer, from the phone or the TUI, SHALL win.

#### Scenario: Answered twice

- **WHEN** a question is answered on the phone and then in the TUI
- **THEN** only the first answer is applied and the second gets an "already answered" notice

#### Scenario: Permission with the policy off

- **WHEN** a permission is pushed and `permissions.remote` is off
- **THEN** the notice has no answer buttons
