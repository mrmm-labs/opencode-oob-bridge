## Why

The reply is posted as one message edited every second or so. That works, but an edit loop in a group is rate-limited and looks jumpy, and Telegram now has a native way to stream a partial message. The operator asked to use it where it exists.

## What Changes

- The streaming transport is chosen by what the channel offers: **native draft** (`sendMessageDraft`) where Telegram allows it, **rate-limited edits** everywhere else.
- Edits adapt to Telegram's limits: they back off on a 429 and stay under a per-minute budget per chat.
- The final message always carries the final formatting.

**Finding (checked against the current Bot API reference).** `sendMessageDraft` streams "to a user": its `chat_id` is a **private chat** (with an optional `message_thread_id`). It is an ephemeral 30-second preview, and the final text must be sent with `sendMessage`. It cannot be used in a forum group. The bot's chat today is a forum group, so edits stay the transport there. Telegram also lets a bot create topics in a **private chat** (`createForumTopic`), so moving the pairing to a private chat with topics would give native streaming. That is a decision for the operator (see the report).

## Capabilities

### New Capabilities

- `streaming`: transport selection, the draft path, the edit path and its limits.

### Modified Capabilities

- `chat`: the reply streaming requirement refers to the transport rules.

## Out of scope

Moving the pairing to a private chat, streaming to ntfy, streaming tool calls or reasoning.

## Impact

- **Existing surface audit.** `src/bridge.ts` (the stream loop, `chat.streamMs`), `src/connectors/telegram.ts` (`editMessageText`), `src/connectors/types.ts` (`capabilities`).
- **Supersession.** The fixed one-second edit loop.
- **Downstream.** The Mini App can stream the same text over SSE.
- **Estimate.** Agent 1 day. Operator none.
- **Definition of done.** `pnpm test` ends `fail 0`, and recorded runs show the edit path staying under the budget with a forced 429, and the draft path against a private-chat test double.
