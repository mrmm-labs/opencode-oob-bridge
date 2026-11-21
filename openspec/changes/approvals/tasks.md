## 1. Spike

- [x] 1.1 From a server plugin, create, read and delete a Keychain item restricted to the host executable. Verify: recorded output of the three calls and of a read by another process being refused or prompting. If it fails, stop and report.

## 2. Service

- [x] 2.1 Unix socket with modes `0700` and `0600`, stale socket replacement, owner-only binding. Verify: tests for modes, a stale socket and a second process.
- [x] 2.2 Caller pairing and the HMAC check with a 60-second skew. Verify: tests for unknown caller, bad MAC, skew and replay.
- [x] 2.3 Classes, levels, deny by default, `needs_local`. Verify: fixtures per rule of document section 5.2.
- [x] 2.4 Presence: afk first on the phone, present refuses, switch to present withdraws pending. Verify: tests for each transition.
- [x] 2.5 Idempotency store, cooldown, rate limits. Verify: tests for key replay, a changed body, cooldown and the caps.

## 3. Phone

- [x] 3.1 Telegram Approve and Deny buttons, operator user id check, message content. Verify: tests with a second user pressing a button.
- [x] 3.2 TOTP enrolment (QR in the TUI only) and the L2 flow with one use per step. Verify: tests for RFC 6238 vectors, replay of a step and three wrong codes.
- [x] 3.3 Ed25519 signing and a caller-side verifier. Verify: fixtures for a good answer and each failing check of document section 7.2.
- [x] 3.4 Permission replies from the phone use the levels. Verify: tests per level and for Always.

## 4. Release

- [x] 4.1 README and `approvals` config, off by default. Verify: `config.test.ts` and `readme.test.ts`.
- [ ] 4.2 One L1 and one L2 approval on a real phone. Verify: the recorded exchange and the verified signature are attached to the release PR.
