## MODIFIED Requirements

### Requirement: Only a one-tap question has answer buttons in a chat

A question SHALL show answer buttons in a chat only when it has one field, the field is single-select, it has two to four options, and every option label is at most 48 characters, not counting a "(Recommended)" suffix. Each option SHALL have one button on its own row, reading `<number> <label>`, with a ★ before the label of a recommended option, cut with "…" when it is too long; a tap SHALL answer with the option exactly as the form names it. Any other question SHALL show one button, "📱 Answer in app", that opens that question in the Mini App with the start parameter `f_<pending id>`, and a one-tap question that allows typing SHALL also have that button under its options. A reply to the message or `#<id> <answer>` SHALL still answer either kind.

#### Scenario: Yes or no

- **WHEN** a question has one single-select field with the options Yes and No
- **THEN** the message has a Yes and a No button

#### Scenario: Long options with a recommended one

- **WHEN** a single-select question has options of 40, 20 and 17 characters and the first ends with "(Recommended)"
- **THEN** the message has three buttons, one per row, the first marked ★, and a tap on it answers with the option including its suffix

#### Scenario: Two fields

- **WHEN** a form has two fields
- **THEN** the message has one button, "📱 Answer in app", and no option buttons

#### Scenario: Multi-select, long option or free text only

- **WHEN** a single field is multi-select, or has an option longer than 48 characters without its suffix, or has more than four options, or has no options
- **THEN** the message has one button, "📱 Answer in app"
