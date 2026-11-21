## ADDED Requirements

### Requirement: Each Telegram update and each send is one trace

The bridge SHALL record one trace for each Telegram update it handles and for each message it sends to Telegram. A trace SHALL have a 32-hex id, timed steps (including each Telegram API call made for it), and an outcome. It SHALL hold ids, the agent, the state, a short reason and durations, and SHALL NOT hold message text. The trace of a delivered prompt SHALL give its id to what the bridge sends for that session's turn.

#### Scenario: Update to reply

- **WHEN** a prompt is delivered and the session replies
- **THEN** the reply's trace has the update's id and the update's span as parent

#### Scenario: A failed send

- **WHEN** a send to Telegram fails
- **THEN** its trace ends as failed and the failure is the last error

### Requirement: Log lines carry the trace id and follow log.level

The bridge SHALL write one log line per inbound outcome and per outbound outcome, each with the trace id. `log.level` SHALL default to `info` (every outcome), `warn` SHALL write failed outcomes only, and `debug` SHALL also write one line per step with the same trace id. Any other value SHALL be refused by name.

#### Scenario: Warn

- **WHEN** `log.level` is warn and one update succeeds and one fails
- **THEN** only the failure is written

#### Scenario: Debug

- **WHEN** `log.level` is debug
- **THEN** each step of a trace is written with the trace id of its outcome line

### Requirement: Spans and metrics describe the Telegram path

With telemetry on, each trace SHALL be exported as a root span with one child span per step, with attributes update_id, message_id, thread, session.id, agent, state, kind and outcome. The bridge SHALL export counters of inbound updates by outcome (received, delivered, refused, dropped, retried), outbound sends by outcome, the queue depth, the time of the last good poll and send, and the latency and error codes of Telegram API calls.

#### Scenario: Spans

- **WHEN** an update finishes
- **THEN** a root span and a span per step share its trace id and carry no text

#### Scenario: Metrics

- **WHEN** telemetry is on and updates are handled
- **THEN** the inbound and outbound counters, queue depth, last poll and send, API latency and error metrics are exported

### Requirement: The last traces and the counters can be read

`/oob trace [n]` and `/trace [n]` SHALL list the last n traces (default 5, at most 20), newest first, with direction, kind, ids, outcome, duration and the path of steps. `/oob status` SHALL show the inbound and outbound counters and the last error.

#### Scenario: /trace

- **WHEN** a person sends /trace in a topic
- **THEN** the reply lists recent updates with their outcome

#### Scenario: Status

- **WHEN** /oob status is opened
- **THEN** it shows the counters and the last error or "none"
