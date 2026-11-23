## ADDED Requirements

### Requirement: A session that did not start is marked in its topic

A session that fails within 60 seconds of its creation SHALL have its topic name prefixed with ⚪ and its status card read "Did not start", and SHALL NOT look alive. The prefix and the wording SHALL go when the session works again.

#### Scenario: It fails at once

- **WHEN** a session started a few seconds ago ends as failed
- **THEN** its topic is renamed with a ⚪ prefix and the card says it did not start

#### Scenario: It fails late

- **WHEN** a session started an hour ago ends as failed
- **THEN** the topic is not marked and the card reads "Failed"
