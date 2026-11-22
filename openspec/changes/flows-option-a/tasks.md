## 1. Telegram: one tap or the app, no stepper (PR 1)

- [ ] 1.1 `classify(questions)` returns one-tap or in-app. Verify: `src/classify.test.ts`.
- [ ] 1.2 In-app questions get one "📱 Answer in app" button; one-tap questions keep their option buttons. Verify: `src/forms.test.ts`.
- [ ] 1.3 `f_<id>` start parameter opens that question in the app. Verify: `miniapp/format.test.js`, `miniapp/controller.test.js`.
- [ ] 1.4 Remove the stepper and its callbacks; old `s:` taps get a toast. Verify: `src/forms.test.ts`.
- [ ] 1.5 "📱 Open" shares the style. Verify: `src/forms.test.ts`.

## 2. Withdrawn forms (PR 2)

- [ ] 2.1 A `withdrawn` pending state, set by reconcile when the form is not found. Verify: `src/chat-question.test.ts`.
- [ ] 2.2 The message reads "⚪ Withdrawn: the session stopped asking" and has no buttons. Verify: `src/chat-question.test.ts`.

## 3. Approvals in the app only (PR 3)

- [ ] 3.1 One "📱 Review & approve" button; `ap:` taps refused with a toast. Verify: `src/connectors/telegram-approvals.test.ts`.
- [ ] 3.2 Route to the private chat, else an "Approvals" topic, never General. Verify: `src/connectors/telegram-approvals.test.ts`.
- [ ] 3.3 The approval screen: who, what, level, expiry, note, Deny, Approve with Face ID and other factors. Verify: `miniapp/views.test.js`.

## 4. The question screen (PR 4)

- [ ] 4.1 One screen, grouped, recommended selected and tagged, Other row, Send answers. Verify: `miniapp/views.test.js`, `miniapp/form.test.js`.
- [ ] 4.2 Phone-side draft survives a reload. Verify: `miniapp/controller.test.js`.
- [ ] 4.3 After Send: haptic, close, "✅ Answered in app · …" masked. Verify: `src/chat-question.test.ts`, `miniapp/controller.test.js`.

## 5. Drain (PR 5)

- [ ] 5.1 `drain` in the control snapshot, `/oob version` and the core status. Verify: `src/control.test.ts`, `src/core/core.test.ts`.
