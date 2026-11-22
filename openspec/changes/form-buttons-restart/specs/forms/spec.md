## ADDED Requirements

### Requirement: Buttons of an open question work after a restart

A tap on the buttons of a question that is still open SHALL NOT be lost because the bridge restarted. The form SHALL start again from its first question (a single question from an empty selection), the person SHALL be told the bridge restarted, and the stale tap SHALL NOT be applied. A tap on a question that is no longer open SHALL say so.

#### Scenario: Restart between the asking and the tap

- **WHEN** a two-question form was asked, the bridge restarted, and a button is tapped
- **THEN** the message shows question 1 again, a toast says the bridge restarted, nothing is sent to the host, and picking both answers then Send answers the form

#### Scenario: A closed form

- **WHEN** a button of a form already answered is tapped
- **THEN** the toast says it is no longer active and nothing is sent

### Requirement: Taps on a question are logged

Each choice, Send or Done, and the reply that follows SHALL be logged with the prompt id, the step and the outcome, and a failed reply SHALL be logged with its reason. Answer text SHALL NOT be logged.

#### Scenario: A two-field form

- **WHEN** two fields are chosen and Send is tapped
- **THEN** the log has two `form_select`, one `form_submit` and one `form_reply_ok`, and no answer text
