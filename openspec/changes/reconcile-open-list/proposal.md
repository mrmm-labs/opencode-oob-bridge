## Why

Two questions stayed `pending` for fifty minutes after OpenCode had dropped both forms (`session.form.list` returned nothing for their sessions). The user saw no question, and the drain count stayed at 2, which blocks a restart for nothing. The periodic check asked OpenCode about each form one by one and treated an answer it could not read as "no news", so a form it no longer knew about was never closed.

## What Changes

- **OpenCode's list of open forms and permission requests is the proof.** Every pending question and permission request is checked, every 60 seconds and at startup, against the list OpenCode holds for its session. One that is not listed is `withdrawn` (its message edited "⚪ Withdrawn: the session stopped asking", never deleted), unless OpenCode says it was answered or cancelled. A session OpenCode no longer has holds nothing open.
- **The drain counts only what OpenCode confirmed.** `open` and its parts count prompts OpenCode confirmed open within the last two checks, or asked less than ten seconds ago. A prompt OpenCode could not be asked about is counted in a new `unverified` field and not in `open`. `/oob version` asks OpenCode before it prints.
- **A `reconcile` log line** with the counts of each check.

## Capabilities

### Modified Capabilities

- `forms`: the check of pending prompts.
- `version`: what the drain counts.

## Impact

`src/bridge.ts` (`reconcile`, `drain`), `src/serviceclient.ts` (`open`), `src/server.ts`, `src/control.ts`, `src/rpc.ts`, `src/version.ts`.
