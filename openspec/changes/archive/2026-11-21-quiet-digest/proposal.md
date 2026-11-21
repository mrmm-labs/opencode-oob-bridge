## Why

At night the phone should stay quiet, and in the morning the operator wants one message that says what finished, what failed and what waits for an answer. Today every push buzzes at any hour and there is no summary.

## What Changes

- **Quiet hours**: between two clock times nothing makes a sound or a notification. Messages are still delivered, silently, so the topics stay complete.
- A **digest**: one message at a set time (default the end of quiet hours) with three sections: finished, failed, waiting on you. `/digest` sends it on request.
- Both are off until configured.

## Capabilities

### New Capabilities

- `quiet-hours`: the schedule, what silent delivery means per channel, and the break-through list.
- `digest`: when it is sent, what it holds, how it is stored.

### Modified Capabilities

None.

## Out of scope

Holding messages back (they are delivered silently, not delayed), per-session quiet hours, a weekly digest, the overnight section (`afk-overnight` adds it).

## Impact

- **Existing surface audit.** `src/bridge.ts` (push priority and sound), `src/connectors/telegram.ts` (`disable_notification`), `src/connectors/ntfy.ts` (priority), `src/pending.ts` (open prompts), `src/settings.ts`.
- **Supersession.** None.
- **Downstream.** `afk-overnight` adds a night section; `command-menu`'s `/digest` starts working.
- **Estimate.** Agent 1 day. Operator 5 minutes (hours, time zone).
- **Definition of done.** `pnpm test` ends `fail 0`, and a recorded run with a fake clock shows silent delivery inside the window, a normal one outside it, and one digest at the set time.
