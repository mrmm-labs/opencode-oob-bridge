## Why

The Telegram chat UI calls the host straight from `bridge.ts` and `commands.ts`. A Mini App, the turn card, the digest and approvals all need the same session views and the same actions. A second copy of that logic would drift. One channel-agnostic core, with Telegram and the Mini App as two clients of it, is the refactor that makes every later change small.

## What Changes

- A core of **view-models**: session summary and detail (state, watch and chat settings, conversation tail, todos, diff summary, pending questions, pending permissions, stuck state).
- A core of **actions**: answer a question, reply to a permission, resume, stop, prompt, compact, undo, switch model, switch agent, create a session, set watch, set chat.
- The server bridge serves both as one versioned **HTTP + SSE API** under `/v1`. It listens only on a private-network or loopback address and authenticates every request.
- The Telegram chat commands and buttons call the same actions. Nothing changes for a Telegram user.
- The TUI RPC keeps its shape and is served by the same actions.

## Capabilities

### New Capabilities

- `core-api`: the view-models, the actions, the `/v1` HTTP and SSE API, its versioning, authentication and listen address.

### Modified Capabilities

- `server-bridge`: the core listener follows the bridge's single owner.
- `chat`: Telegram chat acts through the core actions.

## Out of scope

The Mini App itself, the approvals socket, WebSocket, more than one operator, voice notes, any public listener, a stable plugin API for third parties.

## Impact

- **Existing surface audit.** `src/control.ts` (`Control`, snapshot), `src/rpc.ts` (ops), `src/bridge.ts` (host calls), `src/commands.ts` and `src/menu.ts` (Telegram and TUI commands), `src/server.ts` (hub, boot), `src/settings.ts`. The core extends `Control` and its settings; it adds no second state store.
- **Supersession.** The direct host calls in `bridge.ts` and `commands.ts` move behind the actions.
- **Downstream.** Every other change of this round reads or acts through the core. The Mini App is its second client.
- **Estimate.** Agent 1.5 days. Operator 30 minutes (token and bind address).
- **Definition of done.** `pnpm test` ends `fail 0` with the core tests, and a recorded run against a real `opencode serve` shows `/v1/meta`, `/v1/sessions` and the SSE stream answer 200 with the token and 401 without it.
