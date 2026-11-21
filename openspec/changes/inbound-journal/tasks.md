## 1. Journal

- [x] 1.1 `Inbox` journal with add, done, replay, dedupe and compaction. Verify: `telegram-inbound.test.ts` replay and offset tests.
- [x] 1.2 Poll loop writes before it moves the offset and only dispatches. Verify: a stuck handler test and a failing journal write test.

## 2. Outcomes and retry

- [x] 2.1 One `telegram_inbound` line per update; one `inbound` line per core message. Verify: the outcome log test.
- [x] 2.2 `Outcome.retry` and `retriesInbound`; notice and retries. Verify: connector and `chat.test.ts` retry tests.
- [x] 2.3 Time limit per update. Verify: the slow handler test.

## 3. Probe

- [x] 3.1 Exclude a running session from the suspended probe. Verify: `probe.test.ts`.
