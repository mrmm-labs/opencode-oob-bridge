## Why

The log shows `telegram getUpdates failed: HTTP 409 Conflict: terminated by other getUpdates request` right after plugin reloads. Telegram allows one `getUpdates` per bot: a loop that starts while the previous one's request is still open on Telegram's side gets or causes a 409. The bridge restarts in place on a reload, on `/oob restart` and now when the watchdog restarts it, and the new loop started at once.

## What Changes

- **One receive loop per bot in a process.** A loop that replaces another waits for it to end, up to 5 seconds, and logs `telegram_poll_handover`.
- **A 409 is a conflict, not an error.** It is logged once per episode as `telegram_poll_conflict`, shown in `/oob status` as "another process is polling this bot (HTTP 409)", retried with the normal backoff, and cleared on the next good poll.

## Capabilities

### Modified Capabilities

- `server-bridge`: the receive loop's start and conflict handling.

## Out of scope

Finding who else polls the bot (another process or machine sharing the token), and the file lock between processes, which is unchanged.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`poll`, `loop`, `receive`).
