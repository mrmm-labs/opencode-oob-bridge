## Why

Open decisions pile up in a session: questions it raised in text, forms nobody answered, and whatever records the project keeps. Getting them answered on the phone takes a typed prompt each time. A fixed instruction makes the session ask them one form at a time, with the question tool.

## What Changes

- **`/qa [topic]`**, a session command. It sends a fixed instruction to the session, with the delivery of `/steer` (steered into a running turn, a plain send to an idle one), and answers like `/steer`. A typed topic is added as a focus, capped in length, and is only ever text.
- **A QA button on the turn card**, next to Continue, shown only when chat is on. A tap does what `/qa` does with no topic.
- **`/update [topic]`**, the same shape, with a fixed instruction asking for a short progress update.
- **The status card gets QA and Update buttons**, shown while chat is on. The Done card gets Update too: its row is Diff, Continue, QA, Update, Stop, five at most.
- **The Mini App session screen gets QA and Update actions**, shown while chat is on, sent through the existing authenticated action endpoint. The bridge refuses them with chat off or for a denied session.
- **Both commands are in the registered list and the help of both scopes.**

## Capabilities

### Modified Capabilities

- `chat`: the command.
- `turn-card`: the button.
- `command-menu`: the list.
- `mini-app`: the actions.
- `pinned-card`: the buttons.

## Impact

`src/qa.ts` (new), `src/commands.ts`, `src/commandmenu.ts`, `src/bridge.ts`, `src/connectors/telegram.ts`, `src/core/actions.ts`, `miniapp/views.js`, `README.md`.
