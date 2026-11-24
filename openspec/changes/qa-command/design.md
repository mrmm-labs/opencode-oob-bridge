## Decisions

- **One instruction, one function.** `qaText(topic?)` in `src/qa.ts` builds the prompt for the command and the button, so they cannot drift.
- **Delivery.** `steer`, as `/steer`: the host steers a busy session and plainly sends to an idle one. The button uses it too, not the session's own delivery, because it must do exactly what `/qa` does.
- **The topic** has its whitespace collapsed to single spaces and is cut to 200 characters. It is appended as `Focus: <topic>`. It is never read as a folder, a model or an agent.
- **Gates.** The command goes through the same chat-on and `chat.deny` gate as the other session commands, and the same scope refusal in General. The button reuses the card-button path: the session comes from the topic the tap was made in, a tap from another chat is ignored, a tap with chat off is refused, `chat.deny` is checked by the prompt action, and the callback is always answered.
- **Four buttons.** Diff, Continue, QA and Stop. QA appears with Continue, so a card with chat off keeps Diff and Stop.
