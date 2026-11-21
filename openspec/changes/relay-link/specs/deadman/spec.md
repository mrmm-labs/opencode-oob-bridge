## ADDED Requirements

### Requirement: The heartbeat may travel on the relay link

When a link is up the bridge SHALL send the heartbeat as a `beat` frame every `deadman.intervalSeconds` and take the `ack` frame as the receiver's acknowledgement. The payload SHALL be the same as the HTTPS heartbeat and SHALL hold the same fields only. The HTTPS heartbeat SHALL keep working when `deadman.url` is set, and either path SHALL count as alive for the receiver.

#### Scenario: Link up

- **WHEN** a link is up
- **THEN** one `beat` frame is sent per interval and the `ack` marks the heartbeat acknowledged

#### Scenario: Link down

- **WHEN** the link is down
- **THEN** no `beat` frame is sent and the heartbeat is not counted as acknowledged by the link

#### Scenario: Planned stop

- **WHEN** the bridge stops on purpose
- **THEN** it sends a `beat` frame with state `stopping` first
