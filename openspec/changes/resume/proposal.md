## Why

The stuck-session alert shipped with a ▶ Resume button, but nothing proves it works on a real session. The logs of two sessions that were suspended for days show alerts sent and **no** resume attempt, and the database shows an empty inbox for both. The button reports "sent" when the host accepted a call, not when the session woke. A feature that cannot show it works is a feature we do not have.

## What Changes

- Resume reports an **outcome**, checked after the call: the session started working, or its waiting messages were taken, or it had no effect.
- The alert is edited to show the outcome and its button is consumed.
- One alert per suspension, with a re-alert only when the waiting count grows or after six hours.
- A `resume` log event with the result, so the next investigation has evidence.
- An opt-in **real-session check** (`pnpm test:real`): it starts an isolated `opencode serve`, makes a stuck session, taps Resume through the bridge, and asserts the outcome.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `stuck-session-alert`: Resume's outcome, the alert lifecycle and the evidence.

## Out of scope

Waking sessions by any call other than the host's synthetic message, changing what the host does when it refuses, automatic resume (the overnight mode does that, using this).

## Impact

- **Existing surface audit.** `src/control.ts` (stuck scan, `resume`, `sqliteProbe`), `src/bridge.ts` (alert, button), `src/subcommands.ts` (`/oob resume`), the `session_v2` and `session_inbox` tables read by the probe.
- **Supersession.** "Resume wakes the session through the host" gains an outcome.
- **Downstream.** `afk-overnight` calls Resume and trusts its outcome; `command-menu`'s `/resume` uses it.
- **Estimate.** Agent 1 day. Operator 10 minutes (one real stuck session to try).
- **Definition of done.** `pnpm test` ends `fail 0`, and the recorded output of `pnpm test:real` shows a stuck session resumed with outcome `working` against a real `opencode serve`.
