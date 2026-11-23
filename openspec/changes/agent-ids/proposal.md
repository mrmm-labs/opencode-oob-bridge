## Why

Starting a session from the Mini App made a dead session. The app sent the agent's display name (`Build`), OpenCode wants its id (`build`), and every drain failed with `Agent not found`. The bridge had already created the session and its topic and pinned the app message, so the phone showed a live-looking topic that never ran. The in-session agent switch had the same flaw.

## What Changes

- **Agents are `{ id, label }`.** The list the host gives, `GET /v1/options` and the Mini App pickers carry the id as the value and the label for display only. Every call to OpenCode gets the id.
- **A name still works.** On create and on switch the bridge accepts an id or, case-insensitively, a label (`Build` becomes `build`). The same goes for the `agent` of `chat.projects`.
- **An unknown agent is refused before anything exists.** No session, no topic, no pin. When OpenCode lists no agents at all, the value is passed through as given.
- **A session that fails within 60 seconds of its creation is marked not started.** Its topic name gets a ⚪ prefix, its status card reads "⚪ Did not start", and the Mini App shows "Did not start" instead of "Failed".
- **`session_create` is logged by the action**, so the Mini App and the chat both log it, with the agent id, the session and the outcome.

## Capabilities

### Modified Capabilities

- `chat`: starting a session, switching an agent.
- `mini-app`: the options and the pickers.
- `topics`: a session that did not start.

## Impact

`src/bridge.ts`, `src/server.ts`, `src/core/actions.ts`, `src/core/views.ts`, `src/commands.ts`, `src/connectors/telegram.ts`, `src/connectors/telegram-render.ts`, `src/connectors/types.ts`, `miniapp/views.js`, `miniapp/format.js`, `miniapp/app.css`.

Models and variants were checked: the app already sends the model `ref` (`provider/id`) and the variant id, and shows names only as labels.
