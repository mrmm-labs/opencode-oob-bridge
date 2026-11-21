## ADDED Requirements

### Requirement: Channels report liveness

A channel with a receive loop SHALL report the time of its last answer to a poll, the time of its last accepted send, and how long its loop has made no step. A loop waiting for a token SHALL report no silence. `/oob status` SHALL show the last poll and send and a warning when the loop has been silent for more than 150 seconds.

#### Scenario: Loop stuck on a call

- **WHEN** a call in the receive loop never returns
- **THEN** the reported silence grows and `/oob status` warns

### Requirement: A stuck receive loop restarts the bridge

The server half SHALL check the channels every 30 seconds. When an enabled channel's loop has been silent for more than 150 seconds it SHALL log `bridge_stalled` with the channel, the silence, the age of the last poll and last send, and the step, and SHALL restart the bridge while keeping the process lock.

#### Scenario: Silent loop

- **WHEN** a loop is silent past the limit
- **THEN** `bridge_stalled` is logged once and the bridge restarts

#### Scenario: Loop that steps

- **WHEN** a loop steps, even through errors
- **THEN** nothing is restarted

### Requirement: The heartbeat follows the loop

When a channel's receive loop has been silent for more than 150 seconds the dead-man heartbeat SHALL be `degraded` with the reason `poll_stalled:<channel>`.

#### Scenario: Wedged loop

- **WHEN** a channel reports a loop silent past the limit
- **THEN** the heartbeat is degraded with that reason
