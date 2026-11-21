## Decisions

### D1. The stepper keeps one message

The stepper edits one message per form: field title, description, options as buttons, `Back`, `✏️` when the field allows free text, and `n/N`. The person's choices are kept in the bridge until Submit. Nothing reaches the host before Submit, so an abandoned stepper changes nothing.

### D2. Review before submit

After the last field a review lists every answer with Submit, Edit (back to field 1) and Cancel. This guards against a mis-tap on a phone. Submit sends one form reply, through a TUI relay as today. The first answer still wins, from the phone or the TUI.

### D3. Refuse early without a window

The reply needs an attached TUI (the server API has no form reply). Without one the card says "answer at the Mac" and shows no buttons, so nobody fills in a form that cannot be sent.

### D4. Permissions

`permissions.remote` is `off` (default: today's behaviour), `once` (Allow once and Deny) or `all` (adds Always). Always writes a saved rule, so it needs `all`. The reply uses `ctx.permission.reply`. The message ends with who answered, from which channel and when, and the log records the same. Deny is the safe direction, but this change does not show it when the policy is `off`: with the policy off the message has no buttons at all.

### D5. Paging

Eight options to a page with Prev and Next. The multi-select state survives paging.

## Risks

Allowing permissions from a phone widens what a hijacked Telegram account can do. Mitigation: off by default, per-mode scope, the log, and the approvals change adds levels and a one-time code.
