## ADDED Requirements

### Requirement: The app sends agent ids and shows labels

`GET /v1/options` SHALL give each agent as `{ id, label }`. The app SHALL use the id as the value it sends and the label only as the text it shows. A session that failed within a minute of its creation SHALL show as "Did not start".

#### Scenario: Options

- **WHEN** the app asks for `/v1/options`
- **THEN** each agent has an id and a label

#### Scenario: A session that did not start

- **WHEN** a session fails less than a minute after it was created
- **THEN** its state is `unstarted` and the list says "Did not start"
