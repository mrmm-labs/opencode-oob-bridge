## 1. Find out what happens today

- [x] 1.1 Reproduce a stuck session in an isolated `opencode serve` (own home, own port) and call Resume. Verify: the recorded host answer and the database rows before and after, kept in the PR.
- [x] 1.2 Record what the host does for a suspended session with and without waiting inbox items. Verify: a short note in the design with the observed behaviour.

## 2. Outcome

- [x] 2.1 After the synthetic call, watch events and the probe for up to 30 seconds and classify `working`, `drained` or `no_effect`. Verify: unit tests for each class with a fake host and probe.
- [x] 2.2 Edit the alert to show the outcome and remove its button. Verify: tests for each outcome and for a second tap.
- [x] 2.3 Log `resume` with session, source (button, command, sidebar), outcome and time. Verify: a test reads the line.

## 3. Alert lifecycle

- [x] 3.1 One alert per suspension; re-alert on growth or after six hours. Verify: tests with a fake clock.
- [x] 3.2 Edit or delete a stale alert when the session wakes some other way. Verify: a test where the session resumes at the Mac.

## 4. Real session

- [x] 4.1 Add `pnpm test:real` (not in CI) running the isolated server check. Verify: its output is attached to the release PR.
