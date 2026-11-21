# streaming Specification

## Purpose

Streaming shows the reply as it is written, by the best transport the chat allows (a native draft where Telegram offers it, rate-limited edits elsewhere), with one text for both.

## Requirements

### Requirement: The transport follows what the channel offers

The core SHALL stream a reply by native draft where the channel and chat support it, by edits where it does not, and SHALL send only the final message where the channel can do neither. It SHALL decide from declared capabilities and not from the connector's type.

#### Scenario: Private chat

- **WHEN** the reply goes to a private chat on a channel with the draft capability
- **THEN** the reply is streamed as a draft

#### Scenario: Forum group

- **WHEN** the reply goes to a forum group topic
- **THEN** the reply is streamed by edits

### Requirement: A draft is refreshed and then replaced by the final message

A draft SHALL be refreshed at least every 20 seconds while the reply is silent, and when the turn ends the bridge SHALL send the final message with its final formatting. No partial text SHALL remain as a separate message.

#### Scenario: Long silence

- **WHEN** the model is silent for 25 seconds during a draft
- **THEN** the draft is refreshed before it expires

#### Scenario: Turn ends

- **WHEN** the turn ends
- **THEN** one final message is sent with the full text

### Requirement: A refused draft falls back to edits

When Telegram refuses a draft the bridge SHALL log why and use edits for that chat for ten minutes.

#### Scenario: Refusal

- **WHEN** a draft call is refused
- **THEN** the reply continues as edits and one log line records the refusal

### Requirement: Edits obey Telegram's limits

On a 429 the bridge SHALL pause edits for `retry_after`, double the interval up to 8 seconds, and halve it after 30 quiet seconds. It SHALL keep to `chat.streamBudget` edits a minute per chat, and SHALL coalesce updates during a pause so that only the newest text is sent.

#### Scenario: Flood wait

- **WHEN** an edit is answered with 429 and `retry_after` 5
- **THEN** no edit is sent for five seconds and the next one carries the newest text

#### Scenario: Budget

- **WHEN** the text grows faster than the budget allows
- **THEN** no more than the budget of edits is sent in one minute

### Requirement: Both transports show the same text

Redaction, secret masking, Markdown conversion and splitting SHALL happen once, before the transport, so that both paths send the same text.

#### Scenario: Secret in a reply

- **WHEN** a reply holds a token shape
- **THEN** both transports send it masked
