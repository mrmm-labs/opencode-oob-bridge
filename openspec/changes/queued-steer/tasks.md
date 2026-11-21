## 1. Starving queue

- [x] 1.1 `chat.queueSteerSeconds` in the config. Verify: `chat-queue.test.ts` config tests.
- [x] 1.2 Hold, steer after the limit, release when free, release on stop. Verify: `chat-queue.test.ts`.
- [x] 1.3 One retry of a failed Telegram call. Verify: `telegram-retry.test.ts` (fails on the previous code).
