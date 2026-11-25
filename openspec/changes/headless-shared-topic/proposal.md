## Why

A script that starts sessions with `opencode run --session <id> --title role/name` makes sessions with no parent. Each gets its own Telegram forum topic: 13 topics like `<project> · reviewer-security/bold-gecko` and `<project> · verifier/lively-ibex`, none of which the operator ever opened. Real subagents already share their root's topic.

## What Changes

- **A headless session shares one topic per project.** A top-level session that was never viewed in a TUI is posted to `<project> · agents`, created on first use, and gets no topic of its own.
- **Headless means `time.viewed` is absent** in the host's session. OpenCode sets it when a viewer (a TUI) marks an idle transition as viewed, and announces it with a `session.viewed` event. The bridge keeps it current from that event.
- **Nothing that exists changes.** A session that already has its own topic keeps it. A session that is later viewed (or turns chat on) gets its own topic from its next message on. Topics are never deleted or renamed, and no sent text is edited.
- **Each message in the shared topic starts with a tag** with the session title. A reply goes to the session of the message it replies to; a message that replies to no known message is refused with a hint.
- **`channels.telegram.topics.headless`**: `"project"` (default) or `"session"` (the old behaviour).

## Capabilities

### Modified Capabilities

- `topics`: the shared topic of headless sessions.

## Out of scope

A topic per script run, merging topics that already exist, a per-session override, a status card for the shared topic, `send_file` into the shared topic (it asks for chat on, which gives the session its own topic).

## Impact

- **Existing surface audit.** `src/server.ts` (`Sessions`, `toSession`, event list), `src/bridge.ts` (`SessionInfo`, `homeOf`), `src/connectors/telegram.ts` (`thread`, `track`, `sessionAt`, `handle`, `send`, `update`, `turnCard`, `photos`, `document`, `topicLink`, config), `src/connectors/types.ts`, README, example config.
- **Config name.** The top-level `topics` key is the legacy ntfy topic pair, so the key lives under the channel: `channels.telegram.topics.headless`.
