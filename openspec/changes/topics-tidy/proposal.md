## Why

The bridge closes the topic of an idle headless session by itself, but it cannot tidy the topics already there on request: sessions the host deleted, old sessions a person once viewed, topics from before the automatic close. In one map, 13 of 31 topics were closed and many of the rest were stale.

## What Changes

- **`/topics`** in a chat and the control op **`topics`** (`{ apply?, idleHours? }`, for `rpc.call`). Without `apply` it is a dry run: it lists each open topic with its name, the time since its session was last active and a verdict, `close` or `keep`, and changes nothing.
- **`close`** when the session is deleted or unknown, or has been idle longer than `idleHours` (default 24) and is not working, has no chat on, and has no question or permission waiting. Everything else is `keep`.
- **Apply** closes every `close` topic through the existing `closeTopic` path (`closeForumTopic`). It never deletes a topic and never touches a message.
- **Always kept:** the topic of the session the command was sent from, the shared `<project> · agents` topics and the Approvals topic.
- **Map cleanup:** entries are dropped from the topics file only for topics already closed before this run whose session no longer exists. The file is copied to a backup first.
- **Owner only to apply.** A dry run is open to the paired chat.
- **Topics follow the session state, by themselves.** A topic stays open while its session is open in a TUI or working. Once the session has been quiet, not working and not open in any TUI for 2 minutes, the bridge closes its topic. It reopens it when the session is active again: a turn starts, a question or permission is posted, a message is posted to it, or the user writes in it. A reopened topic is not closed again for 10 minutes.
- **Guards.** Never a topic with a question or permission waiting, with chat on, or of a session open in a TUI; never the shared `<project> · agents` topics or the Approvals topic.
- **Switch.** `channels.telegram.topics.closeIdle` (default `true`) governs sessions that were viewed; `closeHeadless` keeps governing headless ones. Both off: nothing closes by itself. `/topics apply` is not stopped by either.

## Not built: pinning topics

A bot cannot pin a forum topic. Bot API 10.5 has no `pinForumTopic` (zero mentions); its pin methods act on messages (`pinChatMessage`, `unpinAllForumTopicMessages`). The client-side topic pin is a user-account (MTProto) feature. Nothing was built in its place: see the options in the design.

## Capabilities

### Modified Capabilities

- `topics`: tidying topics on request, and closing and reopening them by session state.
- `pilot-tui`: the `topics` RPC op.

## Out of scope

Deleting topics, closing topics of a session that is working, has chat on or has something waiting, pinning topics (see above), and reopening a topic only because a TUI opened its session.

## Impact

- **Existing surface audit.** `src/bridge.ts` (`tidyTopics`), `src/commands.ts`, `src/commandmenu.ts`, `src/control.ts`, `src/connectors/telegram.ts` and `types.ts` (`topicEntries`, `forgetTopics`, `closeTopic` with a reason), `src/server.ts` (session activity time), `src/control.ts` (sessions open per TUI), README, example config.
