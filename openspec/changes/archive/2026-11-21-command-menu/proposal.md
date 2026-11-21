## Why

The bot registers one fixed command list for the paired chat. The operator's everyday actions (status, stop, model, agent, compact, undo, resume, afk, digest) are not all in it, and the list does not say which commands work where. Telegram's menu is the phone's main way to find a command.

## What Changes

- The registered menu starts with the operator's nine commands, in a fixed order, then the existing ones.
- `/undo`, `/resume`, `/afk` and `/digest` are new. `/status`, `/stop`, `/model`, `/agent` and `/compact` already exist.
- A command whose feature is off is left out of the menu and, if typed, answers that it is not enabled.
- Registration happens only when the list changed.

## Capabilities

### New Capabilities

- `command-menu`: which commands are registered, in what order, for which scope, and how the new commands behave.

### Modified Capabilities

None.

## Out of scope

Per-topic menus (Telegram has no per-topic scope, see the design), per-user menus, inline mode, changing what `/model`, `/agent`, `/stop` and `/compact` do, switching AFK from a chat.

## Impact

- **Existing surface audit.** `src/commands.ts` (handlers, the help text), `src/connectors/telegram.ts` (the `setMyCommands` call), `src/core/actions.ts` from `core-api` (`undo`, `resume`).
- **Supersession.** The fixed list in `telegram.ts`.
- **Downstream.** `/digest` needs `quiet-digest`; `/undo` needs the core `undo` action.
- **Estimate.** Agent 0.5 day. Operator 5 minutes.
- **Definition of done.** `pnpm test` ends `fail 0`, and a recorded `getMyCommands` call against a test bot shows the nine commands first.
