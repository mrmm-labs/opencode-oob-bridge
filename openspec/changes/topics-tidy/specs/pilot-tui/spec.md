## ADDED Requirements

### Requirement: The RPC can tidy topics

The RPC op `topics` with `apply` and `idleHours` SHALL do what `/topics` does, without an owner check, and SHALL refuse an `idleHours` that is not a whole number of hours from 1 to 8760.

#### Scenario: Dry run

- **WHEN** the op is called with no arguments
- **THEN** it answers with the list and closes nothing

#### Scenario: Bad hours

- **WHEN** `idleHours` is 0 or 1.5
- **THEN** the op refuses it
