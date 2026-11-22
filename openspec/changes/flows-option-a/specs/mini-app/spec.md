## ADDED Requirements

### Requirement: The app opens a question from its message

The start parameter `f_<pending id>` SHALL open that question on the question screen. A question that is no longer pending SHALL show that it is no longer open instead.

#### Scenario: Deep link

- **WHEN** the app is opened with `f_p5gf` and that question is pending
- **THEN** the question screen is shown

#### Scenario: Already closed

- **WHEN** the question was answered or withdrawn
- **THEN** the app says it is no longer open

### Requirement: Questions are answered on one screen

The question screen SHALL show every question of the form in its own group, with its options, an "Other… type an answer" row where typing is allowed, and one main button "Send answers". An option whose label ends with "(Recommended)" SHALL be selected and tagged "Recommended". Send answers SHALL stay disabled until every required single-select question has a value, and nothing SHALL be sent before it.

#### Scenario: Recommended pre-selected

- **WHEN** a question has an option ending with "(Recommended)"
- **THEN** it is selected, tagged, and sent without the suffix

#### Scenario: Nothing sent early

- **WHEN** the person changes answers and does not tap Send
- **THEN** the host receives nothing

### Requirement: Choices are kept on the phone until Send

What the person chose for a question SHALL be kept on the phone under the pending id until Send or until the question is no longer pending. It SHALL survive a reload of the app and a bridge restart.

#### Scenario: Reload before Send

- **WHEN** the person chooses, closes the app and opens the question again
- **THEN** the choices are still there

#### Scenario: Restart before Send

- **WHEN** the bridge restarts while the screen is open with choices made
- **THEN** the choices are kept and Send answers still works

### Requirement: Send answers closes the flow

After the bridge accepts the answers the app SHALL give a success haptic and close, and the Telegram message SHALL be edited to "✅ Answered in app · <short answers>", with the answers passed through the secret filter and redaction, joined with " · " and cut to 120 characters. A refusal SHALL keep the screen and its choices and say why.

#### Scenario: Sent

- **WHEN** the person taps Send answers and the bridge accepts
- **THEN** the app closes and the message reads "Answered in app" with the masked answers

#### Scenario: Refused

- **WHEN** the bridge refuses the answers
- **THEN** the screen stays with its choices and shows the reason

### Requirement: An approval is reviewed and decided in the app

The approval screen SHALL show who asks, what, the level, the time left, and a note that the value is never sent to Telegram or the AI, with Deny and an approve button named for the factor ("Approve with Face ID" for biometric; the other factors in `approvals.l2.factors` offered as the engine allows).

#### Scenario: Face ID

- **WHEN** an L2 approval is opened and biometric is enrolled
- **THEN** the screen offers Deny and "Approve with Face ID"

## MODIFIED Requirements

### Requirement: Forms behave as in the chat

A form SHALL be answered on the question screen, in one reply made by the answer action, and a form that cannot be sent without a TUI SHALL be shown without a Send button.

#### Scenario: Three-field form

- **WHEN** the person answers a three-field form and taps Send answers
- **THEN** one reply is made with all three answers
