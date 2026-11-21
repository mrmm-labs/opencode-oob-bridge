## Why

In a topic it was not clear which prompts were typed at the Mac, which were sent from Telegram, and where a question was answered.

## What Changes

- A prompt typed at the Mac is posted as its own short message, `🖥 You at the Mac: <text>`, redacted with the chat rules, when the session is mirrored. A prompt that came from Telegram is not echoed back; a repeated inbox event is posted once.
- A question or permission answered at the Mac is edited to `✅ Answered at the Mac: <choice>`; one answered in Telegram to `✅ Answered in Telegram: <choice>`. Buttons are removed.
- The turn card shows `🖥 Mac` or `📱 Telegram`.

## Capabilities

### Added Capabilities

- `chat`: the origin labels.

## Impact

- **Existing surface audit.** `src/bridge.ts` (inbox events, answer labels, sent-prompt tracking), `src/connectors/telegram-render.ts`, `src/turncard.ts`, `src/connectors/types.ts`. The closed-card text of Telegram changes; ntfy text does not.
