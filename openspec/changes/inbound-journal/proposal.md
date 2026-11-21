## Why

A message sent from Telegram can vanish. The poll loop moves the update offset forward before the message is handled, and it waits for each handler in turn. A handler that hangs holds every later message. A restart, a crash or a host error between "Telegram was told it arrived" and "the session got it" loses the message, and nothing says so: the success path writes no log line, and several refusal paths return without one. The operator cannot tell a lost message from a slow one.

## What Changes

- **Inbound journal.** Every update is written to a file in the data directory before the offset moves. It is marked done when handled. Unfinished entries are handled again at the next start.
- **Poll loop never waits for handlers.** Updates run in order per topic, in parallel across topics, each with a time limit.
- **Outcome for every update.** One `telegram_inbound` log line per update: kind, thread, outcome (delivered, refused, ignored, rejected, failed, error) and the reason. Never the text. The bridge adds one `inbound` line per message it receives from any channel.
- **Failed delivery is kept and said.** When the session cannot take a message, the topic is told why, the message is tried again after 5 s, 30 s and 2 min, and a last note says when it gave up.
- **Suspended probe.** A session whose turn is running is never reported as suspended, whatever `time_suspended` still says.

## Capabilities

### New Capabilities

- `inbound-journal`: the journal, per-topic handling, the outcome log and the retry of a failed delivery.

### Modified Capabilities

None.

## Out of scope

Traces, metrics and a trace command (a follow-up change), the reply path of a session, reactions per processing state, a watchdog that restarts a stalled bridge, ntfy (it has no offset to lose).

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (poll loop, `onUpdate`, `onMedia`), `src/bridge.ts` (`onInbound`, `prompt`), `src/connectors/types.ts` (`Outcome`, `Capabilities`), `src/control.ts` (`sqliteProbe`).
