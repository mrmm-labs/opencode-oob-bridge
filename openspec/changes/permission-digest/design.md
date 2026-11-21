## Decisions

- **Chats only.** The digest goes to connectors that chat (`inboundPrompt`); ntfy keeps one push per permission, since a push is not a thread.
- **One digest per root session**, kept in memory. After a restart the next permission starts a new digest from the pending store.
- **Edit rate.** A change schedules a flush; a flush runs no sooner than 10 seconds after the last one, so a burst becomes one edit. A failed edit posts a new message.
- **Counting.** The count is read from the pending store, so an answer in the TUI, from a channel or a cancel all lower it.
- **Buttons win.** When the permission can be answered here the individual message with its buttons is the useful one.
