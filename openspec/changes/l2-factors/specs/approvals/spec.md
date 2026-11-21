## MODIFIED Requirements

### Requirement: Levels are a tap, a tap with a code, or the machine

L1 SHALL need a tap on Approve. L2 SHALL need a tap on Approve and then proof of one listed factor. L3 SHALL NOT be relayed: the bridge SHALL answer it at once with `needs_local`. A request MAY ask for a higher level than its class minimum and SHALL NOT ask for a lower one. A tap on Deny from the operator SHALL be enough for any class.

#### Scenario: L3

- **WHEN** a request needs level 3
- **THEN** the bridge answers `needs_local` and sends no approval message

#### Scenario: Deny at any level

- **WHEN** the operator taps Deny on an L2 request
- **THEN** the request is denied with no factor asked

### Requirement: Channels declare what they can prove

A class SHALL list the channels it accepts, default Telegram only. A channel SHALL declare whether it has buttons, whether it identifies the approver, whether it takes typed text and whether it can open the Mini App, and a request SHALL fail at once with `unavailable` when no accepted channel can reach the level. A channel reaches level 2 when at least one configured factor is ready on it. Telegram is the only channel that declares approvals in this release; ntfy declares none, because a tap there proves nobody.

#### Scenario: ntfy for an L2 class

- **WHEN** an L2 class lists only ntfy
- **THEN** a request fails at once as `unavailable`

#### Scenario: No factor ready

- **WHEN** an L2 request arrives and no listed factor is ready
- **THEN** it fails at once as `unavailable`

## REMOVED Requirements

### Requirement: L2 uses a one-time code used once per step

**Reason**: L2 is met by any listed factor. The code rules are kept as the `totp` factor in the `l2-factors` capability.

**Migration**: None for a config without `approvals.l2`: the default list ends with `totp`, and an operator who enrolled a seed keeps working.

## ADDED Requirements

### Requirement: The signed answer records the factor

An answer that approves at level 2 SHALL carry `factor`: `biometric`, `passkey` or `totp`. The factor SHALL be part of the signed string: with a factor the string SHALL start with `oob-approval-v2` and end with a `factor` line; without one it SHALL be the `oob-approval-v1` string unchanged. `verifyAnswer` SHALL accept both forms.

#### Scenario: L2 by Face ID

- **WHEN** an L2 request is approved with a biometric proof
- **THEN** the answer has `factor: "biometric"` and its signature covers it

#### Scenario: Factor altered in transit

- **WHEN** a caller verifies an answer whose `factor` was changed after signing
- **THEN** the signature check fails

#### Scenario: L1

- **WHEN** an L1 request is approved
- **THEN** the answer has no `factor` and verifies as `oob-approval-v1`
