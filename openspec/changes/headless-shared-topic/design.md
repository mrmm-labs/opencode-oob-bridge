## Context

`Bridge.routed()` already maps any session to its root (`host.root`) and the connector's `thread()` makes one topic per root id. A script session has no `parentID`, so it is its own root.

## Decisions

- **The signal is `time.viewed`.** Checked against the host's OpenAPI and 50 live sessions: 40 children, none viewed; 10 top-level, 4 viewed (the operator's own) and 6 not (all role-titled script sessions). `POST /api/session/{id}/view {idle}` sets it ("Mark the idle transition observed by the viewer as viewed") and emits `session.viewed {sessionID, idle}`.
- **Known gap.** `viewed` appears only after a viewer observes the first idle. The operator's own new session is unviewed during its first turn, so that turn's messages land in the shared topic; later messages follow the normal rule. A session with chat on is never treated as headless, which covers a session the operator talks to from Telegram.
- **The bridge decides, the connector places.** `Bridge.homeOf(id)` returns `{ key, name, tag }` for a headless root, else nothing. The connector asks it (`Connector.home`) inside `thread()`, so every place that posts into a session topic uses one rule. No other call site changes.
- **Order in `thread()`.** (1) the session's own topic if it exists; (2) the shared topic when `homeOf` says so and `topics.headless` is `"project"`; (3) a new own topic. Rule 1 is what keeps existing topics and makes the transition one-way.
- **Project key.** The base name of the directory, as everywhere else the bridge says "project". Stored as `<chat>:agents/<project>` in the topics file; code that walks the file for session ids skips the `agents/` keys.
- **No status card, rename, pin, typing or app message** for the shared topic: `track()` returns early for a session placed there. Those belong to one session.
- **Tag.** First line of each push, turn card, photo and document caption, and kept when a push is edited: the session title (redacted as elsewhere; the last 6 characters of the id when titles are redacted).
- **Replies.** `sessionAt` ignores shared topics, so only the replied-to message names the session (the `sent` map). A shared-topic message with no resolved session is refused with a hint and a 🙈. The map is in memory: after a restart older messages answer with the hint too.
- **Config.** Validated at load; not settable at runtime. `"session"` is the only way back to a topic per session.

## What a client may rely on

Nothing in the core API changes. `/sessions` links a shared session to the shared topic.
