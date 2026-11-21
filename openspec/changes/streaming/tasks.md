## 1. Transports

- [ ] 1.1 Add the `draft` capability and the `sendMessageDraft` call to the Telegram connector, private chats only. Verify: `fake-telegram` tests for the call and its refusal in a group.
- [ ] 1.2 Draft path with refresh and a final `sendMessage`. Verify: a test with a 25-second silence sees a refresh, and the final message is sent once.
- [ ] 1.3 Fallback to edits after a rejected draft. Verify: a test sees edits for ten minutes after one refusal.

## 2. Edit limits

- [ ] 2.1 Back off on 429 and coalesce. Verify: a test with a forced 429 shows the pause, the doubled interval and one coalesced update.
- [ ] 2.2 Per-chat budget `chat.streamBudget`. Verify: a test with fast text never exceeds the budget in a minute.
- [ ] 2.3 One text pipeline before both transports. Verify: a test shows equal text through both paths.
- [ ] 2.4 README and config. Verify: `config.test.ts` and `readme.test.ts`.
