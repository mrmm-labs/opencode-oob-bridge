## Why

A question answered at the Mac while the plugin was restarting stayed `pending` in the bridge's store, because the answered event was missed. The store is reloaded from disk on every start, so the stale entry survived every restart. The session's plain messages were then held as "waiting on a question", and the question was posted again with buttons that could no longer work.

## What Changes

- **The bridge asks OpenCode.** When the plugin starts, and every 60 seconds, each question and permission the bridge waits on is checked with OpenCode. One OpenCode no longer holds is closed as `answered` (or `cancelled`) with `answeredBy: "unknown (reconciled)"`, its message is edited to "✅ Already answered at the Mac" with no buttons, and the permission digest counts it out.
- **Messages held behind it are sent.** A message kept while the session waited on that question is sent as a normal prompt, and the menu and the message's reaction show it.
- **Nothing is re-posted or held blindly.** Before a message is held behind a question, and before "Answer" posts it again, OpenCode is asked. "Answer" on a question that is gone sends the kept message.
- **A form reply that finds the form gone closes it** instead of failing, and is not relayed through a window.
- A prompt younger than 10 seconds is not judged, and an answer that cannot be read (OpenCode unreachable, any other error) changes nothing.

## Capabilities

### Added Capabilities

- `forms`: reconciliation with OpenCode.

## Impact

- **Existing surface audit.** `src/bridge.ts` (`reconcile`, the hold check, `repostQuestion`, the reply failure path), `src/serviceclient.ts` (`state`), `src/server.ts`, `src/commands.ts`, `src/connectors/telegram.ts` and its render, `src/pending.ts`.
