## Why

A question from an agent was posted to Telegram as text only, ending "Answer this at the Mac: no OpenCode window is open to take a reply", with no buttons. The server half cannot reply to a form itself, so a reply was relayed through a TUI window, and with no window attached the bridge treated the question as unanswerable. The bridge runs inside the server, which does not need a window.

## What Changes

- **The bridge replies to a form through the local OpenCode service** (its discovery and client from `@opencode/client`), the way a TUI does. A question is posted with its buttons whenever the service answers or a window is attached.
- **A window relays the reply only when the service cannot.** With neither, the "answer at the Mac" note stays.
- **Reaction after the reply:** a failed reply now turns the waiting messages to 💔 (a sent reply was already 👌), and each reaction that was set is logged as `telegram_reaction` with its stage.

## Capabilities

### Added Capabilities

- `forms`: the reply route that needs no window.

## Impact

- **Existing surface audit.** `src/serviceclient.ts` (new), `src/server.ts` (reply route and gate), `src/bridge.ts` and `src/core/views.ts` (the gate may be async), `src/connectors/telegram.ts` (reactions).
