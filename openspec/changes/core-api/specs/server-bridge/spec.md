## ADDED Requirements

### Requirement: The core API listener follows the single owner

Only the instance that runs the bridge SHALL listen for the core API. When the bridge restarts the listener SHALL restart with it, and when the owner changes the new owner SHALL take over the listener. A second process SHALL NOT bind it.

#### Scenario: Bridge restart

- **WHEN** `/oob restart` runs
- **THEN** the API listener closes and opens again on the same address

#### Scenario: Second process

- **WHEN** another OpenCode server process holds the owner lock
- **THEN** this process does not bind the core API address
