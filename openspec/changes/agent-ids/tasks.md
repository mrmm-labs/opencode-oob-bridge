## 1. Agent ids (one PR)

- [ ] 1.1 `Host.agents` returns `{ id, label }`; options, pickers and `/agent` use the id. Verify: `src/core/core.test.ts`, `src/commands.test.ts`, `miniapp/views.test.js`.
- [ ] 1.2 Create and switch accept an id or a label, and an unknown agent is refused before any session or topic. Verify: `src/core/actions.test.ts`.
- [ ] 1.3 A session failing within 60 s of creation is marked not started in its topic and in the app. Verify: `src/chat.test.ts`, `src/core/core.test.ts`.
- [ ] 1.4 `session_create` is logged by the action. Verify: `src/core/actions.test.ts`.
