## ADDED Requirements

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

## REMOVED Requirements

### Requirement: A multi-field form is answered one field at a time

**Reason**: The stepper held its choices in the bridge and lost them on a restart; the app answers every field on one screen.

**Migration**: A multi-field form shows "📱 Answer in app".

### Requirement: Each field type has its own control

**Reason**: Telegram no longer renders controls per field; the app does.

**Migration**: Single-select, multi-select and typed answers are made in the app screen.

### Requirement: The answers are reviewed before the reply

**Reason**: The app screen shows every question and answer at once and sends on one button.

**Migration**: "Send answers" in the app.
