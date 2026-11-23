## ADDED Requirements

### Requirement: An agent is named by its id

Every agent the bridge offers or sends to OpenCode SHALL be the agent's id; its display label SHALL only be shown. When a session is started or its agent switched, the bridge SHALL accept the id, or a label ignoring case, and SHALL send the id. An agent OpenCode does not list SHALL be refused before any session, topic or pin exists. When OpenCode lists no agents, the value SHALL be passed through as given.

#### Scenario: A label is given

- **WHEN** a session is started with the agent `Build` and OpenCode lists the agent `build` labelled `Build`
- **THEN** the session is created with the agent `build`

#### Scenario: An unknown agent

- **WHEN** a session is started with an agent OpenCode does not list
- **THEN** the start is refused as invalid and no session is created

#### Scenario: Switching by label

- **WHEN** the agent of a session is switched to `Plan`
- **THEN** OpenCode is told the id `plan`

#### Scenario: A project's own agent

- **WHEN** a project's configured agent is `Build` and a session starts there without an agent
- **THEN** the session is created with the agent `build`

### Requirement: Starting a session is logged

Starting a session SHALL log `session_create` with the outcome, the project, the agent id and the session, from whichever client started it.

#### Scenario: Started from the app

- **WHEN** the app starts a session
- **THEN** `session_create` is logged with outcome `applied` and the agent id
