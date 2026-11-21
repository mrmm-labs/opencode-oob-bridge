## Why

A message in a topic with no session (such as General) got a 🙈 reaction and nothing else. A person who does not look at the reaction cannot tell the message went nowhere.

## What Changes

- A prompt or media message in a topic no session owns also gets one line in that topic: "No session here; write in a session topic".
- `server_started` in `bridge.log` carries the plugin `version` it loaded, so a log shows which code a server runs.

## Capabilities

### Added Capabilities

- `chat`: the notice for a topic with no session.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (the two places that returned `ignored`), `src/server.ts`.
