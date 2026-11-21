## Decisions

### D1. One list per chat, not per topic

Telegram's `BotCommandScope` has seven scopes: default, all private chats, all group chats, all chat administrators, one chat, the administrators of one chat, and one member of one chat. None is a topic. A menu per topic cannot exist. The bot therefore registers one list for the paired chat (scope `BotCommandScopeChat`, or all private chats when the pairing is a private chat) and keeps the existing hint when a command is used in the wrong place.

### D2. Features switch commands on and off

The list is built from what is available: `/undo` when the core `undo` action is available, `/digest` when the digest is enabled, `/resume` when the stuck-session watcher runs. `/afk` and `/status` are always listed.

### D3. `/afk` is read-only in a chat

The away mode decides how approvals and pushes behave, so it is changed at the Mac only (existing rule in `watch-afk`). `/afk` in a chat shows the mode, who counts as away and the overnight state. Whether the phone may switch it after a second factor is an open question for the approvals change.

## Risks

A description over 256 characters or a name outside `[a-z0-9_]{1,32}` makes Telegram refuse the whole list. Mitigation: validate before the call.
