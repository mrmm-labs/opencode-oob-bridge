## Why

A session with a subagent that asks for `shell` again and again filled a topic with dozens of permission messages. A permission cannot be answered from a chat unless `permissions.remote` is set, so each message was noise: nothing to do but wait for the Mac.

## What Changes

- **New `permissions.notify`:** `digest` (default), `all` or `off`.
- **`digest`:** one message per root session, edited in place, with the count and a breakdown by agent and action. The count drops as permissions are answered or cancelled; at zero the message says "✅ none waiting". Edits are at most one every 10 seconds. Quiet hours apply.
- **`off`:** no permission message; `/oob status` still lists what waits.
- **`all`:** one message each, as before.
- A permission that a chat can answer (`permissions.remote` is `once` or `all`) is always posted with its buttons, whatever `notify` says.

## Capabilities

### Added Capabilities

- `approvals`: how unanswerable permissions are announced.

## Impact

- **Existing surface audit.** `src/config.ts`, `src/bridge.ts` (`onPermission`, the digest, `status`), `src/permdigest.ts` (new), `src/pending.ts` (`agent`), the status snapshot (`control.ts`, `remote.ts`, `rpc.ts`, `view.ts`), `src/menu.ts` (`/oob status`).
- **Behaviour change by default.** A chat with `permissions.remote` off no longer gets one message per permission. ntfy still gets each one.
