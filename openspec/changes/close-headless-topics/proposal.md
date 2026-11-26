## Why

Before 0.48.0 every headless session (a reviewer, a verifier) got a Telegram topic of its own, and the forum filled with dozens of topics for sessions that have ended. Deleting them would lose their history. Closing them keeps the history and tidies the list.

## What Changes

- **Closed, never deleted.** The bridge calls `closeForumTopic` for the topic of a headless session that is idle. It never deletes a topic, and never renames or rewrites a message.
- **Headless** means: no parent session, no TUI has viewed it, chat is off for it, it is not working, and no question or permission waits on it. A topic shared by several headless sessions is never closed.
- **When:** once at start, for the topics already in the topics file; then each time such a session ends.
- **Reopened** (`reopenForumTopic`) when the session is active again: it starts a turn, or something is posted to its topic.
- **A switch**, `channels.telegram.topics.closeHeadless`, on by default. Off: nothing is closed. A topic the bridge closed earlier is still reopened on use, so a posting never fails for it.
- **Every close and reopen is logged**, with the session, the topic and the reason.

## Capabilities

### Modified Capabilities

- `topics`: closing and reopening the topics of headless sessions.

## Out of scope

Topics of sessions a TUI has viewed, sessions with a chat, and topics of a session the host no longer knows (it cannot be told to be headless). Deleting anything. Closing the Approvals or the shared topics.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (topics file, `thread`, `track`, config), `telegram-budget.ts` (the paced methods), `src/bridge.ts` (events, start), `src/connectors/types.ts`, README, example config.
