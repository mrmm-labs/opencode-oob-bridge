## 1. Menu

- [ ] 1.1 Build the list from the available features, in the fixed order. Verify: a test per feature switch, and one for the order.
- [ ] 1.2 Validate names and descriptions before `setMyCommands` and store a hash of the registered list. Verify: tests for a bad name, a long description and a second start that makes no call.
- [ ] 1.3 Register for `BotCommandScopeChat` of the paired chat, or all private chats. Verify: `fake-telegram` records the scope.

## 2. New commands

- [ ] 2.1 `/undo` with a confirm step through the core `undo` action. Verify: tests for confirm, cancel and "needs the Mac" when no TUI is attached.
- [ ] 2.2 `/resume` in a topic, and a button list of stuck sessions in General. Verify: tests for both places.
- [ ] 2.3 `/afk` read-only status. Verify: a test shows the mode and the hint to change it at the Mac, and no setting changes.
- [ ] 2.4 `/digest` shows "not enabled" until the digest exists. Verify: a test with the digest off.
- [ ] 2.5 Update README commands tables. Verify: `readme.test.ts` passes.
