## Purpose

Quiet hours keep the phone silent at night without losing anything: messages still arrive, without a sound, and a short list of kinds may break through.

## ADDED Requirements

### Requirement: Quiet hours make delivery silent

Between `quiet.from` and `quiet.to` in `quiet.timezone` the bridge SHALL deliver every message silently: Telegram messages with notifications disabled and ntfy messages at minimum priority. It SHALL NOT hold or drop a message. The window MAY cross midnight. Quiet hours SHALL be off until configured.

#### Scenario: Inside the window

- **WHEN** a question is pushed at 02:00 and quiet hours are 23:00 to 07:00
- **THEN** it is delivered with notifications disabled

#### Scenario: Outside the window

- **WHEN** a question is pushed at 12:00
- **THEN** it is delivered as it would be without quiet hours

### Requirement: Daylight saving does not shift the window

The window SHALL be decided for each instant in the configured zone, so a daylight saving change neither extends nor shortens it by an hour of wall-clock time.

#### Scenario: Spring forward

- **WHEN** the clocks move forward during the window
- **THEN** the window still ends at 07:00 local time

### Requirement: Break-through is an explicit list

Kinds named in `quiet.breakthrough` (failed, permission, question) SHALL notify during quiet hours. The default list SHALL be empty.

#### Scenario: Failed turn listed

- **WHEN** `quiet.breakthrough` holds `failed` and a turn fails at 03:00
- **THEN** the failure notifies with sound

#### Scenario: Default

- **WHEN** no break-through list is set
- **THEN** nothing notifies during quiet hours
