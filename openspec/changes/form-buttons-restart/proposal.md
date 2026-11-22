## Why

A two-question form was asked in Telegram, then the server restarted. Seven taps on its buttons did nothing: the choices of a form being answered field by field live in the connector's memory, so after a restart every tap got the "No longer active here" toast, which was not logged. The question stayed open and had to be answered in the Mini App.

## What Changes

- **Buttons survive a restart.** The bridge lets the connector look up a question that is still open. A tap on a form whose in-memory state is gone starts that form again from question 1 (or an empty tick list for a single question), tells the person "The bridge restarted: choose again", and applies nothing from the stale tap.
- **Taps are logged.** `form_select` (a choice, outcome ok, refused, restored or unknown), `form_submit` (Send or Done), `form_reply_ok` (fields answered) and `form_reply_failed` (reason `not-found`, `error` or `unreadable`). No answer text is logged.

## Capabilities

### Added Capabilities

- `forms`: buttons keep working after a restart, and every tap is logged.

## Impact

- **Existing surface audit.** `src/connectors/telegram.ts` (`onStep`, the single-question buttons, `forms`), `src/connectors/types.ts` (`forms` lookup), `src/bridge.ts` (provides the lookup, logs the reply).
