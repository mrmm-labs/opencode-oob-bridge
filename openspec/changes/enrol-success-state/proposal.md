## Why

Face ID enrolment worked on the bridge (device stored, token returned, `enrol_result outcome=ok`), and the phone stored the token, but the Mini App showed only a small hint under the still-active buttons. The person tapped Face ID again, which sent the spent code and got "Nothing to enrol". The log also named the single biometric call `step=begin`.

## What Changes

- **Success is a screen.** After a successful enrolment the Mini App replaces the form with "✅ This phone is set up for Face ID" (or "with a passkey"), the enrolled device id, a note that the code is used up, and a Done button. A success toast fires the success haptic.
- **A repeat tap is not an error.** After success `enroll` does nothing and sends nothing; the form is gone anyway. Opening the screen again starts clean.
- **The log is exact.** `enrol_result.step` is `begin` only for the first call of a passkey; Face ID is one call and is `done`.

## Capabilities

### Added Capabilities

- `mini-app`: an enrolment success state.

## Impact

- **Existing surface audit.** `miniapp/controller.js` (`enroll`), `miniapp/views.js` (`enroll`), `src/approvals/service.ts` (log field). The server flow is unchanged: Face ID is one request that stores the device and returns its token; a passkey is two requests.
