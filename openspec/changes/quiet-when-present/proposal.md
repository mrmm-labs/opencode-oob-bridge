## Why

A busy bridge sent 105 Telegram messages in a burst, 10 failed, and the Bot API answered HTTP 429. Typing indicators kept going while the person sat at the Mac. A session set to `on` ignored the away rule, so six sessions kept routing to the phone until each was reset by hand.

## What Changes

- **Present is quiet.** While the person does not count as away, the bridge sends nothing to a chat: no messages, no typing indicators, no edits. Polling continues, so a reply from the phone still works, and it counts as away.
- **`on` no longer beats presence.** A session's `on` means "route this session when away" (skipping the rules, choosing the channel), never "send while present". Only `/oob afk on <duration>` sends while present.
- **One digest when going away.** What was held while present (finished turns, open questions, open approvals) goes out as one message per chat topic, not a burst.
- **Coming back stops everything at once.** Typing indicators, timers and queued sends are dropped.
- **Presence follows rules, not toggles.** A message from Telegram makes the person away for `away.phoneMinutes` (30), each later message extends it; input in a TUI ends that only after `away.graceSeconds` (60) of continuous input; no input for `away.minutes` (10) is away; optional signals (`away.lock`, `away.sleep`, `away.schedule`) are off by default; `/afk` and `/back` (TUI and chat) win but end after a time (`away.overrideMinutes`, 120).
- **Layered settings** on the existing mechanism: built-in defaults, then the config file, then per-session overrides (`off`, `awayMinutes`) that can only tighten.
- **State and why** in the status snapshot, and one chat line when routing turns on or its reason changes; never sent while present.
- **A send budget per chat** for Telegram (`rate.gapMs`, `rate.perMinute`). Over budget, messages are merged, edits keep only the latest text, typing indicators are dropped, and `retry_after` is still honoured.
- **`route` with `root: "all"`** sets every session's mode at once; `/auto` does the same from a chat (to `auto` only).
- **New sessions default to `auto`**: a session started or put on chat from a chat is no longer forced `on`; subagents follow their root.
- **Telemetry:** the status snapshot shows sent, coalesced, suppressed and 429 counts per channel, and what was held while present.

## Capabilities

### Modified Capabilities

- `watch-afk`: presence, the meaning of `on`, the all-sessions op, defaults.

### Added Capabilities

- `send-budget`: the per-chat budget, coalescing and telemetry.

## Out of scope

a second settings file (the config file and the existing settings store are the only layers), per-session schedules, a GUI for the rules, ntfy (a push is not a thread and has no such limit), the multipart upload calls inside the budget (they are muted while present but not paced), per-chat-type budgets (one default for all chats), changing `away.minutes`.

## Impact

- **Existing surface audit.** `src/routing.ts` (`decide`, `away`), `src/bridge.ts` (`routed`, `startChat`, `setChat`, status), `src/control.ts` (`route`), `src/remote.ts`, `src/commands.ts` and `src/commandmenu.ts`, `src/connectors/telegram.ts` (`call`, `pulse`, `status`, options), `src/rpc.ts` and `src/control.ts` (snapshot), `src/menu.ts` (`/oob status`).
- **Behaviour change by default.** A session set to `on` stays quiet while you type at the Mac.
