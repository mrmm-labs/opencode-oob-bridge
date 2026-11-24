## Decisions

- **One definition of present.** `Router.away()` stays the only answer. The bridge and the connectors ask it live, so a keystroke silences them at once; a 2 s tick only runs the edge work (the digest, dropping queues).
- **`on` is a routing choice, not an override.** `Router.decide` returns `present` for a forced `on` while not away. `off` still wins over everything. `afk on` is the override and it already has a duration.
- **Rules, in order, first that holds wins.** (1) a forced `/afk` or `/back`, until its end; (2) screen locked (`away.lock`); (3) the machine slept and no input since (`away.sleep`); (4) a message from the paired chat within `away.phoneMinutes`, unless a TUI has had continuous input for `away.graceSeconds` since it; (5) the first `away.schedule` window that holds; (6) no TUI attached, or no input for `away.minutes`: away; else here. `Router.state()` returns the state, the rule and its end; the status and the chat line are built from it.
- **Grace.** A run of input ends when the gap to the next is longer than the grace. Away-by-phone ends only when a run that began after the phone message is as long as the grace, so a glance at the keyboard does not flip it; each new phone message restarts the wait.
- **Time-boxed overrides.** `/afk [time]` and `/back [time]` (and `/oob afk on|off [time]`) always get an end: the time given, else `away.overrideMinutes`. After it the rules decide again. An untimed forced mode stored by an older version is dropped on start.
- **Layers.** Defaults live in `config.ts` (`AWAY_DEFAULTS`), the config file's `away` object overrides them, and a session's own entry in the settings store (`off`, `awayMinutes`) overrides for that session. Direction: a session may only lengthen the idle time, never shorten it; `on` never sends while present; `off` and a longer `awayMinutes` quiet a session. Loosening is only a timed `/afk`.
- **The line.** When the state becomes away, or its rule changes while away, one line (`Routing on · why`) goes to channels that chat. Becoming present sends nothing.
- **Lock and sleep.** The server polls the OS every 10 s for a lock (`ioreg` on macOS, `loginctl` on Linux) only when `away.lock` is on. A gap of more than 30 s between 2 s ticks means the machine slept.
- **Held, then digested.** While present the bridge counts per root session what it did not send (finished, failed, question, permission). When the person becomes away it sends one notice per topic (threaded channels) or one combined notice (others). Open questions and approvals are read live from the pending store, so an answered one is not listed.
- **The connector is the last gate.** Telegram refuses visible calls (`send*`, `edit*`, `pin*`, reactions, topic edits, deletes) while muted, except for 30 s after an update from the paired chat, so a command typed on the phone is answered. Polling, `answerCallbackQuery` and menu registration are never muted.
- **Budget per chat.** A lane per `chat_id` spaces calls by `rate.gapMs` (default 1100) and allows `rate.perMinute` (default 18, under the 20 per minute of a group). Over budget: a plain `sendMessage` joins the queued one of the same topic (HTML, no buttons, under 4096 characters); an edit of the same message replaces the queued edit; `sendChatAction` is dropped; a message with buttons waits its turn. A 429 holds the lane for `retry_after` and the call is retried as before.
- **Coming back drops the queue.** Queued calls fail with a muted error that is not logged as a channel error.
- **`/auto` only quiets.** A chat can put sessions back on `auto`, never on `on`.

## What a client may rely on

- While not away nothing is sent to a chat (except answers to what the person just did there).
- A burst of N messages to one chat becomes at most `rate.perMinute` calls a minute.

Left to the channel: Telegram's own limits, which the defaults sit under.
