## ADDED Requirements

### Requirement: Cards can be turned off

`cards.enabled` (default true) SHALL govern subagent cards. With it false the bridge SHALL NOT post or edit a card, and a subagent's prompts SHALL post as if cards did not exist.

#### Scenario: Off

- **WHEN** cards.enabled is false and a subagent starts and asks a question
- **THEN** no card is posted, and the question is not a reply to anything
