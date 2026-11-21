## Purpose

The digest is the morning message: what finished, what failed and what waits for an answer since the last one.

## ADDED Requirements

### Requirement: A digest is sent at a set time

When `digest.at` is set (default the end of quiet hours), the bridge SHALL send one digest message to the paired chat at that time, covering the period since the last digest. The digest SHALL be off until configured and SHALL NOT be sent when it is empty, unless `digest.empty` is true.

#### Scenario: Scheduled

- **WHEN** the clock reaches `digest.at` and something happened since the last digest
- **THEN** one digest is sent

#### Scenario: Nothing happened

- **WHEN** nothing happened and `digest.empty` is not true
- **THEN** no digest is sent

### Requirement: The digest has three sections

The digest SHALL list the sessions that finished, the sessions that failed, and what waits for the operator (open questions, open permissions, stuck sessions). Titles SHALL follow `redact` and secrets SHALL be masked.

#### Scenario: One of each

- **WHEN** two turns finished, one failed and one question is open
- **THEN** the digest shows each section with its sessions

### Requirement: Waiting items are read live

The "waiting on you" section SHALL be built from what is open when the digest is sent, not from earlier records.

#### Scenario: Answered before the digest

- **WHEN** a question is answered before the digest time
- **THEN** it is not listed as waiting

### Requirement: The records behind the digest are derived and bounded

The bridge SHALL keep the records in the data directory, with a redacted title, SHALL drop records older than seven days, and SHALL send a digest even if the file is missing, with whatever it has.

#### Scenario: Old records

- **WHEN** a record is eight days old
- **THEN** it is removed

### Requirement: /digest sends it now

`/digest` SHALL send the digest for the period since the last one and SHALL mark that period as covered.

#### Scenario: On request

- **WHEN** the person sends `/digest`
- **THEN** a digest is sent and the next scheduled digest covers only what follows
