## Why

When a session shows a question form, a plain message sent to its topic went to the session as a prompt behind the open question. The operator saw a reaction and then nothing: the question blocked the turn, so the message was neither answered nor refused. The operator described it as "the question blocked the communication with Telegram".

## What Changes

- A plain message for a session with an open question is **held**: it is not sent. The topic says "⏸ This session is waiting on a question" and offers three buttons: **Answer** (post the question again, at the bottom), **Skip** (do not send the message) and **Send anyway** (steer it into the session).
- A reply to the question's message still answers it, and `!text` still steers at once.

## Capabilities

### Modified Capabilities

- `chat`: messages for a session that waits on a question.

## Out of scope

Dismissing the question from the chat (the host offers no way to cancel a form except a TUI), pending permission requests (they have their own buttons).

## Impact

- **Existing surface audit.** `src/bridge.ts` (`prompt`, `onForm`), `src/commands.ts` (flows, `pick`), `src/connectors/telegram.ts` (`settle`).
