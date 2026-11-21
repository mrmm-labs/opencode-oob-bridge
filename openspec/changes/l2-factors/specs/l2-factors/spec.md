## ADDED Requirements

### Requirement: L2 factors are a configured, ordered list

`approvals.l2.factors` SHALL be an ordered list without repeats of `biometric`, `passkey` and `totp`, and SHALL default to `["biometric", "passkey", "totp"]`. The bridge SHALL refuse a config that lists another name, and SHALL refuse `push` with a message that push is level 1 only. A factor SHALL be offered for a request only when it is configured and ready on the request's channel. The offered factors SHALL keep the configured order.

#### Scenario: Default

- **WHEN** the config has no `approvals.l2`
- **THEN** the factors are biometric, passkey, totp in that order

#### Scenario: Push in the list

- **WHEN** the config lists `push`
- **THEN** the config is refused and the message says push is level 1 only

#### Scenario: Factor not ready

- **WHEN** biometric is listed but no device is enrolled
- **THEN** the offered factors leave it out

### Requirement: Face ID proves possession of a device secret

The bridge SHALL accept a biometric proof only when it equals HMAC-SHA256, keyed by the secret of the named enrolled device, over `oob-l2-biometric-v1`, the request hash and the challenge of that request, each on its own line. It SHALL compare in constant time, SHALL issue a challenge of at least 16 random bytes that works once and for one request, and SHALL discard it at the first proof, right or wrong. A revoked device SHALL fail.

#### Scenario: Right proof

- **WHEN** the app sends the HMAC of the request hash and the issued challenge
- **THEN** the request is approved at level 2 with factor `biometric`

#### Scenario: Proof reused

- **WHEN** the same proof is sent a second time
- **THEN** it is refused, because the challenge was spent

#### Scenario: Proof for another request

- **WHEN** a proof made for request A is sent for request B
- **THEN** it is refused

#### Scenario: Revoked device

- **WHEN** an enrolled device is revoked and then sends a proof
- **THEN** it is refused

### Requirement: Enrolment starts at the Mac

A device secret or a passkey SHALL be created only after the operator opens an enrolment from the TUI. The enrolment SHALL give a single-use code that expires in 5 minutes, SHALL be compared in constant time, and SHALL be opened by neither the socket, the core API nor a chat. The device secret SHALL be returned once, at enrolment, and SHALL be kept only in the Keychain.

#### Scenario: Wrong or expired code

- **WHEN** the app sends a wrong code, or the right one after 5 minutes
- **THEN** nothing is enrolled

#### Scenario: Code reused

- **WHEN** an enrolment code was used and is sent again
- **THEN** nothing is enrolled

### Requirement: A passkey counts as L2 where the webview supports it

The bridge SHALL accept a passkey assertion only when the client data is `webauthn.get` with the challenge derived for that request and the origin of `miniApp.url`, the authenticator data carries the SHA-256 of the relying party id and the user-verified flag, and the signature verifies against an enrolled public key.

#### Scenario: Valid assertion

- **WHEN** a valid assertion arrives for the current challenge
- **THEN** the request is approved at level 2 with factor `passkey`

#### Scenario: Wrong origin or unverified user

- **WHEN** the origin is not ours, or the user-verified flag is not set
- **THEN** it is refused

### Requirement: The app offers a passkey only where it works

The app SHALL offer a passkey only after it finds WebAuthn, a user-verifying authenticator, an enrolled credential, and a host equal to the relying party id. Otherwise it SHALL NOT offer one.

#### Scenario: Webview without WebAuthn

- **WHEN** the app runs where `PublicKeyCredential` is missing
- **THEN** it does not offer a passkey

### Requirement: The code stays the fallback

The `totp` factor SHALL keep the rules of the one-time code: RFC 6238, a step accepted at most once, three wrong codes deny. The code SHALL be accepted when typed in the chat or entered in the app, and SHALL be ignored when `totp` is not in the factors. A chat prompt SHALL still take a typed code when the app is offered.

#### Scenario: App unavailable

- **WHEN** the operator has no app or no biometrics on the device
- **THEN** the prompt in the chat takes the typed code and the request can be approved

#### Scenario: totp not listed

- **WHEN** the factors are `["biometric"]` and a valid code is typed
- **THEN** it is ignored

### Requirement: Three wrong proofs deny

Three wrong proofs of any factor on one request SHALL deny it, with the reason `bad_code` for the code and `bad_proof` for the others.

#### Scenario: Three wrong proofs

- **WHEN** three wrong biometric proofs are sent
- **THEN** the request is denied with the reason `bad_proof`

### Requirement: Push is level 1 only

A tap from a channel that does not identify the approver, such as an ntfy or watch button, SHALL NOT count as a factor for L2. This release does not build that path.

#### Scenario: L2 on a push channel

- **WHEN** an L2 class lists only a channel that does not identify the approver
- **THEN** the request fails as `unavailable`
