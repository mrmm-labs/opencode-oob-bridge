# send-budget Specification

## Purpose

Telegram limits a bot to about one message a second in a chat and 20 a minute in a group. The budget keeps the bridge under that and merges instead of failing.

## ADDED Requirements

### Requirement: Sends to a chat stay under a budget

The Telegram connector SHALL space calls to one chat by `rate.gapMs` (default 1100) and allow at most `rate.perMinute` (default 18) a minute. Over budget it SHALL queue, not fail.

#### Scenario: A burst

- **WHEN** 40 messages are sent to one chat at once
- **THEN** no minute holds more than 18 calls and none fails

### Requirement: Over budget, messages are coalesced

A plain text message that waits behind another of the same topic SHALL be merged into it; an edit of a message that has a queued edit SHALL replace it; a typing indicator SHALL be dropped. A message with buttons SHALL be neither merged nor dropped. Every caller SHALL receive the reference of the message that carried its text.

#### Scenario: Two notes

- **WHEN** two plain notices to one topic wait for the budget
- **THEN** one message is sent with both texts

#### Scenario: Two edits

- **WHEN** a message is edited twice while queued
- **THEN** one edit is sent with the second text

### Requirement: retry_after is honoured

On HTTP 429 the connector SHALL hold every call to that chat for `retry_after` seconds and retry, as before.

#### Scenario: 429

- **WHEN** a send gets 429 with `retry_after` 2
- **THEN** the call and those queued behind it wait 2 seconds and then succeed

### Requirement: Settings

`rate.gapMs` SHALL be a whole number from 0 to 60000 and `rate.perMinute` a whole number from 1 to 600; other values SHALL refuse the config with a message naming the key.

#### Scenario: Bad value

- **WHEN** `rate.perMinute` is 0
- **THEN** the config is refused

### Requirement: Telemetry

The status snapshot SHALL show per channel the number of calls sent, coalesced, suppressed while present and answered with 429, and the number of events the bridge held while present.

#### Scenario: Status

- **WHEN** status is read after a burst and a quiet period
- **THEN** it shows each count
