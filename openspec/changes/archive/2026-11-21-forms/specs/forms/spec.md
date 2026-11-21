## Purpose

Forms lets the operator answer a multi-field form, and approve a permission when policy allows, from a phone without a mistake costing anything: one field at a time, a review before the reply, and a logged, opt-in permission path.

## ADDED Requirements

### Requirement: A multi-field form is answered one field at a time

A form with several fields SHALL be shown as one message that is edited per field, with the field title, its options as buttons, a progress marker, a Back button, and a ✏️ button when the field allows a typed answer. Choices SHALL be kept in the bridge until Submit, and nothing SHALL reach the host before it.

#### Scenario: Three fields

- **WHEN** a form with three fields is sent
- **THEN** the message shows field 1 of 3 and moves to field 2 after a choice

#### Scenario: Abandoned

- **WHEN** the person answers two fields and stops
- **THEN** the host receives nothing

### Requirement: Each field type has its own control

A single-select field SHALL take one tap. A multi-select field SHALL show toggle buttons with a tick on chosen options and a Done button. A field that allows free text SHALL take the person's reply to the bot's prompt. More than eight options SHALL be paged with Prev and Next, and a multi-select choice SHALL survive paging.

#### Scenario: Multi-select across pages

- **WHEN** the person ticks an option on page 1, goes to page 2 and back
- **THEN** the option is still ticked

#### Scenario: Free text

- **WHEN** the person taps ✏️ and replies with text
- **THEN** the text is the answer to that field

### Requirement: The answers are reviewed before the reply

After the last field the message SHALL list every answer with Submit, Edit and Cancel. Submit SHALL send one form reply. Cancel SHALL send none. The first answer SHALL win, whether it comes from the phone or the TUI.

#### Scenario: Submit

- **WHEN** the person taps Submit
- **THEN** one form reply is made with all answers

#### Scenario: Answered at the Mac first

- **WHEN** the form is answered in the TUI while the stepper is open
- **THEN** the message says it was answered in the TUI and has no buttons

### Requirement: A form that cannot be sent shows no buttons

Because only a TUI can make a form reply, with no TUI attached the card SHALL say to answer at the Mac and SHALL show no buttons.

#### Scenario: No window

- **WHEN** a form arrives and no TUI is attached
- **THEN** the card says to answer at the Mac and has no buttons

### Requirement: Permission buttons follow permissions.remote

With `permissions.remote` `off` (the default) a permission message SHALL have no buttons. With `once` it SHALL show Allow once and Deny. With `all` it SHALL also show Always. The reply SHALL be made through the host's permission reply, and the message SHALL end with who answered, from which channel and when.

#### Scenario: Off

- **WHEN** a permission is asked and the policy is off
- **THEN** the message has no buttons and says to answer in the TUI

#### Scenario: Once

- **WHEN** the policy is `once` and the person taps Allow once
- **THEN** the host receives an allow-once reply and the message shows "Allowed once · via telegram"

#### Scenario: Always needs all

- **WHEN** the policy is `once`
- **THEN** there is no Always button

### Requirement: Permission answers are logged

Every permission answer from a channel SHALL be logged with the session, the action, the choice, the channel and the time, without the resources' content beyond what the message shows.

#### Scenario: Denied from the phone

- **WHEN** the person taps Deny
- **THEN** one log line records the deny with the channel
