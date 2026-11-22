## Why

The streamed message showed the text of each step of a turn, and the final reply then edited it down to the last step's text and deleted the extra messages. Text a person had already read changed or vanished. A final reply that failed (edit timeouts) also left a stream behind with no clean end.

## What Changes

- **A later step keeps the earlier one.** When the assistant starts a new message (a step after tool calls), what was shown of the earlier step stays as its own message and the new text goes in new messages.
- **The final reply never rewrites shown text.** A streamed message is edited in place only when the final text extends it. Otherwise the final goes in a new message and the streamed one is left as it is. No message is deleted.
- **A failed final is tried again.** The stream message stays. The final is posted as a new message once more after 20 seconds (`finalRetryMs`), and the reaction on the person's message changes from 💔 to 👌 when it gets through.

## Capabilities

### Added Capabilities

- `streaming`: shown text is kept.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`stream`, `seal`, `reply`), `src/connectors/types.ts` (`stream` takes the step), `src/bridge.ts` (passes the assistant message id).
