## MODIFIED Requirements

### Requirement: The card has Diff, Continue and Stop buttons

Diff SHALL send the session's patch as a document. Continue SHALL send `continue` as a prompt with the session's delivery mode, and SHALL be left out when chat is off for the session. QA SHALL do what `/qa` with no topic does, and Update SHALL do what `/update` with no topic does; both SHALL be shown next to Continue and SHALL be left out when chat is off, and the row SHALL hold at most five buttons. Stop SHALL interrupt the running turn, or say that nothing is running.

#### Scenario: Diff

- **WHEN** the person taps Diff
- **THEN** a patch document is sent to the topic

#### Scenario: Continue with chat off

- **WHEN** chat is off for the session
- **THEN** the card has no Continue, QA or Update button

#### Scenario: QA

- **WHEN** the person taps QA with chat on
- **THEN** the Q&A instruction is sent to the session once and the tap is answered

#### Scenario: Stop while idle

- **WHEN** the person taps Stop and no turn is running
- **THEN** the bot says nothing is running and interrupts nothing

#### Scenario: Update

- **WHEN** the person taps Update with chat on
- **THEN** the progress-update instruction is sent to the session once and the tap is answered
