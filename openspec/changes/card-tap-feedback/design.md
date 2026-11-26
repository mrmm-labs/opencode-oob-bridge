## Decisions

- **Early toast.** `dispatch` starts the toast for a card button the moment the update arrives, with the topic's name read from the local topic map (no host call). `toast` remembers the callback ids it has answered, so the later toast of the handler is a no-op, and a tap that is handled without the early toast (a retry) still answers.
- **Own lane.** Callbacks use the lane `<chat>:<thread>:tap`. Messages keep `<chat>:<thread>`. Permission and menu taps move with them; they never depended on the order against messages.
- **Deadline, not a host timeout.** `session.prompt` is not given a timeout for chat messages: a timed out prompt that still lands would be sent again by the retry. Only card buttons race a deadline in the bridge, and they are not retried, so the text says it may still arrive.
- **State as reaction.** The outcome of `QA`, `Update` and `Continue` carries `sent` and `delivered.how` as a typed message already does; the connector reacts on the tapped message with that stage. `Stop`, `Resume` and `Diff` are not changed: their result is the toast text ("Waking it…", "Nothing is running", the deny reason), which a reaction cannot carry. A failure reacts `failed` and posts the reason. Reactions are best effort, and a failed one is logged by the existing code; the topic line for a failure does not depend on it.
- **Not verified live.** Telegram accepting a reaction on the bot's own card was not tried against the real API.
- **Log.** `telegram_inbound` gets `action`, `result` (`sent`, `steered`, `queued`, `done` or `failed`) and `ack_ms`. A failed result sets the line's outcome to `failed` with the reason.

## Cause of the 17 s

Taps at 22:03 on one topic ended 5 s apart, each reporting 17 to 18 s: the second waited for the first. The first ran the deny check and `session.prompt` against a coordinator that did not answer. The serial lane and the missing limit are removed; the host's slowness is not, and is now shown instead of hidden.
