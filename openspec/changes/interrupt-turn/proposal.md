## Why

A coordinator turn can hang on one call that never returns. The operator's steered Telegram messages then queue behind it. `/stop` and the turn card's Stop button exist, but they act at once, only the latest turn card carries a button, and the status card (the one pinned in the topic) has no way to stop a turn: its only button, "Stop chat", turns routing off.

## What Changes

- **"⏹ Interrupt" on the status card**, shown only while the session is working and chat is on (like every session command), and an **`/interrupt`** command in the topic. Both ask "Interrupt the running turn?" with yes and no. Only yes aborts.
- **Owner only.** The command, the button and the yes/no tap are refused for any Telegram user but the paired owner.
- **The abort is the host's own** `session.interrupt` (`POST /api/session/{id}/interrupt`, `SessionInterruptInput` in `@opencode/client`): the call the TUI's Esc makes. It stops only an execution owned by this OpenCode process, and returns `interrupted: false` otherwise.
- **A result in the topic** says what happened and what became of the queued messages. Every attempt is written to the bridge log with the trace id.
- **A stuck turn is flagged on the card**: busy and no session event for `chat.stuckMinutes` (default 30, 0 turns it off), with how long it has been busy.
- **Parity**: the RPC op `interrupt` takes `session`, with no confirmation (a local caller).

## Queued messages

They are not lost, and nothing is re-sent. Messages the bridge holds (`chat.queueSteerSeconds`) are released as normal prompts when the interrupt event arrives, which is what `session.execution.interrupted` already did. Messages already in the host's inbox stay there (the interrupt is called without `resume`) and run with the session's next turn. The result counts both and points at ▶ Resume / `/resume` for the second kind.

## Capabilities

### Modified Capabilities

- `chat`: the `/interrupt` command, its confirmation, owner rule and result.
- `pinned-card`: the Interrupt button and the stuck flag.
- `pilot-tui`: the `interrupt` RPC op.

## Out of scope

`resume: true` (running queued messages at once), an automatic abort of a stuck turn, aborting a turn that belongs to another OpenCode process, changing `/stop` and the turn card's Stop button (they keep acting at once).

## Impact

- **Existing surface audit.** `src/commands.ts`, `src/commandmenu.ts`, `src/bridge.ts` (`interruptTurn`, activity, stuck), `src/server.ts` (feed, `Host.queued`), `src/control.ts`, `src/config.ts`, `src/connectors/telegram.ts` (card keyboard, callbacks, owner), `telegram-render.ts`, `types.ts`, README, example config.
- **New event subscriptions.** Tool, step and reasoning events are read only to mark progress; they are not passed to the core API ring or the bridge.
