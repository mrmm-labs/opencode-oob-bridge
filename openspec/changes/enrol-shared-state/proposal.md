## Why

`/oob approvals enroll-biometric` showed a QR and a code, the phone scanned it in time, and the Mini App answered "Nothing to enrol: open it at the Mac first." The open enrolment lived in memory of one plugin instance, and the instance that served the phone's request was another one.

## What Changes

- **The open enrolment is shared.** It is kept in a file of the data directory (mode 0600), with its kind, expiry, tries, and the code salted and hashed. Every instance that shares the directory sees it, spends it, and counts tries on it. It is removed when spent, expired or out of tries.
- **Attempts are counted one at a time** inside an instance, so simultaneous wrong tries cannot exceed five.
- **The log says what happened.** `enrol_opened` (kind, instance) and `enrol_result` (kind, outcome, status, reason, instance, the instance that opened it, step). No code is logged.
- **The phone keeps a token only after the bridge confirms** (already so; now under test), and a retry overwrites it.

## Capabilities

### Added Capabilities

- `approvals`: enrolment is visible to every instance.

## Impact

- **Existing surface audit.** `src/approvals/service.ts` (`openEnrolment` is now async), `src/control.ts` (awaits it), `src/core/api.ts` (unchanged, calls `enrol`), `miniapp/controller.js` (unchanged).
