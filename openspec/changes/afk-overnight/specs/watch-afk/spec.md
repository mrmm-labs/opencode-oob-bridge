## ADDED Requirements

### Requirement: Away can be forced for a limited time

`/oob afk on <duration>` SHALL force away for that long and then return to auto. The remaining time SHALL be shown in the sidebar and in `/oob status`.

#### Scenario: Eight hours

- **WHEN** `/oob afk on 8h` is run
- **THEN** the person counts as away for eight hours and then the mode is auto

### Requirement: Coming back shows what happened

When input resumes in a TUI after the person counted as away, the TUI SHALL show once a summary of the time away: pushes sent, questions answered from a chat, sessions that finished or failed, and the state of the overnight plan.

#### Scenario: Back at the keyboard

- **WHEN** the person types after two hours away
- **THEN** one summary of those two hours is shown
