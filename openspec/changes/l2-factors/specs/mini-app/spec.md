## ADDED Requirements

### Requirement: The app answers the factor of an L2 approval

A start parameter `a_<id>` SHALL open the approval view of that request. The view SHALL show the request as the chat does, SHALL offer the first factor, in the bridge's order, that the device supports, and SHALL offer "Use another method" to move to the next. It SHALL always be able to reach the code. Factor routes SHALL answer only init data of the operator, never the bearer token.

#### Scenario: Face ID first

- **WHEN** biometrics are available, a token is saved on the device, and biometric is listed first
- **THEN** the view offers Face ID first, and "Use another method" leads to the next supported factor

#### Scenario: No biometrics

- **WHEN** the device has no biometrics
- **THEN** the view offers the next supported factor, ending at the code

#### Scenario: Bearer token

- **WHEN** a request to `/v1/approvals` carries the bearer token
- **THEN** it is refused

### Requirement: The app enrols a device with the code from the Mac

The app SHALL enrol Face ID or a passkey only with the one-time code shown at the Mac, and SHALL store the device secret with the biometric manager, not in page storage.

#### Scenario: Enrol Face ID

- **WHEN** the person enters the code from the Mac and Face ID is available
- **THEN** the secret is saved behind Face ID and the app says the device is enrolled

#### Scenario: Biometrics refused

- **WHEN** the person declines Telegram's biometric access
- **THEN** the app says so and nothing is stored
