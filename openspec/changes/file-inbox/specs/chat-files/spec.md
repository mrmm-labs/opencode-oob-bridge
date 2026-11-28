## ADDED Requirements

### Requirement: Other document types are saved for the session

A document whose type is not accepted inline SHALL be downloaded within the size limit, saved in a folder of its session under the state directory with mode `0600` and a name that holds no path and keeps its extension, and the session SHALL be sent the text `File received: <name> (<mime>, <size>) saved at <abs path>`. A file over the limit SHALL be refused with the limit in the message, and types accepted inline SHALL go as file parts as before.

#### Scenario: A spreadsheet

- **WHEN** an `.xlsx` document is sent in a session's topic
- **THEN** it is saved under that session's folder with mode `0600` and the session is sent the path

#### Scenario: A traversal name

- **WHEN** the file name is `../../x.docx`
- **THEN** the saved path is inside the session's folder and ends in `.docx`

#### Scenario: Too large

- **WHEN** the file is over the limit
- **THEN** it is refused with the limit and nothing is saved
