## MODIFIED Requirements

### Requirement: Finished turns do not add messages by default

A finished push SHALL be replaced by the card, except that a turn card SHALL be posted for a turn that changed files or ran long (see turn-card). Failed pushes SHALL keep their format and make a sound; low priority pushes SHALL arrive without a sound.

#### Scenario: Turn ends

- **WHEN** a turn ends, `notify.finished` is not true and the turn changed no files and ran under `turnCard.minSeconds`
- **THEN** the card changes and no separate message is sent

#### Scenario: Turn ends with changes

- **WHEN** a turn ends after changing files
- **THEN** the card changes and one turn card is posted
