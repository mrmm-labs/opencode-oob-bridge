## Why

Open decisions pile up in a session: questions it raised in text, forms nobody answered, an open-questions file. Getting them answered on the phone takes a typed prompt each time. A fixed instruction makes the session ask them one form at a time, with the question tool.

## What Changes

- **`/qa [topic]`**, a session command. It sends a fixed instruction to the session, with the delivery of `/steer` (steered into a running turn, a plain send to an idle one), and answers like `/steer`. A typed topic is added as a focus, capped in length, and is only ever text.
- **A QA button on the turn card**, next to Continue, shown only when chat is on. A tap does what `/qa` does with no topic.
- **The command is in the registered list and the help of both scopes.**

## Capabilities

### Modified Capabilities

- `chat`: the command.
- `turn-card`: the button.
- `command-menu`: the list.

## Impact

`src/qa.ts` (new), `src/commands.ts`, `src/commandmenu.ts`, `src/bridge.ts`, `src/connectors/telegram.ts`, `README.md`.
