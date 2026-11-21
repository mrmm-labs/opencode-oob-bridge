## ADDED Requirements

### Requirement: A prompt typed at the Mac is shown in the topic

When a session is mirrored to a chat, a prompt typed at the Mac SHALL be posted as its own short silent message beginning `🖥 You at the Mac:`, redacted with the chat rules. A prompt that came from a connector SHALL NOT be posted back, and a repeated event for the same prompt SHALL be posted once. It SHALL NOT be posted when only prompts from a connector are mirrored.

#### Scenario: Typed at the Mac

- **WHEN** a prompt is typed in the TUI of a mirrored session
- **THEN** the topic gets `🖥 You at the Mac: <text>`

#### Scenario: Sent from Telegram

- **WHEN** a prompt sent from Telegram reaches the session
- **THEN** nothing is posted for it

### Requirement: Answers say where they were given

A question or permission answered at the Mac SHALL have its message edited to `✅ Answered at the Mac: <choice>`, and one answered in Telegram to `✅ Answered in Telegram: <choice>`, in both cases without buttons.

#### Scenario: Answered in the TUI

- **WHEN** a question is answered in the TUI
- **THEN** its Telegram message reads `✅ Answered at the Mac: <choice>` with no buttons

### Requirement: The turn card names the origin

The turn card SHALL end with `🖥 Mac` or `📱 Telegram`, the origin of the prompt of that turn, when it is known.

#### Scenario: Telegram prompt

- **WHEN** a turn began with a prompt from Telegram
- **THEN** its card shows `📱 Telegram`
