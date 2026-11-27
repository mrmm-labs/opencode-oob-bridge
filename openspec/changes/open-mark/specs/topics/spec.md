## ADDED Requirements

### Requirement: A topic is marked while its session is open in a TUI

While some TUI shows a session, the bridge SHALL rename its topic to `🟢 <name>`, and SHALL rename it back when no TUI shows it. The stored name SHALL stay without the mark, and the mark SHALL NOT be added to a name that has it. `topics.markOpen` (default true) SHALL govern it; with it false no topic is marked and a marked one is renamed back.

#### Scenario: Opened and closed in a TUI

- **WHEN** a TUI starts showing a session, and later stops
- **THEN** its topic is renamed with the mark, then without it, and the stored name never has the mark

#### Scenario: Never twice

- **WHEN** the open set is read again while the topic is marked
- **THEN** no rename is sent

#### Scenario: Switch off

- **WHEN** markOpen is false and a TUI shows a session
- **THEN** no rename is sent

### Requirement: Marks are renamed at a slow pace

The bridge SHALL send at most one rename of a topic per 60 seconds, counting the rename that follows a session's title, and SHALL NOT rename on each heartbeat.

#### Scenario: A session flips

- **WHEN** a TUI shows a session, stops, and shows it again within 60 seconds
- **THEN** one rename is sent, and the next waits until 60 seconds have passed
