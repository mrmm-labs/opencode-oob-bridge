## 1. Plan and preflight

- [ ] 1.1 `overnight.json` store with task states and atomic writes. Verify: tests for restart without a repeated task.
- [ ] 1.2 Preflight checks and the ok, warning, blocker model. Verify: a test per item and per refusal.
- [ ] 1.3 `/oob overnight` dialog (TUI only) with brief defaults. Verify: a TUI test fills a brief; a chat or API start is refused.

## 2. Loop

- [ ] 2.1 Resume step with limits. Verify: tests for the 5-minute gap, `maxResumes` and a no-effect outcome.
- [ ] 2.2 Task step. Verify: tests for idle with a task, busy without, and task completion.
- [ ] 2.3 Question policy. Verify: tests for park, default with a recommended option, no recommended option, multi-select, free text and permission (never).
- [ ] 2.4 Budget and failure stops. Verify: tests for `maxTurns`, `until` and `maxFailures`.
- [ ] 2.5 Never rules and the ten-minute pause on operator input. Verify: tests for a denied session, an outside session and a typed prompt.

## 3. Escalation and report

- [ ] 3.1 Escalation lines, silent topic message and `overnight.wake`. Verify: tests for the default empty list and for a wake kind.
- [ ] 3.2 Night section of the digest and `overnight_action` log lines. Verify: a fake-clock night produces the expected section.
- [ ] 3.3 Ending a plan from a chat or the API. Verify: a test ends it and the loop stops at once.

## 4. Away

- [ ] 4.1 Timed AFK and the return summary. Verify: tests with a fake clock and a TUI input event.
- [ ] 4.2 README and `overnight` config. Verify: `config.test.ts` and `readme.test.ts`.
- [ ] 4.3 One real night. Verify: the digest of the night is attached to the release PR. Deferred: needs an unattended night with the operator.
