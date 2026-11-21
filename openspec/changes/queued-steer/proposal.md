## Why

A chat message to a busy session was queued behind the running turn and sent when the turn ended. A session that runs subagents is busy almost all the time, so a queued message waited for hours and the operator, away from the Mac, could not talk to it. Only `!text` (steer) got through.

A failed `editMessageText` or `sendMessage` that hung on a dead connection was also given up after its first timeout.

## What Changes

- **A queued message is steered in after `chat.queueSteerSeconds` (default 30) if the session is still busy.** Until then it is kept by the bridge; if the session frees up first it is sent as a normal prompt. When it is steered the thread says "→ steered in after Ns". `0` keeps the old behavior: wait for the turn to end.
- **Nothing kept is lost.** When the bridge stops, what it holds is handed to the session's own queue.
- **A Telegram call that failed to connect or timed out is tried once more** on a new connection (not `getUpdates`). A final reply that cannot be edited already falls back to a new message; it now has that retry too.

## Capabilities

### Modified Capabilities

- `chat`: delivery to a busy session.
- `server-bridge`: Telegram calls survive one dead connection.

## Out of scope

Applying the setting to a bridge that is already running (needs a restart), and changing what the host does with a queued prompt.

## Impact

- **Existing surface audit.** `src/bridge.ts` (`prompt`, `hold`, `release`, events), `src/config.ts` (`chat.queueSteerSeconds`), `src/connectors/telegram.ts` (`call`).
