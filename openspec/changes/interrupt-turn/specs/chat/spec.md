## ADDED Requirements

### Requirement: Interrupt asks first and only the owner may use it

`/interrupt` in a session topic SHALL answer "Interrupt the running turn?" with yes and no, and only yes SHALL abort the turn through the host's `session.interrupt`. The command, the status card's button and the tap SHALL be refused for every Telegram user but the paired owner, and for everyone when the owner is not known.

#### Scenario: Confirmed

- **WHEN** the owner sends `/interrupt` in the topic of a working session and taps yes
- **THEN** the host is asked to interrupt that session once

#### Scenario: Declined

- **WHEN** the owner taps no
- **THEN** nothing is interrupted and the topic says the turn was left running

#### Scenario: Not the owner

- **WHEN** another member of the group sends `/interrupt` or taps the button or yes
- **THEN** nothing is interrupted and they are told only the owner may

#### Scenario: Idle session

- **WHEN** `/interrupt` is sent for a session that is not working
- **THEN** no menu is shown and the topic says there is nothing to interrupt

### Requirement: Interrupt reports what happened

After the abort the topic SHALL get a short result. When the host stopped a turn it SHALL say "Interrupted; send a message to continue" and what became of queued messages; when the host did not stop one, or failed, it SHALL say so and what to do. Messages the bridge holds SHALL go on as a new prompt and messages in the host's inbox SHALL stay there; neither SHALL be dropped. Every attempt SHALL be logged with the trace id.

#### Scenario: Held messages

- **WHEN** two messages are held by the bridge and the turn is interrupted
- **THEN** both are sent to the session once and the result says so

#### Scenario: Messages in the host's inbox

- **WHEN** the host's inbox holds three messages after the interrupt
- **THEN** the result says three messages wait and are run by the next message or ▶ Resume

#### Scenario: The host stops nothing

- **WHEN** the bridge thinks the session is working and the host answers `interrupted: false`
- **THEN** the result says the turn may belong to another OpenCode process

#### Scenario: The call fails

- **WHEN** the host call throws
- **THEN** the topic shows a short reason, and the log has the failure with the trace id
