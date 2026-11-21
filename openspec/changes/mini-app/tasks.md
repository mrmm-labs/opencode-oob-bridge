## 1. Bridge

- [ ] 1.1 Init data verification: HMAC, constant-time compare, user id, age. Verify: tests with fixtures for a valid, tampered, stale and wrong-user string.
- [ ] 1.2 Init-data-only for the relay link (from `relay-link`) and for `core.edgeProxies` (fallback), trusted `X-Forwarded-For`, failed-auth rate limit (10 a minute, 5-minute block). Verify: tests for a bearer token from a proxy source, and for the rate limit.
- [ ] 1.3 Serve `/app/` with the content security policy and `GET /healthz`. Verify: tests for headers and for the route list.

## 2. App

- [ ] 2.1 Shell, theme from launch parameters, sessions list and detail on the core API. Verify: logic unit tests and a phone screenshot in the PR.
- [ ] 2.2 Questions and forms (same stepper rules), permissions (gated), actions with confirmations. Verify: unit tests for each gate; one run on a phone.
- [ ] 2.3 SSE with reconnect, a stale banner, actions disabled when disconnected. Verify: a test drops the stream and sees the banner and disabled actions.
- [ ] 2.4 Overnight plan view and end, and the digest view. Verify: unit tests, and a phone check.

## 3. Launch

- [ ] 3.1 Menu button and `web_app` button in a private chat; `t.me` link button in group topics with the session id as `startapp`. Verify: connector tests for both, and a deep link opens the session on a phone.
- [ ] 3.2 BotFather app registration steps in the README. Verify: `readme.test.ts` passes.

## 4. Edge

- [ ] 4.1 `pnpm run edge:check <url>`, including: a bearer token is refused and `/admin` is 404. Verify: it passes against a local proxy in a test and against the real hostname once the operator has set up the hosting.
