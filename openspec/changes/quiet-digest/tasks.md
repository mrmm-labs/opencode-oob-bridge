## 1. Quiet hours

- [ ] 1.1 Parse `quiet.from`, `quiet.to`, `quiet.timezone`; decide per instant. Verify: tests across midnight and across a daylight saving change.
- [ ] 1.2 Apply silent delivery in the Telegram and ntfy connectors through a `silent` flag on a push. Verify: connector tests for the flag.
- [ ] 1.3 `quiet.breakthrough`. Verify: tests for each kind, and default empty.

## 2. Digest

- [ ] 2.1 `digest.jsonl` append and prune. Verify: tests for append, redaction and the seven-day prune.
- [ ] 2.2 Build and send the digest on schedule and on `/digest`. Verify: tests with a fake clock for the time, the empty case and the three sections.
- [ ] 2.3 Read "waiting on you" live. Verify: a test where a question answered at 06:00 is not listed at 07:30.
- [ ] 2.4 README and config keys. Verify: `config.test.ts` and `readme.test.ts`.
