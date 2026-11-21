# command-menu Specification

## Purpose

The command menu is the phone's main way to find a command: which commands the bot registers for the paired chat, in what order, and how the operator's everyday commands behave.

## Requirements

### Requirement: The menu lists the operator's commands first

The registered command list SHALL start with `/status`, `/stop`, `/model`, `/agent`, `/compact`, `/undo`, `/resume`, `/afk` and `/digest`, in that order, followed by the other commands. Only commands whose feature is available SHALL be listed.

#### Scenario: Order

- **WHEN** every feature is available
- **THEN** the first nine registered commands are the listed ones in the listed order

#### Scenario: Feature off

- **WHEN** the digest is not enabled
- **THEN** `/digest` is not in the registered list

### Requirement: The menu is registered per chat

The bot SHALL register the list for the paired chat only (the chat scope, or all private chats when the pairing is a private chat). It SHALL NOT register a per-topic list, because Telegram has no such scope, and SHALL answer a command used in the wrong place with the existing hint.

#### Scenario: Group pairing

- **WHEN** the paired chat is a group
- **THEN** the list is set with the scope of that chat

#### Scenario: Session command in General

- **WHEN** `/stop` is sent in General
- **THEN** the bot answers with a hint and stops nothing

### Requirement: Registration is idempotent and validated

The bot SHALL register the list only when it differs from the one registered before, or after the chat is paired again. It SHALL check every name against `[a-z0-9_]{1,32}` and every description against 256 characters before the call, and a failed call SHALL be logged and SHALL NOT stop the bridge.

#### Scenario: Unchanged list

- **WHEN** the bridge starts and the list is the same as the stored one
- **THEN** no `setMyCommands` call is made

#### Scenario: Invalid description

- **WHEN** a description is 300 characters long
- **THEN** the bot does not call Telegram with it and logs the reason

### Requirement: /undo reverts the last turn after a confirmation

`/undo` SHALL ask for confirmation with Undo and Cancel buttons, then run the core undo action on the session of the topic. When the action needs a TUI and none is attached it SHALL say the revert needs the Mac.

#### Scenario: Confirmed

- **WHEN** the person taps Undo
- **THEN** the last turn of the session is reverted and the message says so

#### Scenario: No window attached

- **WHEN** `/undo` is sent and the revert needs a TUI that is not attached
- **THEN** the bot says to do it at the Mac and nothing is reverted

### Requirement: /resume wakes a stuck session

In a topic `/resume` SHALL wake that session through the core resume action. In General it SHALL list the stuck sessions with a Resume button each, or say there are none.

#### Scenario: In a topic

- **WHEN** `/resume` is sent in the topic of a suspended session
- **THEN** the core resume action runs for it

#### Scenario: Nothing stuck

- **WHEN** `/resume` is sent in General and no session is stuck
- **THEN** the bot says nothing is stuck

### Requirement: /afk shows the away state and changes nothing

`/afk` SHALL show the away mode, whether the person counts as away, and the overnight state, and SHALL say that the mode is changed at the Mac. It SHALL NOT change the mode.

#### Scenario: Ask while away

- **WHEN** `/afk` is sent while the mode is auto and the person counts as away
- **THEN** the reply shows auto and away and the hint to change it at the Mac

### Requirement: /digest sends the digest on request

`/digest` SHALL send the digest for the period since the last one. When the digest is not enabled it SHALL answer that it is not enabled.

#### Scenario: Digest disabled

- **WHEN** `/digest` is typed and the digest is not enabled
- **THEN** the bot answers that it is not enabled
