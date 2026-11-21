# stuck-session-alert Specification

## Purpose

A session can hold messages it is not working on: a prompt that was queued and never ran, or subagent results nobody delivered. The bridge tells the person and offers a way to wake it.

## Requirements

### Requirement: A suspended session with waiting messages is announced

When a session holds messages it is not working on, the bridge SHALL send a notice to the session's topic with a ▶ Resume button.

#### Scenario: Queued prompt never ran

- **WHEN** a prompt was queued for a session that is suspended
- **THEN** the topic gets a notice with a ▶ Resume button

### Requirement: Resume wakes the session through the host

The ▶ Resume button, the sidebar Stuck row and `/oob resume <session>` SHALL wake the session through the host's synthetic-message call and SHALL then report an outcome that was observed: the session is working, its waiting messages were taken, or the call had no effect. If the host refuses, the notice SHALL say to open the session at the Mac.

#### Scenario: Host refuses

- **WHEN** the wake call is refused
- **THEN** the notice says to open the session at the Mac

#### Scenario: Not suspended

- **WHEN** `/oob resume` names a session with nothing waiting
- **THEN** it says there is nothing to wake

#### Scenario: Woke

- **WHEN** the session starts working within 30 seconds of the call
- **THEN** the outcome is working and the alert says so

#### Scenario: No effect

- **WHEN** the call is accepted but the session neither works nor drains within 30 seconds
- **THEN** the outcome is no effect and the alert says to open it at the Mac

### Requirement: The alert shows the outcome and cannot be used twice

After a Resume the alert SHALL be edited to show its outcome, and its button SHALL be removed. A second tap on an old alert SHALL say that it was already used.

#### Scenario: Second tap

- **WHEN** the button of an alert that was already used is tapped
- **THEN** the bot says it was already used and wakes nothing

### Requirement: One alert per suspension

The bridge SHALL send one alert for a suspension, SHALL send another only when the number of waiting messages grows or after six hours, and SHALL remove or edit an alert whose session woke by another route.

#### Scenario: Same suspension

- **WHEN** a session stays suspended with the same waiting messages for two hours
- **THEN** only one alert exists

#### Scenario: Session woke at the Mac

- **WHEN** the person resumes the session in the TUI
- **THEN** the earlier alert is edited to say it resumed

### Requirement: Every resume leaves evidence

Each Resume SHALL log a `resume` event with the session, the source (button, command or sidebar), the outcome and the time.

#### Scenario: Button tapped

- **WHEN** the person taps Resume
- **THEN** one `resume` line records the source `button` and the outcome

### Requirement: Resume can be checked against a real session

The repository SHALL provide an opt-in check that starts an isolated OpenCode server, creates a stuck session, resumes it through the bridge and asserts the outcome, and SHALL NOT run it in CI.

#### Scenario: Real check

- **WHEN** the check runs against an isolated server
- **THEN** it ends with the outcome working or fails with the observed outcome
