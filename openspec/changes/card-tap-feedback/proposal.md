## Why

Tapping QA or Update on a card showed nothing for many seconds, and sometimes nothing at all. The log said `handled` after 17 and 18 seconds. Three things stacked up:

- A tap ran in the topic's one serial lane, behind the update before it (a message waiting on a slow host, or the tap before).
- The work behind it (`session.get` for the deny check, up to 8 s, then `session.prompt`) had no time limit, and `answerCallbackQuery` only went out after it.
- The toast, once sent, was the only feedback: it carried no delivery state, and a failure was a toast that is gone in seconds.

## What Changes

- **A tap on QA, Update or Continue is answered on arrival**, before it joins the topic's queue, with a toast like "⏳ QA sent to <topic>". Stop, Resume and Diff keep their result toast, which carries what they did.
- **Taps have a lane of their own** per topic (all card buttons): they wait for earlier taps (so a double tap is not run twice at once) but not for messages.
- **The work has a deadline** (12 s). A host that does not answer in time gives a visible error saying the message may still arrive.
- **The state is shown on the tapped message** as a reaction: sent, steered, queued or failed, from the reaction set the bridge already uses. No text is rewritten.
- **A failure posts a short line in the topic** with the reason.
- **The log line of each callback names the action and its result**, and the time the toast took.

## Capabilities

### Modified Capabilities

- `pinned-card`: how a card button answers, shows its state and reports failure.

## Out of scope

Changing what the buttons do. The permission, menu and form buttons keep their current answers. `Interrupt` keeps its own owner check and confirmation.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (dispatch lanes, callback handling, toast), `src/bridge.ts` (`cardButton`, `control`), README (card buttons).
- **No new config.** The deadline is a constant.
