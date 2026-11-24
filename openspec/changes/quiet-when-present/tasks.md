## 1. Presence

- [x] 1.1 `on` routes only when away; phone input counts as away. Verify: `routing.test.ts`.
- [x] 1.2 New and chat-started sessions stay `auto`; children follow the root. Verify: `chat.test.ts`.
- [x] 1.3 `route` with `root: "all"` and `/auto`. Verify: `control` and `commands.test.ts`.

- [x] 1.4 Rules engine: phone, grace, idle, lock, sleep, schedule, forced modes with a time-box, per-session tighten. Verify: `routing.test.ts`, `config.test.ts`.
- [x] 1.5 State and why in the snapshot and one chat line. Verify: `quiet-present.test.ts`.

## 2. Quiet and digest

- [x] 2.1 Connector muted while present, hushed on return. Verify: `telegram-quiet.test.ts`.
- [x] 2.2 One digest per topic when going away. Verify: `quiet-present.test.ts`.

## 3. Budget

- [x] 3.1 Budget, coalescing, 429. Verify: `telegram-budget.test.ts`.
- [x] 3.2 `rate` options and telemetry in the snapshot. Verify: `config.test.ts`, `quiet-present.test.ts`.

## 4. Docs

- [x] 4.1 README settings and commands, example config. Verify: `readme.test.ts`.
