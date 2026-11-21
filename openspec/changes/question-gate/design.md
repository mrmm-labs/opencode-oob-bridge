## Context

`Bridge.prompt` sent every plain message to `host.prompt`. With a form open the host queued it behind the turn that waits for the form.

## Decisions

- **Hold in the commands flow store.** The kept text goes in a `held` flow (10 minute expiry, bounded count) and the three choices are a menu whose tap comes back as the existing `pick` command. No new inbound path.
- **Send anyway uses `steer`.** The session is not idle, so the message goes in at once.
- **Answer posts the question again.** The question message is built by one function used by the first push and the repost. A channel keeps one reference per pending question, so the repost replaces it: the old message may keep stale buttons, and a tap on them says it was already answered.
- **`!text` is not held.** It is the operator's explicit steer.

## What a client may rely on

- A held message is never sent without a tap and never silently lost: the topic says what is waiting.

Left to the host: cancelling a form.
