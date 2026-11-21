# watch-afk Specification

## Purpose

The bridge pushes a session's questions and notices only when the person is away from the terminal, or when told to. The rules say who counts as away and which sessions are mirrored.

## Requirements

### Requirement: Away is decided once for the whole OpenCode instance

The TUIs SHALL report their last input and the bridge SHALL count the person as away after `away.minutes` (default 10) without input in any attached TUI. With no TUI attached the person SHALL always be away. Keystrokes alone SHALL NOT count as input.

#### Scenario: Two windows, one idle

- **WHEN** one TUI has had input in the last minute and another has not for an hour
- **THEN** the person is not away

#### Scenario: No TUI

- **WHEN** no TUI is attached
- **THEN** the person is away

### Requirement: Away can be forced for the instance

`/oob afk on|off|auto` SHALL force away, force present, or return to the away rule, for the whole instance. Away mode itself SHALL NOT be changeable from a chat.

#### Scenario: Forced away

- **WHEN** `/oob afk on` is run
- **THEN** the person counts as away whatever the input

### Requirement: Each session has its own watch mode

`/oob on [<channel|all>]` SHALL push a session now through one channel or all, `/oob off` SHALL never push it, and `/oob auto` SHALL return it to the away rule, in which a session is mirrored when the person is away and the `rules` pick it (empty rules: all). A mode chosen for a session SHALL be kept across restarts.

#### Scenario: Off wins

- **WHEN** a session is set to off and the person is away
- **THEN** none of its questions or notices are pushed

#### Scenario: Auto while present

- **WHEN** a session is on auto and the person is not away
- **THEN** nothing is pushed for it

### Requirement: Questions and finished turns are pushed

A question SHALL be pushed with its options, a permission SHALL be pushed as a notice that carries answer buttons only when `permissions.remote` allows, and a mirrored top-level session that stops working SHALL send one low-priority push, again each time it is woken and stops. When a prompt is answered in the TUI its notification SHALL be updated to say so, and the first answer, from the phone or the TUI, SHALL win.

#### Scenario: Answered twice

- **WHEN** a question is answered on the phone and then in the TUI
- **THEN** only the first answer is applied and the second gets an "already answered" notice

#### Scenario: Permission with the policy off

- **WHEN** a permission is pushed and `permissions.remote` is off
- **THEN** the notice has no answer buttons

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
