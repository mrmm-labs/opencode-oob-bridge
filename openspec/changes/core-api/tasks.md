## 1. Core

- [ ] 1.1 Create `src/core/views.ts` with the summary and detail view-models and the source ladder. Verify: a unit test per source, including `unavailable` with a reason.
- [ ] 1.2 Create `src/core/actions.ts` with the registry and move the Telegram command handlers onto it. Verify: `commands.test.ts` and `chat.test.ts` pass unchanged.
- [ ] 1.3 Serve the TUI RPC ops through the registry. Verify: `control.test.ts` and `server.test.ts` pass unchanged, and a test fails if an adapter calls the host by another route.

## 2. HTTP and SSE

- [ ] 2.1 Implement `src/core/api.ts` routes with node:http, no new dependency. Verify: route tests for status codes, paging and `/v1/meta`.
- [ ] 2.2 Implement bearer authentication, token creation and rotation. Verify: tests for a missing, wrong and rotated token, and a constant-time comparison helper.
- [ ] 2.3 Implement the bind rules. Verify: tests refuse `0.0.0.0`, `::` and a public address, and accept loopback and a tailnet address.
- [ ] 2.4 Implement SSE with ring, resume and keep-alive. Verify: a test reconnects with `Last-Event-ID` and gets the missed events, and one with an old id gets a snapshot.

## 3. Policy

- [ ] 3.1 Apply `redact`, the secret filter and `chat.deny` to every view-model. Verify: a test with a secret in a message and a denied directory.
- [ ] 3.2 Refuse permission replies and `Always` in the core until a policy allows them. Verify: an action test returns the refusal reason.

## 4. Release

- [ ] 4.1 Update README (API, `core.bind`, token rotation). Verify: `readme.test.ts` passes.
- [ ] 4.2 Run against a real `opencode serve` in an isolated home over a loopback address. Verify: the recorded `curl` output shows 200 with the token and 401 without.
