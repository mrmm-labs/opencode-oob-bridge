## Purpose

The dead-man heartbeat lets a receiver outside the Mac notice that the bridge has died or hung, which the bridge cannot report itself.

## ADDED Requirements

### Requirement: The bridge sends a heartbeat to a configured receiver

When `deadman.url` is set the owning bridge SHALL send an HTTPS POST with a bearer token every `deadman.intervalSeconds` (default 30). The heartbeat SHALL be off when no URL is set. The URL SHALL be https, except for a loopback address, and the token SHALL come from a secret reference.

#### Scenario: Not configured

- **WHEN** no `deadman.url` is set
- **THEN** no heartbeat is sent

#### Scenario: Plain http

- **WHEN** the URL is `http://example.com/beat`
- **THEN** the bridge refuses it, logs why and sends nothing

### Requirement: Only the owner sends heartbeats

Exactly one stream of heartbeats SHALL leave the machine: from the instance that runs the bridge. Other instances in the process and other processes SHALL NOT send.

#### Scenario: Two instances in one process

- **WHEN** two plugin instances run in one process
- **THEN** the receiver sees one heartbeat per interval

### Requirement: The heartbeat carries no session data

The payload SHALL hold only the payload version, an instance id, a sequence number, the time, the state, reason codes, the bridge version, the pid and a connected flag per channel. It SHALL NOT hold session titles, paths, chat ids, usernames or message text.

#### Scenario: Payload fields

- **WHEN** a heartbeat is sent
- **THEN** every field is one of the listed ones

### Requirement: A health self-check sets the state

Before each heartbeat the bridge SHALL run the same code path as the TUI status call, check that its answer holds JSON values only, that the RPC is registered and that this process holds the owner lock, and read each enabled channel's connected flag. A failed check SHALL set the state to degraded with reason codes, and a check that throws SHALL do the same.

#### Scenario: Status cannot be answered

- **WHEN** the snapshot would be refused by the host as invalid output
- **THEN** the heartbeat state is degraded with the reason `snapshot_invalid`

#### Scenario: Channel down

- **WHEN** an enabled channel is not connected
- **THEN** the state is degraded with `channel_down:<id>`

### Requirement: A planned stop does not look like an outage

On a restart, a dispose or a graceful stop the bridge SHALL send a heartbeat with the state `stopping` before it stops.

#### Scenario: Restart

- **WHEN** `/oob restart` runs
- **THEN** a `stopping` heartbeat is sent first and an `up` heartbeat follows after the restart

### Requirement: A failed send never blocks the bridge

A heartbeat that cannot be sent SHALL NOT delay or fail any other bridge work. The bridge SHALL log the failure once per change of outcome and SHALL NOT queue missed heartbeats.

#### Scenario: Receiver unreachable

- **WHEN** the receiver does not answer
- **THEN** the status call still answers and one failure line is logged

### Requirement: The receiver alerts on silence, by sendMessage only

A receiver that follows this contract SHALL alert the operator when no heartbeat arrived for three intervals (five minutes after a `stopping` heartbeat), judged by its own clock. It SHALL alert once per outage, remind every 30 minutes, and send a recovery message on the first `up` heartbeat. It SHALL use `sendMessage` only and SHALL NOT call `getUpdates` or set a webhook.

#### Scenario: Heartbeats stop

- **WHEN** no heartbeat arrives for 90 seconds after an `up` heartbeat
- **THEN** one alert is sent and none again for 30 minutes

#### Scenario: Recovery

- **WHEN** an `up` heartbeat arrives after an alert
- **THEN** one recovery message is sent

#### Scenario: Stopping extends the window

- **WHEN** a `stopping` heartbeat is the last one received
- **THEN** no alert is sent before five minutes of silence

### Requirement: A degraded bridge is reported without waiting for silence

A receiver SHALL alert when two consecutive heartbeats are degraded and SHALL name the reason codes of the last one.

#### Scenario: Offline in the TUI, running on the Mac

- **WHEN** the bridge sends degraded heartbeats with `snapshot_invalid` for two intervals
- **THEN** the operator gets an alert naming `snapshot_invalid`
