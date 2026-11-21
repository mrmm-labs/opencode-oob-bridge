## 1. Stepper

- [x] 1.1 Model a form as fields with type, options and custom flag from the host's form shape. Verify: tests for single, multi, free text and mixed forms.
- [x] 1.2 Render and edit one message per form with Back, progress and paging. Verify: render tests for 3 fields and for 20 options.
- [x] 1.3 Review step and one reply on Submit. Verify: a test shows one relay call after Submit and none before.
- [x] 1.4 Refuse early with no window. Verify: a test with no attached TUI shows no buttons and the hint.

## 2. Permissions

- [x] 2.1 `permissions.remote` config (`off`, `once`, `all`). Verify: `config.test.ts`.
- [x] 2.2 Buttons and the host reply through `ctx.permission.reply`. Verify: tests for each mode, including that `off` shows no buttons.
- [x] 2.3 Final line and log with the answerer, channel and time. Verify: a test reads both.
- [x] 2.4 README (new behaviour and the security note). Verify: `readme.test.ts`.
