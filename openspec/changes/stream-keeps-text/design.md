## Decisions

- **Step boundary.** The bridge already drops the earlier parts when a new assistant message starts. The stream now gets that message id, and a different id seals the current stream: its last text is painted (up to three tries, ignoring the edit gap), a draft preview is posted as a real message, and a new stream starts after it.
- **Earlier narration is not marked.** The least noisy choice is no mark. Each step is already its own message, sent silently.
- **In place or new.** The final edits streamed message _i_ only when the visible text of final message _i_ (HTML without tags) starts with the visible text shown. Anything else is sent as a new message. Streamed messages that the final does not reach are left as they are.
- **Failure.** The failed final reacts 💔 as before. One retry runs after 20 seconds with the state of what was already edited or sent, so nothing is posted twice; on success the reaction becomes 👌. A second failure stays 💔.
