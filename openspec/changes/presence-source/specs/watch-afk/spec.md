## ADDED Requirements

### Requirement: Presence at the Mac comes only from input at the Mac

The bridge SHALL count the person as at the Mac only for a prompt typed in a TUI or use of the TUI's `/oob`. A Telegram message, button or reply, mini-app activity, a prompt delivered by an agent, a subagent or an RPC call, an answer to a form or permission, and a TUI with no input SHALL NOT count.

#### Scenario: A Telegram prompt

- **WHEN** a message sent from Telegram reaches a session
- **THEN** the person does not count as at the Mac

#### Scenario: An agent prompt

- **WHEN** a subagent, or a prompt the bridge did not send into an unviewed session, reaches a session
- **THEN** the person does not count as at the Mac

#### Scenario: Typed at the Mac

- **WHEN** a prompt is typed in a TUI into a viewed top-level session
- **THEN** the person counts as at the Mac

#### Scenario: A reply

- **WHEN** a form or permission is answered, from Telegram, the app or the TUI
- **THEN** that answer alone does not change the state

### Requirement: Phone activity keeps the person away

A Telegram message, button or reply, or a request of the mini-app, SHALL count as being on the phone: it SHALL keep the person away, or make them away when the state is auto, until input at the Mac has continued for the grace time.

#### Scenario: Auto

- **WHEN** the state is auto and the person writes from Telegram
- **THEN** the state is away and a reply from Telegram never turns it to here

#### Scenario: The mini-app

- **WHEN** the mini-app opens, streams or answers
- **THEN** the person counts as on the phone

### Requirement: The source of presence is logged and shown

Each input SHALL have a source: tui, telegram, app, agent or rpc. Each change of the state SHALL be logged with the source that decided it, and the explanation SHALL say which: "here: TUI input 2m ago" or "away: phone active 30s ago".

#### Scenario: Away from the phone

- **WHEN** the person writes from Telegram while here
- **THEN** the log has a change to away with source telegram and the explanation names the phone

### Requirement: A held question is pushed when the state turns away

A question or permission held while the person counted as here SHALL be sent, with its buttons and once, when the state turns away, if OpenCode still lists it as open.

#### Scenario: Turns away

- **WHEN** a question is held and the person then writes from Telegram
- **THEN** the question is sent once with its buttons

#### Scenario: Answered meanwhile

- **WHEN** the held question is answered before the state turns away
- **THEN** nothing is sent for it
