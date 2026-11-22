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

## 4. The version, from the phone

- [x] 4.1 The Info screen ends with the bridge version and uptime. Verify: format tests, and a screenshot of the Info screen.
- [x] 4.2 `/version` in Telegram answers with versions and uptime, without a path, pid, instance id or address. Verify: tests of `chatLines` and of the chat answer.

## 5. A stale copy, and why Face ID is not available

- [x] 5.1 Stamp every file URL with the build; `no-store` for the page; immutable only for the current stamp; the build in the meta. Verify: core tests through the link and the direct port.
- [x] 5.2 Say which reason keeps Face ID from being used, and log it with the manager's state. Verify: factors and tg tests.
- [x] 5.3 The footer names the page's build, and an old copy is said. Verify: format tests.

## 6. The redesign

- [ ] 6.1 Titles, native-style list and detail, native controls, markdown (phase 2).
