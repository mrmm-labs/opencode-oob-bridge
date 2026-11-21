# pilot-tui Specification

## Purpose
Each TUI window is a pilot of the server bridge: it shows the bridge's state, sends it commands and reports input, but runs no connector of its own.

## Requirements

### Requirement: The TUI shows the bridge's state through the RPC
The TUI SHALL read status from the server half and show the owner pid and uptime, who counts as away, each channel, the open prompts and the viewed session's settings. A server that is not running the plugin, or does not answer, SHALL show `bridge offline`.

#### Scenario: Bridge up
- **WHEN** `/oob status` runs and the server answers
- **THEN** it shows the owner pid, channels and open prompts

#### Scenario: Server without the plugin
- **WHEN** the RPC is unavailable
- **THEN** the sidebar shows `bridge offline`

### Requirement: One command with sub-commands, and a slash entry for each
`/oob` (alias `/ntfy`) SHALL open a searchable picker of every sub-command with its usage. A unique prefix SHALL run a sub-command, a prefix that fits several SHALL open the picker with those, a missing argument SHALL be asked for alone, and a wrong value SHALL say which values are valid. Every sub-command SHALL also be its own slash entry such as `/oob-chat`.

#### Scenario: Prefix fits one
- **WHEN** `/oob au` is typed
- **THEN** `/oob auto` runs

#### Scenario: Wrong value
- **WHEN** `/oob chat maybe` is typed
- **THEN** the reply lists the valid values and opens that list

### Requirement: The sidebar shows the viewed session
The top of the session sidebar SHALL hold a section for the session in view with Notify, Replies, Away and, only when there are some, Stuck rows. Its size SHALL be `full`, `compact` or `off`, kept in `tui.json` in the state directory.

#### Scenario: Stuck sessions listed
- **WHEN** sessions are suspended with messages waiting
- **THEN** the Stuck row lists them and picking one resumes it

### Requirement: The TUI reports input and answers forms
Each TUI SHALL report its last input for the away rule and SHALL make the reply for a question form the server relays to it.

#### Scenario: Form relayed
- **WHEN** the server relays a form reply to this window
- **THEN** the window replies to the host and tells the server it is done
