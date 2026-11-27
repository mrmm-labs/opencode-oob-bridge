## 1. Connector

- [x] 1.1 `topicEntries`, `forgetTopics` with a backup, `closeTopic` with the `tidy` reason. Verify: `topics-tidy.test.ts`.

## 2. Bridge and commands

- [x] 2.1 `tidyTopics`: classification, dry run, apply, cleanup. Verify: `topics-tidy.test.ts`.
- [x] 2.2 `/topics` and the menu, owner check for apply. Verify: `topics-tidy.test.ts`, `commandmenu.test.ts`.
- [x] 2.3 RPC op `topics`. Verify: `control.test.ts`.

## 3. Follow the session state

- [x] 3.1 Sessions open per TUI in the control; `onOpenSessions` hook. Verify: `control.test.ts`.
- [x] 3.2 `topicTick`: close after the settle, guards, switches. Verify: `topics-auto.test.ts`.
- [x] 3.3 Reopen on the user's message; reopen dwell. Verify: `topics-auto.test.ts`.
- [x] 3.4 `closeIdle` config. Verify: `config.test.ts`.

## 4. Docs

- [x] 4.1 README and example config.
