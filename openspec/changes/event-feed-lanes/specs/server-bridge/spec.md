## ADDED Requirements

### Requirement: The event stream is never held up by one session

The server half SHALL read the host's event stream without waiting for any host call. Events of one session SHALL be handled in the order they arrived, and a session for which the host does not answer SHALL NOT delay the events of another session. A `session.get` SHALL be abandoned after 8 seconds and logged as `host_timeout`, and the event handled without its answer.

#### Scenario: One session never answers

- **WHEN** the host never answers `session.get` for one session and events arrive for it and for another session
- **THEN** the events of the other session are handled

#### Scenario: The host does not answer for the session of an event

- **WHEN** the host does not answer `session.get` for the session of an event
- **THEN** after the time limit the event is still handled and `host_timeout` is logged

### Requirement: A stream that ends is logged

When the event stream ends without an error and the bridge is not stopping, the server half SHALL log `event_stream_ended` with the number of events it carried and how long it lived, and SHALL subscribe again.

#### Scenario: Stream ends

- **WHEN** the host closes the event stream
- **THEN** `event_stream_ended` is logged and the bridge subscribes again
