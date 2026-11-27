## Why

Pinning a topic is not possible for a bot, and a person looking at the topic list cannot tell which sessions are open at the Mac. Subagent cards also have no way to be turned off.

## What Changes

- **A 🟢 on the name of a topic whose session is open in a TUI.** The bridge renames the topic with `editForumTopic` to `🟢 <name>` while some TUI shows the session, and back when none does. The stored name stays without the mark. `topics.markOpen` (default `true`) turns it off; off also takes the mark off topics that have it.
- **Paced.** At most one rename of a topic per 60 s, shared with the rename that follows a session's title. A change of the open set is looked at every 10 s, not on each heartbeat. The mark is never added to a name that has it.
- **`cards.enabled` (default `true`)** turns the subagent cards off: no card is posted, and a subagent's prompts post as before.

## Capabilities

### Modified Capabilities

- `topics`: the open mark.
- `subagent-cards`: the switch.

## Out of scope

Pinning, a different mark, marks on shared topics, a setting for the 60 s.

## Impact

- **Existing surface audit.** `src/bridge.ts` (`topicTick` passes the open set, `subTouch` reads the switch), `src/connectors/telegram.ts` and `types.ts` (`markOpen`, rename pacing, `topics.markOpen`), `src/config.ts` (`cards`), README, example config.
