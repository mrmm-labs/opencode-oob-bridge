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

The ▶ Resume button, the sidebar Stuck row and `/oob resume <session>` SHALL wake the session through the host's synthetic-message call. If the host refuses, the notice SHALL say to open the session at the Mac.

#### Scenario: Host refuses

- **WHEN** the wake call is refused
- **THEN** the notice says to open the session at the Mac

#### Scenario: Not suspended

- **WHEN** `/oob resume` names a session with nothing waiting
- **THEN** it says there is nothing to wake
