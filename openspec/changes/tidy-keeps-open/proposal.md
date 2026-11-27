## Why

`/topics` could close the topic of a session a TUI has open: its checks skipped the per-TUI heartbeat the automatic close uses.

## What Changes

- In the dry run and on apply, a topic is `keep` ("open in a TUI") while some TUI that is still reporting shows its session, even when the session is gone from the host's view or idle past the limit.

## Capabilities

### Modified Capabilities

- `topics`: tidying topics on request.

## Impact

- **Existing surface audit.** `src/bridge.ts` (`tidyTopics`).
