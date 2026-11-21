## ADDED Requirements

### Requirement: A plan is started only at the Mac

An overnight plan SHALL be started only from the TUI. A chat or the API SHALL NOT start, extend or change a plan, and SHALL be able to end one. Starting a plan SHALL set away mode on until the plan's end time and SHALL turn quiet hours and the digest on for that period.

#### Scenario: Start from a chat

- **WHEN** a message in a chat asks to start a plan
- **THEN** no plan starts

#### Scenario: End from a chat

- **WHEN** the person ends the plan from a chat
- **THEN** the automation stops at once

### Requirement: A preflight checklist runs per session and per plan

Before a plan starts the bridge SHALL check each watched session (state known, not denied by `chat.deny`, channel healthy, topic present, inbox readable) and the plan (a channel up, the dead-man heartbeat acknowledged, the digest on), and SHALL mark each item ok, warning or blocker. A blocker SHALL refuse the session or the plan, and warnings SHALL need an explicit yes.

#### Scenario: Channel down

- **WHEN** no channel is connected
- **THEN** the plan is refused and the reason is shown

#### Scenario: Warning

- **WHEN** the dead-man heartbeat is not configured
- **THEN** the checklist shows a warning and starting needs a yes

### Requirement: Each session has a brief

Each session in the plan SHALL have a brief: tasks to send in order, a scope text, a budget (`maxTurns` and the end time), `maxFailures` (default 2), and a question policy (`park` by default, or `default` with `answerAfter` minutes, default 30).

#### Scenario: Defaults

- **WHEN** a brief gives only tasks
- **THEN** `maxFailures` is 2 and the question policy is `park`

### Requirement: Scope is an instruction, not an enforcement

The bridge SHALL deliver the scope to the session as a synthetic message at the start and SHALL record it. It SHALL NOT answer a permission, SHALL NOT change a permission rule to match the scope, and SHALL say so when the plan starts.

#### Scenario: Permission during the night

- **WHEN** the host asks for a permission during a plan
- **THEN** it waits for the operator like any other

### Requirement: The bridge keeps plan sessions moving

On each scan, for each session in the plan, the bridge SHALL resume a suspended session with waiting messages (at most `maxResumes` times a night, default 3, at least 5 minutes apart), SHALL send the next pending task to an idle session with delivery queue, and SHALL trust the outcome the resume reports.

#### Scenario: Suspended session

- **WHEN** a plan session is suspended with waiting messages
- **THEN** it is resumed and the action is logged

#### Scenario: Idle with a task

- **WHEN** a plan session is idle and has a pending task
- **THEN** the task is sent once and marked sent

#### Scenario: Resume has no effect

- **WHEN** a resume reports no effect
- **THEN** the session is listed as needing the operator and is not resumed again for 5 minutes

### Requirement: An unanswered question follows the policy

With `park` a question SHALL be left open and listed for the operator. With `default`, after `answerAfter` minutes the bridge SHALL answer a single-select question that has a recommended option with that option, and SHALL otherwise park it. The bridge SHALL NOT answer a free-text question, a multi-select question or a permission.

#### Scenario: Default with a recommended option

- **WHEN** the policy is `default`, `answerAfter` passed and the question has a recommended option
- **THEN** that option is the answer and the action is logged

#### Scenario: Multi-select

- **WHEN** the policy is `default` and the question is multi-select
- **THEN** it is parked

### Requirement: A session that breaks its limits is stopped

The bridge SHALL stop a plan session that passed `maxTurns`, passed the end time, or failed `maxFailures` turns in a row, by interrupting it when it runs and marking it stopped with the reason.

#### Scenario: Failures in a row

- **WHEN** a session fails two turns in a row and `maxFailures` is 2
- **THEN** it is stopped with the reason `failures` and is not sent more tasks

### Requirement: The automation has hard limits

The automation SHALL act only on sessions in the plan, SHALL NOT act on a session that matches `chat.deny`, SHALL NOT act after the end time or after the plan is ended, and SHALL pause for ten minutes on a session in which the operator types a prompt.

#### Scenario: Operator comes back

- **WHEN** a prompt is typed in the TUI for a plan session
- **THEN** the automation does not act on that session for ten minutes

#### Scenario: Plan over

- **WHEN** the end time passes
- **THEN** no automated action happens afterwards

### Requirement: Only what needs the operator is escalated

Parked questions, open permissions, repeated failures, a refused resume, a stopped session and an unhealthy bridge or channel SHALL each be one line in the morning digest and one silent message in the topic. Only the kinds named in `overnight.wake` SHALL notify with sound, and the default list SHALL be empty.

#### Scenario: Default

- **WHEN** a question is parked at 03:00 and `overnight.wake` is empty
- **THEN** it is in the digest and no sound is made

#### Scenario: Wake on failure

- **WHEN** `overnight.wake` holds `failed` and a session is stopped for failures
- **THEN** a message with sound is sent

### Requirement: The plan survives a restart without repeating work

The plan SHALL be stored before any automated action and read at start. A task that was sent SHALL NOT be sent again after a restart.

#### Scenario: Restart mid-night

- **WHEN** the bridge restarts after sending task 1 of 3
- **THEN** the next task sent is task 2

### Requirement: The digest reports the night

The digest SHALL gain a night section with, per session, the turns run, the tasks done of the total, the resumes, the answers given by policy, the parked questions, the failures and the stop reason. Each automated action SHALL also be logged as an `overnight_action` line with the session, the action and the reason.

#### Scenario: A night

- **WHEN** a plan ends
- **THEN** the digest has a night section for each plan session and each action has a log line
