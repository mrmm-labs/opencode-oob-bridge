## Context

`host.interrupt` (`ctx.session.interrupt`) already backs `/stop`, the turn card's Stop and the overnight plan. What is missing is a confirmed path from the status card, an owner check, an honest result and a way to see a stuck turn.

## Decisions

- **Same abort, new path.** `Bridge.interruptTurn(root, source)` does idle check, abort, result text and audit; the `/interrupt` command (after the yes) and the RPC op both call it. `/stop` is left as it is.
- **Confirmation is a menu.** `/interrupt` answers with the existing two-choice menu ("yes", "no"); the button is a shortcut that runs the same command, so the menu is the only way to abort from the card. Idle: no menu, a hint. The state is checked again at the tap (the turn may have ended).
- **Owner.** The connector compares the sender with the paired operator id (in a private chat, the chat id). Unknown operator means refused. This is stricter than the other buttons, which accept any member of the paired chat; it applies to the command, the button and the menu tap, which carries an `owner` flag.
- **Abort result.** `interrupted: true`: "Interrupted; send a message to continue", then one line for each kind of queued message. `false` while the bridge thinks the session is busy: the turn is not owned by this process, so the text says to press Esc in the window that runs it. A thrown error is shown, shortened and with secrets filtered.
- **Queued messages.** See the proposal. The bridge counts what it holds before the call and asks the host's inbox (`session.inbox.list`, bounded by the same time limit as `session.get`) after it. An inbox that does not answer leaves the count out. Checked against a live inbox with `opencode api GET /api/session/{id}/inbox`: items carry `delivery: "steer" | "queue"`, and the host's description of the interrupt says queued prompts stay parked unless `resume` is set.
- **Not verified live.** The abort itself was not run against a hung session; the behaviour of parked items is taken from the host's API description.
- **Stuck flag.** The server half marks progress on every session event it reads, including tool, step and reasoning events (a hung call makes none, but a long, healthy one makes progress events). A turn is stuck when it is working and nothing has been seen for `chat.stuckMinutes`. A check every 30 s redraws the card when the flag appears or the shown minutes (rounded down to 5) change. A child's events count for its root.
- **Audit.** One log line `interrupt` with session, source (`chat` or `rpc`), trace id, outcome, held and parked counts, and the paired user is never logged.

## What a client may rely on

The RPC op `interrupt` returns `{ ok, text }` like the other ops. Nothing in the core API changes.
