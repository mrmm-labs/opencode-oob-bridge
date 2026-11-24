## ADDED Requirements

### Requirement: The card has QA and Update buttons while chat is on

While chat is on for the session, the status card SHALL have QA and Update buttons above Stop chat, which do what `/qa` and `/update` do with no topic. With chat off the card SHALL have neither.

#### Scenario: Chat on

- **WHEN** chat is on and the person taps QA
- **THEN** the Q&A instruction is sent to the session once and the tap is answered

#### Scenario: Chat off

- **WHEN** chat is switched off
- **THEN** the card is edited without the buttons, and a tap on an old one is refused
