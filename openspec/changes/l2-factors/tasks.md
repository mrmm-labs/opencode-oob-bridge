## 1. Spec and docs

- [x] 1.1 This change and `docs/approvals.md` (factors, enrolment, config, threat-model rows). Verify: `openspec validate --all --strict`.

## 2. Bridge

- [x] 2.1 `factors.ts`: names, config parse, biometric proof, passkey assertion, device store. Verify: unit tests for each accept and refuse case in the specs.
- [x] 2.2 Engine: ready factors per channel, challenge, proof, app and chat codes through one check, `factor` on the answer. Verify: engine tests including fallback order and three strikes.
- [x] 2.3 Signed string v2 with `factor`. Verify: sign tests, including a changed factor.
- [x] 2.4 Enrolment from the TUI, revoke, status. Verify: service tests with the in-memory key store.
- [x] 2.5 Core API routes behind init data only, and the Open button on the code prompt. Verify: API tests (bearer refused) and connector tests.

## 3. Mini App

- [x] 3.1 Biometric manager client over Telegram's events, ordering, proofs. Verify: unit tests with a fake event channel and a proof equal to the bridge's.
- [x] 3.2 Approval and enrolment views, controller flow. Verify: controller tests for order, "use another method", fallback to the code.

## 4. Release

- [ ] 4.1 Live Face ID check once the Mini App is hosted. Verify: a recorded approval on a phone. Unverified until then.
