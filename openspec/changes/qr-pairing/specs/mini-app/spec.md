## ADDED Requirements

### Requirement: A start parameter names what the app opens

The app SHALL read the start parameter from the launch hash, the init data or the `s` query, and act on its prefix: `s_<id>` opens that session's detail, `a_<id>` opens that approval, `enrol_<code>` opens the enrolment screen. An id without a prefix SHALL open a session. A parameter it cannot read, or a session the bridge does not know, SHALL leave the person on the list.

#### Scenario: A session from the Open button

- **WHEN** the app opens with `s_ses_1` and the session exists
- **THEN** its detail is shown

#### Scenario: A session that is not there

- **WHEN** the app opens with `s_gone` and the bridge answers 404
- **THEN** the list is shown with a short message

#### Scenario: An id from an older message

- **WHEN** the app opens with `ses_1` and no prefix
- **THEN** that session's detail is shown

### Requirement: A scanned enrolment code is filled in and never acted on

When the start parameter is `enrol_<code>`, the app SHALL open the enrolment screen with the code in the field and the Face ID button focused. It SHALL NOT enrol until the person taps a button. The bridge SHALL show the QR code of the direct link at the Mac only, and SHALL NOT send the link or the code to Telegram.

#### Scenario: Scan

- **WHEN** the person scans the QR at the Mac
- **THEN** the enrolment screen shows the code and a focused Face ID button, and nothing is sent until the tap

#### Scenario: No direct link configured

- **WHEN** `miniApp.link` is not set
- **THEN** the Mac shows the code only
