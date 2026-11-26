## Decisions

- **Who decides.** The bridge knows what headless is (`viewed`, parent, chat, busy, pending prompts); the connector knows topics. The bridge asks the connector for the session ids that have an open topic of their own (`topicSessions`) and tells it to close one (`closeTopic`). The host's `session` is read before `busy`, because the host fills in what is running when it loads a session.
- **The topics file gains `closed`.** A closed topic is not closed again, and a sweep skips it. The flag is dropped when the topic is reopened.
- **Reopen.** `thread()` reopens a closed topic before anything is posted, except for the status card of an idle or failed session (editing a card needs no open topic, and reopening for it would undo the close). A turn that starts is a working card, so it reopens.
- **Calls.** `closeForumTopic` and `reopenForumTopic` go through the normal wrapper and join the paced methods, so the budget spaces them. They are not in the list of methods refused while present: closing is tidying, and a sweep that waited until the user is away would not run for a user who is at the desk. A topic the user closed by hand answers `TOPIC_NOT_MODIFIED`, which counts as closed.
- **Failure.** A failed close is logged and left; the next end of the session tries again. Nothing is retried in a loop, and delivery is not affected.
- **Not verified live.** The calls were not run against the real API. The bot needs the manage-topics right it already needs to create topics.
- **Log lines.** `telegram_topic_closed`, `telegram_topic_close_failed`, `telegram_topic_reopened`, `telegram_topic_reopen_failed`, each with `session`, `thread` and, for a close, `why` (`start` or `ended`).
