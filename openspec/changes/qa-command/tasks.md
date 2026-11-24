## 1. /qa and the QA button (one PR)

- [x] 1.1 `/qa [topic]` is a session command with the delivery and the reply of `/steer`. Verify: `src/commands.test.ts`.
- [x] 1.2 It is in the registered list and the help of both scopes. Verify: `src/commands.test.ts`.
- [x] 1.3 The turn card has QA and Update buttons when chat is on, and a tap sends the instruction once. Verify: `src/turncard.test.ts`.
- [x] 1.4 `/update [topic]` is a session command like `/qa`. Verify: `src/commands.test.ts`.
- [x] 1.5 The status card has QA and Update buttons while chat is on. Verify: `src/chat.test.ts`.
- [x] 1.6 The app's session screen has QA and Update actions on the action endpoint. Verify: `miniapp/views.qa.test.js`, `src/core/core.test.ts`.
