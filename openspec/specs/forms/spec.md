# forms Specification

## Purpose

Forms lets the operator answer a multi-field form, and approve a permission when policy allows, from a phone without a mistake costing anything: one field at a time, a review before the reply, and a logged, opt-in permission path.

## Requirements

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

### Requirement: Only a one-tap question has answer buttons in a chat

A question SHALL show answer buttons in a chat only when it has one field, the field is single-select, it has two to four options, and every option label is at most 24 characters. Any other question SHALL show one button, "📱 Answer in app", that opens that question in the Mini App with the start parameter `f_<pending id>`. A reply to the message or `#<id> <answer>` SHALL still answer either kind.

#### Scenario: Yes or no

- **WHEN** a question has one single-select field with the options Yes and No
- **THEN** the message has a Yes and a No button

#### Scenario: Two fields

- **WHEN** a form has two fields
- **THEN** the message has one button, "📱 Answer in app", and no option buttons

#### Scenario: Multi-select, long option or free text only

- **WHEN** a single field is multi-select, or has an option longer than 24 characters, or has more than four options, or has no options
- **THEN** the message has one button, "📱 Answer in app"

### Requirement: Buttons of a message sent before an upgrade do nothing

A tap on a stepper button of an earlier version SHALL apply nothing and SHALL answer with a toast that the question moved to the app.

#### Scenario: Old stepper button

- **WHEN** a stepper button of an earlier version is tapped
- **THEN** nothing reaches the host and the toast says to open the app

### Requirement: A form OpenCode drops is withdrawn, not answered

When a form OpenCode no longer holds was not answered through the bridge and not seen answered at the Mac, reconcile SHALL mark it `withdrawn` and edit its message to "⚪ Withdrawn: the session stopped asking" with no buttons. A form found answered or cancelled SHALL keep that state. A permission request OpenCode no longer holds SHALL still be closed as answered at the Mac.

#### Scenario: Tool interrupted

- **WHEN** a session is interrupted while a question is open and OpenCode drops the form
- **THEN** the pending entry is `withdrawn` and the message reads "Withdrawn: the session stopped asking"

#### Scenario: Reply to a form that is gone

- **WHEN** an app answer finds the form gone
- **THEN** the entry is `withdrawn` and the person is told the session no longer asks it
