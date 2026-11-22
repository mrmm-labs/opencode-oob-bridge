## 1. The stream

- [x] 1.1 Read with a reader, cancel every attempt, live on first bytes, back off from the first failure. Verify: a test with a body that has no async iterator reaches "live" and delivers events.
- [x] 1.2 Approvals and enrolment do not need the stream. Verify: a controller test.

## 2. Face ID

- [x] 2.1 Load Telegram's script, allow its origin, use the biometric manager, define all receive hooks for the fallback. Verify: tests with a fake manager, and with each hook name.
- [x] 2.2 Report `biometric_*` and `stream_*` lines to `POST /v1/log`. Verify: a core test for the route, its limit and its filter.

## 3. Refusals and the operator

- [x] 3.1 A reason in the body and an `edge_refused` line. Verify: edge tests for each reason.
- [x] 3.2 `channels.telegram.operator` and the menu button for a group. Verify: config and connector tests.
- [x] 3.3 The app shows a sentence for each reason. Verify: a view test.

## 4. The redesign

- [ ] 4.1 Titles, native-style list and detail, native controls, markdown (phase 2).
