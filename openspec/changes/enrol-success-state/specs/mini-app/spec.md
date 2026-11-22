## ADDED Requirements

### Requirement: A finished enrolment is shown as done

When an enrolment succeeds the Mini App SHALL replace the enrol form with a confirmation that names the kind (Face ID or passkey) and the new device, give a success haptic, and offer no button that spends the code again. A further tap SHALL send nothing and SHALL NOT show an error.

#### Scenario: Face ID enrolled

- **WHEN** the bridge confirms the Face ID enrolment and the phone keeps the token
- **THEN** the screen reads "This phone is set up for Face ID" with the device id and a Done button, and neither Face ID nor Passkey is offered

#### Scenario: A second tap

- **WHEN** enrol is called again after success
- **THEN** no request is made and the confirmation stays
