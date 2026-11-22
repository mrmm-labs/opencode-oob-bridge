## ADDED Requirements

### Requirement: An open enrolment is visible to every instance

The enrolment a TUI opens SHALL be kept where every plugin instance of the same data directory reads it, with its expiry and tries, and its code SHALL be stored only as a salted hash. The instance that serves the phone SHALL accept the code, count wrong tries, and remove the enrolment when it is spent, expired or out of tries. Opening and every attempt SHALL be logged without the code.

#### Scenario: Opened in one instance, entered through another

- **WHEN** the TUI's instance opens an enrolment and the phone's request is served by another instance
- **THEN** the code enrols the phone

#### Scenario: Expired or out of tries

- **WHEN** five minutes pass, or five wrong codes are sent through any instances
- **THEN** every instance answers that there is nothing to enrol

### Requirement: The phone keeps a token only after the bridge accepts

The Mini App SHALL store the biometric token only after the bridge's confirmation, and a later enrolment SHALL overwrite it.

#### Scenario: Refused, then accepted

- **WHEN** the bridge refuses the enrolment and the phone retries successfully
- **THEN** nothing was stored on the refusal and the new token is stored
