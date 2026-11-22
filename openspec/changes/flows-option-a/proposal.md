## Why

Answering a form field by field in Telegram is fragile: the choices live in the bridge, a restart loses them, and a phone keyboard is a poor place to read long options. Approvals answered with an inline Approve button are a weak proof for a secret. The Mini App already answers forms and approvals with real controls and Face ID. Option A makes Telegram the place that tells the operator something is waiting and takes a one-tap yes/no, and makes the Mini App the place where anything bigger is answered.

## What Changes

- **Telegram is notify and one tap.** A question gets answer buttons only when it is one field, single-select, with at most four short options. Every other question gets one button, "📱 Answer in app", that opens that question (`startapp=f_<pending id>`). The multi-step stepper is removed.
- **Approvals are never answered in a chat.** The message has one button, "📱 Review & approve" (`a_<approval id>`). The approval screen in the app shows who asks, what, the level, the expiry and a note that the value never goes to Telegram or the AI, with Deny and "Approve with Face ID" (other L2 factors as `approvals.l2.factors` lists). Approval messages go to the operator's private chat, else to an "Approvals" topic made on demand, never to General.
- **One question screen in the app.** All questions on one screen, grouped, with recommended options selected and tagged, an "Other… type an answer" row where typing is allowed, and one main button, "Send answers". Nothing is sent before it. After Send: haptic, the app closes, and the message becomes "✅ Answered in app · <short answers>" with answers masked.
- **A restart loses nothing.** The phone keeps the choices until Send; the pending store keeps the question. When OpenCode drops a form nobody answered, reconcile marks it `withdrawn` and edits the message "⚪ Withdrawn: the session stopped asking", not `answered`.
- **A drain status.** A read-only count of open questions, approvals and permissions in `/oob version` and the status the core API serves, so a coordinator can wait before restarting.
- **Consistent buttons.** "📱 Open" (sessions), "📱 Answer in app" and "📱 Review & approve" share one style: one button on its own row, the same emoji.

Out of scope: ntfy actions, changing what a permission request needs (`permissions.remote` stays), a new approval factor, and an inbox screen listing everything open.

## Capabilities

### Added Capabilities

- `forms`: classification into one-tap or in-app, deep links, withdrawn forms.
- `approvals`: in-app only answers, routing to the DM or an Approvals topic.
- `mini-app`: the question screen, the approval screen, the post-send edit, the `f_` start parameter.
- `version`: the drain status.

### Removed Capabilities

- `forms`: the field-by-field stepper and its review step in Telegram.

## Impact

- **Existing surface audit.** `src/stepper.ts` and the stepper paths of `src/connectors/telegram.ts` and `telegram-render.ts` (removed); `src/connectors/telegram.ts` (`send`, `openButton`, `approvalRequest`, `onApprovalTap`); `src/bridge.ts` (`reconcile`, `settleStale`, `commit`, `markAnswered`); `src/pending.ts` (a `withdrawn` state); `src/control.ts` (`snapshot`); `src/core/api.ts` and `src/core/actions.ts` (status, form answer); `miniapp/format.js` (`parseStart`), `miniapp/controller.js`, `miniapp/views.js`, `miniapp/form.js`.
- Prototype of the target: the "A" mode of the approved mock.
