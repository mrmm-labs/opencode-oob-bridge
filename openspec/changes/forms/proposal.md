## Why

A question with one field already has buttons in Telegram. A host **form** with several fields gets none: the person must reply with answers joined by `|`. A permission prompt cannot be answered from the phone at all, so a session that asks for one stops until the person reaches the Mac. The operator wants forms to feel native, and permissions answerable (Allow once, Always, Deny) when he chooses to allow it.

## What Changes

- A multi-field form is shown **one field at a time** with buttons, a Back button and progress, then a review step, then one reply.
- Single-select, multi-select (toggles and Done) and free text (by reply) work per field. More than eight options are paged.
- Permissions get Allow once, Always and Deny buttons **only when** `permissions.remote` allows it (default off, as today).
- A permission is answered through the host's permission reply, which the server plugin has, so no TUI is needed for it.

## Capabilities

### New Capabilities

- `forms`: the stepper, the review step, paging, and the permission buttons with their gate.

### Modified Capabilities

- `chat`: "Permissions are never answered from a channel" becomes "never, unless `permissions.remote` allows".
- `watch-afk`: a permission is pushed as a notice, with buttons only when allowed.

## Out of scope

Approval levels and the TOTP step (the `approvals` change refines the gate), forms the host creates for other purposes than questions, editing an answer after it is submitted, voice answers.

## Impact

- **Existing surface audit.** `src/connectors/telegram-render.ts` and `telegram.ts` (question cards, toggles, ✏️), `src/inbound.ts` (`|` grammar), `src/remote.ts` and `src/server.ts` (form relay to a TUI), `ctx.permission.reply` (server), the core actions.
- **Supersession.** The "no buttons for several questions" rule of the Telegram README section.
- **Downstream.** `approvals` maps permission classes to levels on top of `permissions.remote`. `mini-app` shows the same forms.
- **Estimate.** Agent 1.5 days. Operator 10 minutes (decide the policy).
- **Definition of done.** `pnpm test` ends `fail 0`, and a recorded Telegram run answers a three-field form with the stepper and Submit, and a permission with Allow once while `permissions.remote` is `once`.
