## Why

Local tools sometimes need the operator's consent before they do something that matters, and the operator is often away from the machine. `docs/approvals.md` (PR #36) specifies a small approval service in the bridge: a tool asks, the operator answers on the phone, and the tool gets a signed answer. This change turns that document into requirements and builds it.

## What Changes

- A local endpoint on a unix socket (never TCP) where a registered tool creates an approval request and waits for a signed answer.
- **Levels.** L1 is a tap. L2 is a tap plus a one-time code (TOTP). L3 is the machine only and is refused with `needs_local`.
- **AFK-aware order.** Away: the phone first. Present: the machine first, and the phone refuses.
- **Key custody.** The answer is signed with Ed25519; the signing key and the TOTP seed live in the macOS Keychain, reached through the Security framework from the host process. Never in a file.
- Phone permission replies (`forms`) use the same levels once approvals are on.

## Capabilities

### New Capabilities

- `approvals`: the endpoint, callers, classes, levels, presence, signing, key custody and limits.

### Modified Capabilities

None.

## Out of scope

A standalone daemon that owns the bot independently of the OpenCode server, mirroring MCP elicitation forms to the phone, Signal, the command line resolver for a task runner (rollout step 2 of the doc), changing the away mode from a chat (see the design), non-macOS key storage.

## Impact

- **Existing surface audit.** `docs/approvals.md`, `src/server.ts` (owner election and boot), `src/control.ts` (away mode, `present` withdrawal), `src/settings.ts`, `src/token.ts`, `src/connectors/telegram.ts` (buttons, typed replies), `src/filter.ts`, `forms` (permission buttons).
- **Supersession.** The "Tier 2 is not implemented" limitation in the README.
- **Downstream.** `forms`' permission gate is refined by the levels; the Mini App shows approvals.
- **Estimate.** Agent 2 days after the spike, which decides whether the rest can start. Operator 30 minutes (TOTP enrolment, Keychain prompts).
- **Definition of done.** `pnpm test` ends `fail 0` with fixtures for replay, cooldown, wrong user id, expiry and idempotency mismatch, and a recorded L1 and L2 approval on a real phone with the signature verified by a caller.
