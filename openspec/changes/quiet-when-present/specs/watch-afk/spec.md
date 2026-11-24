## MODIFIED Requirements

### Requirement: Each session has its own watch mode

`/oob on [<channel|all>]` SHALL route a session through one channel or all **when the person is away**, whatever the `rules` say; `/oob off` SHALL never push it; and `/oob auto` SHALL return it to the away rule, in which a session is mirrored when the person is away and the `rules` pick it (empty rules: all). A mode chosen for a session SHALL be kept across restarts. A mode SHALL NOT make the bridge send while the person is present.

#### Scenario: Off wins

- **WHEN** a session is set to off and the person is away
- **THEN** none of its questions or notices are pushed

#### Scenario: Auto while present

- **WHEN** a session is on auto and the person is not away
- **THEN** nothing is pushed for it

#### Scenario: On while present

- **WHEN** a session is set to on and the person is at the keyboard
- **THEN** nothing is pushed for it, and it routes once the person is away

### Requirement: Away is decided once for the whole OpenCode instance

The TUIs SHALL report their last input and the bridge SHALL count the person as away after `away.minutes` (default 10) without input in any attached TUI, subject to the rules below. With no TUI attached the person SHALL be away. Keystrokes alone SHALL NOT count as input.

#### Scenario: Two windows, one idle

- **WHEN** one TUI has had input in the last minute and another has not for an hour
- **THEN** the person is not away

#### Scenario: No TUI

- **WHEN** no TUI is attached
- **THEN** the person is away

### Requirement: Away can be forced for the instance

`/afk` and `/back` (in a chat) and `/oob afk on|off|auto` (in the TUI) SHALL force away, force here, or return to the rules, for the whole instance. A forced mode SHALL end by itself.

#### Scenario: Forced away

- **WHEN** `/afk` is sent
- **THEN** the person counts as away whatever the input, until the time-box ends

### Requirement: Away can be forced for a limited time

`/afk <duration>` and `/back <duration>` SHALL force the mode for that long and then return to the rules. The remaining time SHALL be shown in the sidebar and in `/oob status`.

#### Scenario: Eight hours

- **WHEN** `/oob afk on 8h` is run
- **THEN** the person counts as away for eight hours and then the rules decide

## ADDED Requirements

### Requirement: Present is quiet

While the person does not count as away, the bridge SHALL send nothing to a chat connector: no message, no typing indicator and no edit. Receiving SHALL continue. Coming back (input in a TUI) SHALL stop sends at once and drop what was queued. The only way to send while present SHALL be a forced `/afk`, which ends by itself.

#### Scenario: At the keyboard

- **WHEN** a turn finishes in a session set to on while the person is typing
- **THEN** no message is sent and no typing indicator is shown

#### Scenario: Coming back

- **WHEN** the person types while a typing indicator and queued messages are pending
- **THEN** they stop and the queue is dropped

#### Scenario: Timed override

- **WHEN** `/afk 2h` is run
- **THEN** pushes continue for two hours whatever the input

### Requirement: Going away sends one digest

When the person becomes away, the bridge SHALL send, for each session with held events, one message in its topic naming the finished and failed turns and the questions and approvals still open, and SHALL send one combined message to channels without topics. It SHALL NOT send the held events one by one. Answered prompts SHALL NOT be listed as open.

#### Scenario: Three turns and a question

- **WHEN** three turns finished and a question was asked while present, then the person goes away
- **THEN** one message is sent for that session, listing 3 finished and 1 question

#### Scenario: Nothing held

- **WHEN** the person goes away and nothing happened
- **THEN** no digest is sent

### Requirement: The mode of every session can be set at once

The `route` operation SHALL accept `root: "all"` and set the mode of every known top-level session. `/auto` in a chat SHALL put every session on `auto` and SHALL NOT offer `on` or `off`.

#### Scenario: Six sessions on

- **WHEN** `route` is called with `root: "all"` and mode `auto`
- **THEN** all six sessions report auto

### Requirement: Sessions default to auto

A session SHALL start on `auto`, including one started from a chat or given chat. A subagent session SHALL follow its top-level session.

#### Scenario: Started from Telegram

- **WHEN** a session is started with `/new`
- **THEN** its mode is auto and it routes to that channel when the person is away

### Requirement: Rules decide away

The bridge SHALL decide away from these rules, in this order, the first that holds winning: a forced `/afk` or `/back` until it ends; the screen locked when `away.lock` is true; the machine slept with no input since when `away.sleep` is true; a message from the paired chat within `away.phoneMinutes` (default 30; 0 turns the rule off); the first window of `away.schedule` that holds; no TUI attached; no input for `away.minutes` (default 10); otherwise the person is here. `away.lock`, `away.sleep` and `away.schedule` SHALL be off by default.

#### Scenario: A Telegram message

- **WHEN** the person writes in Telegram while the TUI was used a minute ago
- **THEN** the state is away for 30 minutes

#### Scenario: Each message extends

- **WHEN** a second message arrives 20 minutes after the first
- **THEN** away lasts until 30 minutes after the second

#### Scenario: Expiry

- **WHEN** 30 minutes pass without a message and the TUI was used a minute ago
- **THEN** the state is here, by the input rule

#### Scenario: Precedence

- **WHEN** `/back` is active and a Telegram message arrives
- **THEN** the state stays here until the `/back` ends

### Requirement: A glance does not flip it

While away because of a Telegram message, input in a TUI SHALL end it only after `away.graceSeconds` (default 60) of continuous input since that message.

#### Scenario: A glance

- **WHEN** one keystroke follows the message
- **THEN** the state is still away

#### Scenario: Working

- **WHEN** input continues for the grace
- **THEN** the state is here

### Requirement: Forced modes end by themselves

`/afk [time]` and `/back [time]`, in a chat and in the TUI (`/oob afk on|off [time]`), SHALL force away and here until the time given or, when none is given, `away.overrideMinutes` (default 120), and then the rules SHALL decide again. No forced mode SHALL be open-ended.

#### Scenario: Default time-box

- **WHEN** `/afk` is sent with no time
- **THEN** the state is away for two hours and then follows the rules

### Requirement: Settings are layered and tighten one way

Settings SHALL come from built-in defaults, then the config file, then per-session overrides in the settings store. A session's `awayMinutes` SHALL NOT be shorter than `away.minutes`; a session mode `on` SHALL NOT send while here.

#### Scenario: A session waits longer

- **WHEN** a session has `awayMinutes` 60 and the TUI has been idle 15 minutes
- **THEN** the session is not routed, and is after 60 minutes

#### Scenario: A shorter value

- **WHEN** a session has `awayMinutes` 2
- **THEN** it is routed no sooner than the instance is

### Requirement: The state shows why

The status snapshot SHALL carry the state, the rule that decided it and when the rule ends. When the state becomes away or its rule changes while away, the bridge SHALL send one line saying so to chat channels, and SHALL send nothing when the state becomes here.

#### Scenario: Becoming away

- **WHEN** the person writes in Telegram
- **THEN** one line names the Telegram rule and its end

#### Scenario: Becoming here

- **WHEN** the person types for the grace
- **THEN** no line is sent
