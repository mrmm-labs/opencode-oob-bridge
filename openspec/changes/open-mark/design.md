## Decisions

- **Same source as the close.** `topicTick` already reads the sessions open in a TUI (per-TUI heartbeat, 45 s presence window). It hands that set to each connector's `markOpen` every 10 s. The connector compares it to what each topic has and renames only on a difference.
- **Two names.** `Topic.name` is the base name as before (a session's name, `⚪ ` for an unstarted one) and never holds the mark. `Topic.marked` says whether the name in Telegram has it. The name sent is `🟢 <base>` when the mark is wanted and the base does not already start with it, so it is never doubled, and it is cut to 128.
- **One pace for renames.** The time of the last rename of each topic is kept per topic and used by both the title/icon rename in `flush` and the mark. A rename that is due later is retried by the next tick (mark) or the flush timer (title). A failed rename counts, so it is not retried for 60 s.
- **A rename that sets the name Telegram already has** (`TOPIC_NOT_MODIFIED`) is taken as done.
- **Closed topics are skipped**: an open session's topic is not closed, and a mark is taken off long before the 2-minute settle.
- **Off.** With `markOpen: false` no mark is wanted, so a topic that has one is renamed back once, then nothing more is sent.
- **Only topics of sessions** (`ses_` keys): shared and approvals topics are never marked.
- **Cards off.** `subTouch` returns at once, so nothing is created, edited or replied to. Cards already posted stay in the chat.
- **Not verified live.** `editForumTopic` with an emoji-led name was not run against the real API.
