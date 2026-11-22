## ADDED Requirements

### Requirement: Prompts OpenCode no longer holds are closed

When the plugin starts, and every 60 seconds, the bridge SHALL check each question and permission it waits on against OpenCode. One that OpenCode no longer holds SHALL be marked answered (or cancelled) with `answeredBy` `unknown (reconciled)`, its channel message SHALL be edited to "Already answered at the Mac" without buttons, and the permission digest SHALL no longer count it. A prompt asked less than 10 seconds ago, and one OpenCode cannot be asked about, SHALL be left as it is.

#### Scenario: Answered while the plugin restarted

- **WHEN** a question was answered at the Mac while the plugin was away, and the plugin starts
- **THEN** it is marked answered and its message reads "Already answered at the Mac" with no buttons

#### Scenario: OpenCode cannot say

- **WHEN** OpenCode fails to answer the lookup
- **THEN** the prompt stays pending

### Requirement: A message held behind a question is sent when the question is gone

A message kept because its session waited on a question SHALL be sent as a normal prompt when that question is found to be no longer open, and its menu and reaction SHALL show it. Before holding a message and before posting a question again, the bridge SHALL ask OpenCode whether the question is still open.

#### Scenario: Held, then reconciled

- **WHEN** a message is held and the question is then found answered
- **THEN** the message reaches the session and the topic shows it

#### Scenario: Message sent after a stale question

- **WHEN** a message arrives for a session whose recorded question OpenCode no longer holds
- **THEN** it is delivered at once and not held

#### Scenario: Answer on a question that is gone

- **WHEN** Answer is chosen on a held message and the question is gone
- **THEN** the kept message is sent and the question is not posted again

### Requirement: A reply to a form that is gone closes it

When delivering an answer fails because OpenCode no longer has the form, the bridge SHALL close the prompt as already answered at the Mac and SHALL NOT relay the reply through a window.

#### Scenario: Tap on a stale question

- **WHEN** a button is tapped for a form OpenCode no longer has
- **THEN** the message reads "Already answered at the Mac" and the prompt is closed
