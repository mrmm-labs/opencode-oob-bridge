## ADDED Requirements

### Requirement: An agent can send a file to its topic

The plugin SHALL offer the tool `oob_send_file` with `path`, `caption` and `as` (`photo`, `document`, `auto`). With `auto` an image under 10 MB SHALL be sent as a photo and anything else as a document. The file SHALL go to the topic of the root session; when there is none the tool SHALL fail with a clear message and SHALL NOT use the General topic or create a topic.

#### Scenario: Document

- **WHEN** an agent sends a text file
- **THEN** it arrives as a document in the session's topic

#### Scenario: No topic

- **WHEN** the session has no topic
- **THEN** the tool returns an error and nothing is sent

### Requirement: Limits on what may be sent

The tool SHALL refuse a file over 50 MB, a directory, a file that is not a regular file, and a symlink that points outside the home directory.

#### Scenario: Directory

- **WHEN** the path is a directory
- **THEN** the tool returns an error

### Requirement: Captions are redacted and nothing else is logged

The caption SHALL be redacted like chat replies. The log SHALL hold `file_sent` with the size and `trace_id` and SHALL NOT hold the file name or contents. A failed send SHALL return a short error, and a 5xx answer SHALL be retried once.

#### Scenario: Telegram fails twice

- **WHEN** Telegram answers 500 twice
- **THEN** the tool returns a short error after one retry
