## 1. Check against the open list (one PR)

- [ ] 1.1 A pending question or permission request that OpenCode does not list is withdrawn, its message edited. Verify: `src/chat-question.test.ts`.
- [ ] 1.2 The drain counts only confirmed prompts, with `unverified` on the side. Verify: `src/control.test.ts`, `src/chat-question.test.ts`.
- [ ] 1.3 The service client lists open requests and reads a missing session as gone. Verify: `src/serviceclient.test.ts`.
- [ ] 1.4 `reconcile` is logged with the counts. Verify: `src/chat-question.test.ts`.
