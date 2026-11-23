## Decisions

- **Where the id is kept.** In the topic's own record in the topics file (`<channel>-topics.json`), next to the status card id: `app` (message id) and `appPinned`. The settings file holds global choices, not per-topic ones.
- **When it runs.** After the topic's status card step (so the card stays the first message), and in a sweep once at startup over the topics already known. A set of keys done in this run makes it once per run. The sweep runs when both the app link and the poller are ready, whichever comes second.
- **Which topics.** Topics keyed to a session. The "Approvals" topic is not bound to a session and is skipped. Nothing is posted in a private chat or a group without topics, or when no app link is configured, because a message without its button is no use; nothing is logged then, and the next start or `launch` tries again.
- **One step.** With no stored id: post, then pin. With a stored id: edit in place (the button follows the current link); "not modified" is success; "not found" posts a new one and pins it. If it is not pinned yet (a failed pin) the pin is tried again once per run. An already pinned message is never pinned again.
- **Pin order.** Telegram's bar shows the latest pin. When a new app message is pinned in a topic that has a pinned card, the card is pinned again silently, as `/status` already does, so the card keeps the bar.
- **Logs.** `topic_pin` with `thread` and `outcome`: `pinned`, `edited`, `recreated`, `unpinned` (posted but the pin failed) or `failed` (the post or edit failed; not retried in this run). `topic_pin_failed` with `thread` and `reason`: `no_pin_right` for "not enough rights" or admin errors, otherwise the redacted Telegram message.
- **Silent.** Both the post and the pin use `disable_notification`.
