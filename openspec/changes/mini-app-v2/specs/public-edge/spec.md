## MODIFIED Requirements

### Requirement: The bridge accepts Telegram init data from the operator only

The API SHALL accept `Authorization: tma <init data>` as a credential. The bridge SHALL verify the hash with the HMAC of the bot token, compare in constant time, accept only the operator's user id, and refuse init data older than `miniApp.maxAgeSeconds` (default 3600). A failure SHALL answer 401, or 403 for another user, with a body `{ "error": "<reason>" }` where the reason is one of `no_operator`, `no_bot_token`, `missing`, `malformed`, `bad_signature`, `too_old`, `not_operator`. The bridge SHALL log each reason as `edge_refused`, at most once a minute per reason.

#### Scenario: Valid init data

- **WHEN** a request carries fresh init data of the operator
- **THEN** it is accepted

#### Scenario: Stale init data

- **WHEN** init data is two hours old
- **THEN** the answer is 401 with the reason `too_old`

#### Scenario: Another user

- **WHEN** init data names another user and its hash is valid
- **THEN** the answer is 403 with the reason `not_operator`

#### Scenario: No operator known

- **WHEN** the bridge has no operator id
- **THEN** the answer is 401 with the reason `no_operator`, and the failure does not count towards the block

## ADDED Requirements

### Requirement: The operator may be set in the config file

`channels.telegram.operator` SHALL be a numeric Telegram user id used when pairing stored none. An id stored at pairing SHALL win. A bridge paired to a group SHALL set the Mini App menu button in the operator's own chat, once, when the id is known.

#### Scenario: Group pairing from before the id was stored

- **WHEN** the paired chat is a group, no id was stored, and the file names the operator
- **THEN** init data of that user is accepted and the menu button is set in that user's chat
